import {
  AUTOMATION_PRESETS,
  type AutomationPreset,
} from '../test-management/automation/automation-inputs';
import { presetRun, RUNNER_PRESETS } from './presets';

describe('runner presets', () => {
  it('has an entry for every preset a setting can choose', () => {
    expect(Object.keys(RUNNER_PRESETS).sort()).toEqual(
      [...AUTOMATION_PRESETS, 'node-test'].sort(),
    );
  });

  it('never builds a command for an auto setting, which runs with its detected preset', () => {
    expect(() => presetRun('auto', null, ['r.xml'])).toThrow(
      'An auto setting runs with its detected preset',
    );
  });

  it.each<AutomationPreset>(['playwright', 'pytest', 'maven'])(
    '%s never pastes a result path into its command',
    (preset) => {
      const path = 'results;rm -rf $(whoami).xml';
      const run = presetRun(preset, null, [path]);

      expect(run.command).not.toContain(path);
      expect(run.env.XISUITE_RESULT).toBe(path);
    },
  );

  it.each<AutomationPreset>(['playwright', 'pytest', 'maven'])(
    '%s keeps the result paths of the setting',
    (preset) => {
      expect(presetRun(preset, null, ['r.xml']).resultPaths).toBeUndefined();
    },
  );

  it('Cypress writes one results file per spec, without using the path of the setting', () => {
    const path = 'results;rm -rf $(whoami).xml';
    const run = presetRun('cypress', null, [path]);

    expect(run.command).not.toContain(path);
    expect(run.env.XISUITE_RESULT).toBe('.xisuite-results/cypress-[hash].xml');
    expect(run.resultPaths).toEqual(['.xisuite-results/cypress-*.xml']);
  });

  it('Cypress with its own test command keeps the path of the setting', () => {
    const run = presetRun('cypress', 'npx cypress run', ['r.xml']);

    expect(run.env.XISUITE_RESULT).toBe('r.xml');
    expect(run.resultPaths).toBeUndefined();
  });

  it('installs first, and the test result decides the exit code', () => {
    const run = presetRun('playwright', null, ['results.xml']);

    expect(run.command).toBe(
      'if [ -f package-lock.json ]; then npm ci; else npm install; fi && npx playwright test --reporter=list,junit,/work/.xisuite-progress.cjs',
    );
  });

  it('can print a marker between the install and the tests', () => {
    const run = presetRun('playwright', null, ['results.xml'], false, true);

    expect(run.command).toBe(
      "if [ -f package-lock.json ]; then npm ci; else npm install; fi && printf '%s\\n' XISUITE_TESTS_START && npx playwright test --reporter=list,junit,/work/.xisuite-progress.cjs",
    );
  });

  it('prints no marker without an install step', () => {
    expect(presetRun('maven', null, ['r.xml'], false, true).command).toBe(
      'mvn -B -Dmaven.repo.local=/tmp/m2 test',
    );
  });

  it('gives Playwright the reporter that names each test as it starts', () => {
    const { reporter } = presetRun('playwright', null, ['r.xml']);

    expect(reporter?.file).toBe('.xisuite-progress.cjs');
    expect(reporter?.source).toContain('onTestBegin');
    expect(presetRun('pytest', null, ['r.xml']).reporter).toBeUndefined();
  });

  it('gives Playwright its output file through its own variable', () => {
    expect(presetRun('playwright', null, ['out/r.xml']).env).toEqual({
      XISUITE_RESULT: 'out/r.xml',
      PLAYWRIGHT_JUNIT_OUTPUT_NAME: 'out/r.xml',
      DEBUG: 'pw:api',
    });
  });

  it('points pytest and Cypress at the variable', () => {
    expect(presetRun('pytest', null, ['r.xml']).command).toContain(
      '--junitxml="$XISUITE_RESULT"',
    );
    expect(presetRun('cypress', null, ['r.xml']).command).toContain(
      '"mochaFile=$XISUITE_RESULT"',
    );
  });

  it('keeps the Maven repository in the writable folder', () => {
    const run = presetRun('maven', null, ['target/surefire-reports/*.xml']);

    expect(run.command).toBe('mvn -B -Dmaven.repo.local=/tmp/m2 test');
  });

  it.each<[AutomationPreset, string[]]>([
    ['playwright', ['registry.npmjs.org']],
    ['pytest', ['pypi.org', 'files.pythonhosted.org']],
    ['maven', ['repo.maven.apache.org', 'repo1.maven.org']],
    ['cypress', ['registry.npmjs.org']],
  ])('%s names only the package hosts it needs', (preset, hosts) => {
    expect(presetRun(preset, null, ['r.xml']).hosts).toEqual(hosts);
  });

  describe('custom', () => {
    it('runs the command of the setting and opens no extra hosts', () => {
      expect(presetRun('custom', 'make test', ['r.xml'])).toEqual({
        command: 'make test',
        env: { XISUITE_RESULT: 'r.xml' },
        hosts: [],
      });
    });

    it('refuses to run without a command', () => {
      expect(() => presetRun('custom', null, ['r.xml'])).toThrow();
    });
  });

  it('runs a stored command instead of the default on other presets', () => {
    expect(presetRun('maven', 'mvn verify', ['r.xml']).command).toBe(
      '(\nmvn verify\n)',
    );
  });

  describe('own commands', () => {
    const NPM =
      'if [ -f package-lock.json ]; then npm ci; else npm install; fi';

    it.each<[AutomationPreset, string]>([
      [
        'playwright',
        `${NPM} && npx playwright test --reporter=list,junit,/work/.xisuite-progress.cjs`,
      ],
      [
        'pytest',
        'if [ -f requirements.txt ]; then python -m pip install --user -r requirements.txt; fi && python -m pytest -v --junitxml="$XISUITE_RESULT"',
      ],
      ['maven', 'mvn -B -Dmaven.repo.local=/tmp/m2 test'],
      [
        'cypress',
        `${NPM} && npx cypress run --reporter junit --reporter-options "mochaFile=$XISUITE_RESULT"`,
      ],
    ])('%s keeps its exact default when commands are blank', (preset, text) => {
      for (const blank of [null, undefined, '', '  \n ']) {
        const run = presetRun(preset, blank ?? null, ['r.xml'], false, false, {
          installCommand: blank,
          specFiles: [],
        });

        expect(run.command).toBe(text);
        expect(run.args).toBeUndefined();
        expect(run.env).not.toHaveProperty('XISUITE_SPEC_FILES');
      }
    });

    it('puts each override on its own lines in a subshell', () => {
      const run = presetRun(
        'pytest',
        'pytest -q # all',
        ['r.xml'],
        false,
        true,
        {
          installCommand: 'pip install . ;',
        },
      );

      expect(run.command).toBe(
        "(\npip install . ;\n) && printf '%s\\n' XISUITE_TESTS_START && (\npytest -q # all\n)",
      );
    });

    it('prints the marker once between an overridden install and the default tests', () => {
      const { command } = presetRun(
        'playwright',
        null,
        ['r.xml'],
        false,
        true,
        {
          installCommand: 'npm i',
        },
      );

      expect(command).toBe(
        "(\nnpm i\n) && printf '%s\\n' XISUITE_TESTS_START && npx playwright test --reporter=list,junit,/work/.xisuite-progress.cjs",
      );
    });

    it('gives Maven an install step it has none of by default', () => {
      expect(
        presetRun('maven', null, ['r.xml'], false, true, {
          installCommand: 'make deps',
        }).command,
      ).toBe(
        "(\nmake deps\n) && printf '%s\\n' XISUITE_TESTS_START && mvn -B -Dmaven.repo.local=/tmp/m2 test",
      );
    });

    it('adds the trace flag to the default command only', () => {
      const traced = presetRun('playwright', null, ['r.xml'], true);
      const own = presetRun(
        'playwright',
        'npx playwright test',
        ['r.xml'],
        true,
      );

      expect(traced.command).toContain('--trace retain-on-failure');
      expect(traced.tracePath).toBeDefined();
      expect(own.command).not.toContain('--trace');
      expect(own.tracePath).toBeUndefined();
    });

    it('keeps a custom command as written without an install, and wraps it with one', () => {
      expect(presetRun('custom', 'make test', ['r.xml']).command).toBe(
        'make test',
      );
      expect(
        presetRun('custom', 'make test', ['r.xml'], false, true, {
          installCommand: 'make deps',
        }).command,
      ).toBe(
        "(\nmake deps\n) && printf '%s\\n' XISUITE_TESTS_START && (\nmake test\n)",
      );
    });

    it('keeps the variables a framework needs under an override', () => {
      const run = presetRun('playwright', 'npx playwright test', ['out/r.xml']);

      expect(run.env).toEqual({
        XISUITE_RESULT: 'out/r.xml',
        PLAYWRIGHT_JUNIT_OUTPUT_NAME: 'out/r.xml',
        DEBUG: 'pw:api',
      });
    });
  });

  describe('Node.js frameworks', () => {
    it.each<AutomationPreset>(['jest', 'vitest', 'mocha'])(
      '%s installs from npm and never pastes a result path into its command',
      (preset) => {
        const path = 'results;rm -rf $(whoami).xml';
        const run = presetRun(preset, null, [path]);

        expect(run.command).toMatch(/^if \[ -f package-lock.json \]/);
        expect(run.command).not.toContain(path);
        expect(run.env.XISUITE_RESULT).toBe(path);
        expect(run.hosts).toEqual(['registry.npmjs.org']);
        expect(run.resultPaths).toBeUndefined();
      },
    );

    it('gives Jest its output file through its own variable', () => {
      const run = presetRun('jest', null, ['out/jest.xml']);

      expect(run.command).toContain(
        '--reporters=/usr/local/lib/node_modules/jest-junit',
      );
      expect(run.env.JEST_JUNIT_OUTPUT_FILE).toBe('out/jest.xml');
    });

    it('points Vitest and Mocha at the variable', () => {
      expect(presetRun('vitest', null, ['r.xml']).command).toContain(
        '--outputFile.junit="$XISUITE_RESULT"',
      );
      expect(presetRun('mocha', null, ['r.xml']).command).toContain(
        '"output=$XISUITE_RESULT"',
      );
    });

    it('runs Mocha with its own xunit reporter, in a folder it creates first', () => {
      const run = presetRun('mocha', null, ['.xisuite-results/results.xml']);

      expect(
        run.command.endsWith(
          ' && mkdir -p "$(dirname "$XISUITE_RESULT")" && npx mocha --reporter xunit --reporter-options "output=$XISUITE_RESULT"',
        ),
      ).toBe(true);
      expect(run.command).not.toContain('mocha-junit-reporter');
      expect(run.env.XISUITE_RESULT).toBe('.xisuite-results/results.xml');
      expect(run.hosts).toEqual(['registry.npmjs.org']);
    });

    it('passes chosen Mocha files after the reporter', () => {
      const run = presetRun('mocha', null, ['r.xml'], false, false, {
        specFiles: ['test/a.spec.js'],
      });

      expect(run.command.endsWith('"output=$XISUITE_RESULT" "$@"')).toBe(true);
      expect(run.args).toEqual(['test/a.spec.js']);
    });

    describe('Node.js test runner', () => {
      const NODE_TEST =
        'mkdir -p "$(dirname "$XISUITE_RESULT")" && node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination="$XISUITE_RESULT"';

      it('installs nothing and opens no hosts', () => {
        const run = presetRun('node-test', null, ['r.xml'], false, true);

        expect(RUNNER_PRESETS['node-test'].install).toBeNull();
        expect(run.hosts).toEqual([]);
        expect(run.command).not.toContain('XISUITE_TESTS_START');
        expect(run.command).not.toContain('npm');
      });

      it('runs every test file when none are chosen', () => {
        const run = presetRun('node-test', null, ['r.xml']);

        expect(run.command).toBe(
          `${NODE_TEST} "**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}"`,
        );
        expect(run.args).toBeUndefined();
        expect(run.env.XISUITE_RESULT).toBe('r.xml');
      });

      it('runs only the chosen files, as arguments', () => {
        const run = presetRun('node-test', null, ['r.xml'], false, false, {
          specFiles: ['src/a.test.ts', 'b.spec.mjs'],
        });

        expect(run.command).toBe(`${NODE_TEST} "$@"`);
        expect(run.command).not.toContain('**/');
        expect(run.args).toEqual(['src/a.test.ts', 'b.spec.mjs']);
      });

      it('runs a stored command instead, with no glob', () => {
        expect(presetRun('node-test', 'make test', ['r.xml']).command).toBe(
          '(\nmake test\n)',
        );
      });

      it('gives other presets no file glob', () => {
        for (const preset of ['jest', 'vitest', 'mocha'] as const) {
          expect(presetRun(preset, null, ['r.xml']).command).not.toContain(
            '**/',
          );
        }
      });
    });

    it('gives Jest exact paths as arguments', () => {
      const run = presetRun('jest', null, ['r.xml'], false, false, {
        specFiles: ['src/a.test.ts'],
      });

      expect(run.command.endsWith(' --runTestsByPath "$@"')).toBe(true);
      expect(run.command).not.toContain('a.test.ts');
      expect(run.args).toEqual(['src/a.test.ts']);
    });

    it('gives Vitest full paths, so a.test.ts never also runs data.test.ts', () => {
      const run = presetRun('vitest', null, ['r.xml'], false, false, {
        specFiles: ['a.test.ts'],
        workDir: './app/',
      });

      expect(run.args).toEqual(['/work/app/a.test.ts']);
    });

    it('adds no file arguments when none are chosen', () => {
      for (const preset of ['jest', 'vitest', 'mocha'] as const) {
        const run = presetRun(preset, null, ['r.xml']);

        expect(run.args).toBeUndefined();
        expect(run.command).not.toContain('"$@"');
      }
    });
  });

  describe('selected files', () => {
    const choose = (
      preset: AutomationPreset,
      specFiles: string[],
      workDir: string | null = null,
      stored: string | null = null,
    ) =>
      presetRun(preset, stored, ['r.xml'], false, true, { specFiles, workDir });

    it('gives pytest arguments, never shell text', () => {
      const run = choose('pytest', ['tests/test_a.py', 'test_b.py']);

      expect(run.command.endsWith('"$@"')).toBe(true);
      expect(run.command).not.toContain('test_a.py');
      expect(run.args).toEqual(['tests/test_a.py', 'test_b.py']);
    });

    it('gives Playwright exact patterns, so a.spec.js never also runs data.spec.js', () => {
      const run = choose('playwright', ['a.spec.js', 'sub/b-c_d.test.ts']);

      expect(run.command.endsWith('"$@"')).toBe(true);
      expect(run.args).toEqual([
        '^/work/a\\.spec\\.js$',
        '^/work/sub/b-c_d\\.test\\.ts$',
      ]);
      expect(
        new RegExp(run.args?.[0] ?? '', 'i').test('/work/data.spec.js'),
      ).toBe(false);
    });

    it.each(['e2e', './e2e/', 'e2e//'])(
      'starts Playwright patterns from the tests folder %s',
      (workDir) => {
        expect(choose('playwright', ['a.spec.js'], workDir).args).toEqual([
          '^/work/e2e/a\\.spec\\.js$',
        ]);
      },
    );

    it('puts the trace flag before the files', () => {
      const run = presetRun('playwright', null, ['r.xml'], true, false, {
        specFiles: ['a.spec.js'],
      });

      expect(run.command).toContain('--trace retain-on-failure "$@"');
    });

    it('gives Cypress a variable and adds its flag only when selected', () => {
      const run = choose('cypress', ['a.cy.js', 'b.cy.js']);

      expect(run.command).toContain('--spec "$XISUITE_SPEC_CSV"');
      expect(run.env.XISUITE_SPEC_CSV).toBe('a.cy.js,b.cy.js');
      expect(run.args).toBeUndefined();
      expect(presetRun('cypress', null, ['r.xml']).command).not.toContain(
        '--spec',
      );
    });

    it('gives Maven class names and adds its flags only when selected', () => {
      const run = choose('maven', [
        'src/test/java/qa/LoginTest.java',
        'src/test/kotlin/qa/CartTest.kt',
        'other/LoginTest.java',
      ]);

      expect(run.command).toBe(
        'mvn -B -Dmaven.repo.local=/tmp/m2 test -Dtest="$XISUITE_MAVEN_TESTS" -Dsurefire.failIfNoSpecifiedTests=false',
      );
      expect(run.env.XISUITE_MAVEN_TESTS).toBe('LoginTest,CartTest');
    });

    it("gives the class names of Surefire's other default patterns", () => {
      const run = choose('maven', [
        'src/test/java/TestCart.java',
        'src/test/java/OrderTests.kt',
        'src/test/java/PaymentTestCase.java',
      ]);

      expect(run.env.XISUITE_MAVEN_TESTS).toBe(
        'TestCart,OrderTests,PaymentTestCase',
      );
    });

    it('keeps the setting result paths for a Maven setting', () => {
      expect(
        presetRun('maven', null, ['target/surefire-reports/*.xml']).resultPaths,
      ).toBeUndefined();
    });

    it.each<[AutomationPreset, string]>([
      ['custom', 'make test'],
      ['pytest', 'make test'],
      ['playwright', 'make test'],
    ])(
      '%s with its own command gets the variable and nothing added',
      (preset, stored) => {
        const run = choose(preset, ['a.txt', 'b.txt'], null, stored);

        expect(run.env.XISUITE_SPEC_FILES).toBe('a.txt,b.txt');
        expect(run.args).toBeUndefined();
        expect(run.command).not.toContain('$@');
        expect(run.command).not.toContain('a.txt');
      },
    );

    it('keeps the files on the test step, after the marker', () => {
      const { command } = presetRun('pytest', null, ['r.xml'], false, true, {
        installCommand: 'pip install .',
        specFiles: ['test_a.py'],
      });

      expect(command.indexOf('"$@"')).toBeGreaterThan(
        command.indexOf('XISUITE_TESTS_START'),
      );
      expect(command.split('"$@"')).toHaveLength(2);
    });
  });
});
