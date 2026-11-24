import { BadRequestException } from '@nestjs/common';

import { assertPublicHttpUrl } from '../../../common/security/ssrf-guard';
import {
  AUTOMATION_LIMITS,
  AUTOMATION_PRESETS,
  availableRunnerImages,
  checkEnv,
  checkFilePath,
  checkHosts,
  checkRelativePath,
  checkRepoRef,
  checkRepoUrl,
  checkSpecFiles,
  cleanProjectPath,
  isBuiltInRunnerImage,
  runnerEnabled,
  runnerImages,
  runnerRuntime,
  specFilesIn,
} from '../automation-inputs';

jest.mock('../../../common/security/ssrf-guard', () => ({
  assertPublicHttpUrl: jest.fn(),
}));

const publicCheck = assertPublicHttpUrl as jest.Mock;

function responseOf(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(BadRequestException);

  return (error as BadRequestException).getResponse() as Record<
    string,
    unknown
  >;
}

function fieldOfThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return responseOf(error).field;
  }

  throw new Error('Expected the call to refuse the value');
}

async function fieldOfRejected(run: Promise<unknown>): Promise<unknown> {
  const error: unknown = await run.then(
    () => {
      throw new Error('Expected the call to refuse the value');
    },
    (reason: unknown) => reason,
  );

  return responseOf(error).field;
}

describe('automation inputs for the runner', () => {
  beforeEach(() => {
    publicCheck.mockReset();
    publicCheck.mockResolvedValue(undefined);
  });

  describe('checkRepoUrl', () => {
    it('accepts a URL the public host check passes', async () => {
      await expect(checkRepoUrl('https://git.example.com/a.git')).resolves.toBe(
        'https://git.example.com/a.git',
      );
    });

    it('refuses a URL the public host check refuses', async () => {
      publicCheck.mockRejectedValue(new Error('private'));

      await expect(
        fieldOfRejected(checkRepoUrl('https://10.0.0.1/a.git')),
      ).resolves.toBe('repo_url');
    });

    it('refuses a URL that is too long before any lookup', async () => {
      const long = `https://a.example.com/${'a'.repeat(AUTOMATION_LIMITS.repoUrl)}`;

      await expect(fieldOfRejected(checkRepoUrl(long))).resolves.toBe(
        'repo_url',
      );
      expect(publicCheck).not.toHaveBeenCalled();
    });
  });

  describe('checkRepoRef', () => {
    it('reports a CI field unless the runner names its own', () => {
      expect(fieldOfThrown(() => checkRepoRef('a..b'))).toBe('ci_ref');
      expect(fieldOfThrown(() => checkRepoRef('a..b', 'repo_ref'))).toBe(
        'repo_ref',
      );
    });

    it.each(['main', 'release/1.0', 'v1.2.3', 'feature_a-b'])(
      'accepts %s',
      (ref) => {
        expect(checkRepoRef(ref, 'repo_ref')).toBe(ref);
      },
    );

    it.each(['-upload-pack=x', 'a..b', 'a b', 'a;b', '', 'a'.repeat(201)])(
      'refuses %s',
      (ref) => {
        expect(fieldOfThrown(() => checkRepoRef(ref, 'repo_ref'))).toBe(
          'repo_ref',
        );
      },
    );
  });

  describe('checkRelativePath', () => {
    it.each(['reports/results.xml', 'target/surefire-reports/*.xml', 'a'])(
      'accepts %s',
      (path) => {
        expect(checkRelativePath('work_dir', path)).toBe(path);
      },
    );

    it.each([
      '',
      '/etc/passwd',
      '../secret',
      'a/../../b',
      'a\\b',
      'C:/x',
      'a\0b',
      'a'.repeat(AUTOMATION_LIMITS.resultPath + 1),
    ])('refuses %j', (path) => {
      expect(fieldOfThrown(() => checkRelativePath('work_dir', path))).toBe(
        'work_dir',
      );
    });
  });

  describe('checkEnv', () => {
    it.each(['a\nb', 'a\r\nb', 'a\rb'])(
      'refuses the line break in %j, with the way out in the message',
      (value) => {
        try {
          checkEnv('secrets', { PEM_KEY: value });
          throw new Error('not refused');
        } catch (error) {
          expect(responseOf(error).message).toContain('base64');
        }
      },
    );

    it('refuses a secret too short for the log mask to hide', () => {
      expect(() => checkEnv('secrets', { A: 'abc' })).toThrow(
        BadRequestException,
      );
      expect(checkEnv('secrets', { A: 'abcd' })).toEqual({ A: 'abcd' });
    });

    it('allows a short plain variable', () => {
      expect(checkEnv('env', { A: 'x' })).toEqual({ A: 'x' });
    });

    it('keeps valid names and values', () => {
      expect(checkEnv('env', { BASE_URL: 'https://a', _X1: '' })).toEqual({
        BASE_URL: 'https://a',
        _X1: '',
      });
    });

    it.each([
      'PATH',
      'HOME',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'ALL_PROXY',
      'XISUITE_TOKEN',
      'XISUITE_SPEC_FILES',
      'XISUITE_SPEC_CSV',
      'XISUITE_MAVEN_TESTS',
      'lower',
      '1ABC',
      'A-B',
    ])('refuses the name %s', (name) => {
      expect(fieldOfThrown(() => checkEnv('env', { [name]: 'x' }))).toBe('env');
    });

    it('refuses a value that is not text, or too long', () => {
      expect(fieldOfThrown(() => checkEnv('secrets', { A: 1 }))).toBe(
        'secrets',
      );
      expect(
        fieldOfThrown(() =>
          checkEnv('env', {
            A: 'x'.repeat(AUTOMATION_LIMITS.envValue + 1),
          }),
        ),
      ).toBe('env');
    });

    it('refuses too many variables', () => {
      const many = Object.fromEntries(
        Array.from({ length: AUTOMATION_LIMITS.envEntries + 1 }, (_, index) => [
          `V${index}`,
          'x',
        ]),
      );

      expect(fieldOfThrown(() => checkEnv('env', many))).toBe('env');
    });
  });

  describe('checkHosts', () => {
    it('lower-cases and removes repeats', async () => {
      await expect(
        checkHosts([
          ' App.Example.com ',
          'app.example.com',
          'b.example.com:8443',
        ]),
      ).resolves.toEqual(['app.example.com', 'b.example.com:8443']);
    });

    it.each(['localhost', '10.0.0.1', 'https://a.example.com', 'a b.com'])(
      'refuses %s as a host name',
      async (host) => {
        await expect(fieldOfRejected(checkHosts([host]))).resolves.toBe(
          'allowed_hosts',
        );
        expect(publicCheck).not.toHaveBeenCalled();
      },
    );

    it('refuses a host that is not public', async () => {
      publicCheck.mockRejectedValue(new Error('private'));

      await expect(
        fieldOfRejected(checkHosts(['internal.example.com'])),
      ).resolves.toBe('allowed_hosts');
    });

    it('refuses too many hosts', async () => {
      const many = Array.from(
        { length: AUTOMATION_LIMITS.hosts + 1 },
        (_, index) => `h${index}.example.com`,
      );

      await expect(fieldOfRejected(checkHosts(many))).resolves.toBe(
        'allowed_hosts',
      );
    });

    it('refuses a port outside 1 to 65535 with that reason', async () => {
      await expect(checkHosts(['example.com:99999'])).rejects.toThrow(
        'example.com:99999 has a port outside 1 to 65535',
      );
      expect(publicCheck).not.toHaveBeenCalled();
    });
  });

  describe('runnerImages', () => {
    const digest = `@sha256:${'a'.repeat(64)}`;

    it('offers only images pinned by digest under a safe key', () => {
      expect(
        runnerImages(
          JSON.stringify({
            playwright: `mcr.example.com/pw${digest}`,
            latest: 'mcr.example.com/pw:latest',
            'Bad Key': `mcr.example.com/pw${digest}`,
          }),
        ),
      ).toEqual([{ key: 'playwright', image: `mcr.example.com/pw${digest}` }]);
    });

    it.each(['', 'not json', '[]', 'null'])(
      'offers nothing for the setting %j',
      (raw) => {
        expect(runnerImages(raw)).toEqual([]);
      },
    );
  });

  describe('runnerEnabled', () => {
    const saved = process.env.TM_RUNNER_ENABLED;

    afterEach(() => {
      if (saved === undefined) delete process.env.TM_RUNNER_ENABLED;
      else process.env.TM_RUNNER_ENABLED = saved;
    });

    it('is on only for the value 1', () => {
      process.env.TM_RUNNER_ENABLED = '1';
      expect(runnerEnabled()).toBe(true);

      process.env.TM_RUNNER_ENABLED = 'true';
      expect(runnerEnabled()).toBe(false);
    });
  });

  describe('availableRunnerImages', () => {
    const saved = {
      enabled: process.env.TM_RUNNER_ENABLED,
      images: process.env.TM_RUNNER_IMAGES,
    };
    const pinned = `repo/pw@sha256:${'a'.repeat(64)}`;

    afterEach(() => {
      process.env.TM_RUNNER_ENABLED = saved.enabled;
      process.env.TM_RUNNER_IMAGES = saved.images;
    });

    it('adds the images from their Docker files while the runner is on', () => {
      process.env.TM_RUNNER_ENABLED = '1';
      process.env.TM_RUNNER_IMAGES = '{}';

      expect(availableRunnerImages()).toEqual([
        { key: 'playwright', image: 'xis-tm-runner-playwright:latest' },
        { key: 'cypress-15', image: 'xis-tm-runner-cypress:latest' },
        { key: 'node-24', image: 'xis-tm-runner-node:latest' },
        { key: 'maven-3.9-java21', image: 'xis-tm-runner-junit:latest' },
      ]);
    });

    it('offers no built-in image while the runner is off', () => {
      process.env.TM_RUNNER_ENABLED = '0';
      process.env.TM_RUNNER_IMAGES = JSON.stringify({ playwright: pinned });

      expect(availableRunnerImages()).toEqual([
        { key: 'playwright', image: pinned },
      ]);
    });

    it("lets the operator's list replace a built-in key", () => {
      process.env.TM_RUNNER_ENABLED = '1';
      process.env.TM_RUNNER_IMAGES = JSON.stringify({ playwright: pinned });

      expect(availableRunnerImages()).toEqual([
        { key: 'playwright', image: pinned },
        { key: 'cypress-15', image: 'xis-tm-runner-cypress:latest' },
        { key: 'node-24', image: 'xis-tm-runner-node:latest' },
        { key: 'maven-3.9-java21', image: 'xis-tm-runner-junit:latest' },
      ]);
    });

    it('only recognises the exact built-in image name', () => {
      expect(isBuiltInRunnerImage('xis-tm-runner-node:latest')).toBe(true);
      expect(isBuiltInRunnerImage('xis-tm-runner-node:other')).toBe(false);
      expect(isBuiltInRunnerImage('someone/xis-tm-runner-node:latest')).toBe(
        false,
      );
    });
  });
});

describe('checkSpecFiles', () => {
  it('keeps one copy of each, in a fixed order', () => {
    expect(checkSpecFiles(['b.spec.js', 'a.spec.js', 'b.spec.js'])).toEqual([
      'a.spec.js',
      'b.spec.js',
    ]);
  });

  it.each(['-rf', '../a.spec.js', '/a.spec.js', 'a b.spec.js', 'a;b.spec.js'])(
    'refuses %j by the same rule as a new file',
    (path) => {
      expect(fieldOfThrown(() => checkSpecFiles([path]))).toBe('path');
    },
  );

  it('refuses more than Docker can hold on one line', () => {
    const long = Array.from(
      { length: 100 },
      (_, index) => `${'x'.repeat(500)}${index}`,
    );

    expect(fieldOfThrown(() => checkSpecFiles(long))).toBe('spec_files');
  });

  it('accepts a list just under that size', () => {
    const files = Array.from(
      { length: 60 },
      (_, index) => `${'x'.repeat(500)}${index}`,
    );

    expect(checkSpecFiles(files)).toHaveLength(60);
  });

  it('refuses more than the most files a run can name', () => {
    const files = Array.from(
      { length: AUTOMATION_LIMITS.specFiles + 1 },
      (_, index) => `${index}.spec.js`,
    );

    expect(fieldOfThrown(() => checkSpecFiles(files))).toBe('spec_files');
  });
});

describe('cleanProjectPath', () => {
  it.each([
    ['./a//b/', 'a/b'],
    ['a/./b', 'a/b'],
    ['', ''],
    ['.', ''],
  ])('reads %j as %j', (value, clean) => {
    expect(cleanProjectPath(value)).toBe(clean);
  });
});

describe('specFilesIn', () => {
  const names = [
    'package.json',
    'a.spec.ts',
    './b.test.js',
    'c.cy.js',
    'test_a.py',
    'a_test.py',
    'helpers.py',
    'LoginTest.java',
    'CartTest.kt',
    'Helper.java',
    '.env',
    '.secret/a.spec.ts',
    'node_modules/x/a.spec.js',
    'with space.spec.js',
    'e2e/in.spec.ts',
    'e2e/.hidden/in.spec.ts',
    'e2e/nested/deep.spec.ts',
    'e2e2/out.spec.ts',
  ];

  it('offers what each framework can run', () => {
    expect(specFilesIn(names, 'playwright', null)).toEqual([
      'a.spec.ts',
      'b.test.js',
      'e2e/in.spec.ts',
      'e2e/nested/deep.spec.ts',
      'e2e2/out.spec.ts',
    ]);
    expect(specFilesIn(names, 'cypress', 'e2e2')).toEqual(['out.spec.ts']);
    expect(specFilesIn(names, 'pytest', null)).toEqual([
      'test_a.py',
      'a_test.py',
    ]);
    expect(specFilesIn(names, 'maven', null)).toEqual([
      'LoginTest.java',
      'CartTest.kt',
    ]);
  });

  it("offers Surefire's default Maven test class names", () => {
    expect(
      specFilesIn(
        [
          'src/test/java/LoginTest.java',
          'src/test/java/TestCart.java',
          'src/test/java/OrderTests.kt',
          'src/test/java/PaymentTestCase.java',
          'src/test/java/Helper.java',
          'src/test/java/Contest.java',
          'src/test/java/LoginTest.groovy',
        ],
        'maven',
        null,
      ),
    ).toEqual([
      'src/test/java/LoginTest.java',
      'src/test/java/TestCart.java',
      'src/test/java/OrderTests.kt',
      'src/test/java/PaymentTestCase.java',
    ]);
  });

  it('offers what each Node.js framework can run', () => {
    const node = [
      'src/a.test.ts',
      'src/b.spec.mjs',
      'src/__tests__/c.tsx',
      'test/d.js',
      'src/util.ts',
      'node_modules/x/e.test.js',
    ];

    expect(specFilesIn(node, 'jest', null)).toEqual([
      'src/a.test.ts',
      'src/b.spec.mjs',
      'src/__tests__/c.tsx',
    ]);
    expect(specFilesIn(node, 'vitest', null)).toEqual([
      'src/a.test.ts',
      'src/b.spec.mjs',
    ]);
    expect(specFilesIn(node, 'mocha', null)).toEqual([
      'src/a.test.ts',
      'src/b.spec.mjs',
      'test/d.js',
    ]);
  });

  it('offers the Node.js test runner its own JavaScript and TypeScript files only', () => {
    const node = [
      'src/a.test.ts',
      'src/b.spec.mjs',
      'c.test.cjs',
      'd.spec.mts',
      'e.test.cts',
      'f.test.js',
      'src/g.test.tsx',
      'src/__tests__/h.ts',
      'test/i.js',
      'node_modules/x/j.test.js',
      '.cache/k.test.js',
    ];

    expect(specFilesIn(node, 'node-test', null)).toEqual([
      'src/a.test.ts',
      'src/b.spec.mjs',
      'c.test.cjs',
      'd.spec.mts',
      'e.test.cts',
      'f.test.js',
    ]);
  });

  it('never lets a setting save the Node.js test runner as its preset', () => {
    expect(AUTOMATION_PRESETS).not.toContain('node-test');
  });

  it('offers Node.js and Maven test files to an auto setting', () => {
    const files = [
      'src/a.test.ts',
      'src/test/java/FooTest.java',
      'src/test/java/Helper.java',
      'pom.xml',
    ];

    expect(specFilesIn(files, 'auto', null)).toEqual([
      'src/a.test.ts',
      'src/test/java/FooTest.java',
    ]);
  });

  it('adds Cypress files for Cypress only', () => {
    expect(specFilesIn(names, 'cypress', null)).toContain('c.cy.js');
    expect(specFilesIn(names, 'playwright', null)).not.toContain('c.cy.js');
  });

  it('offers every file for a custom setting, never a dot file', () => {
    const files = specFilesIn(names, 'custom', null);

    expect(files).toContain('package.json');
    expect(files).toContain('helpers.py');
    expect(files).not.toContain('.env');
    expect(files.some((file) => file.includes('.secret'))).toBe(false);
    expect(files.some((file) => file.includes('node_modules'))).toBe(false);
    expect(files.some((file) => file.includes('.hidden'))).toBe(false);
  });

  it('lists only the tests folder, relative to it', () => {
    expect(specFilesIn(names, 'playwright', './e2e/')).toEqual([
      'in.spec.ts',
      'nested/deep.spec.ts',
    ]);
  });

  it('leaves out names that could not be selected', () => {
    expect(specFilesIn(names, 'playwright', null)).not.toContain(
      'with space.spec.js',
    );
  });
});

describe('runnerRuntime', () => {
  it('knows the built-in images and no others', () => {
    expect(runnerRuntime('xis-tm-runner-node:latest')?.language).toBe(
      'Node.js',
    );
    expect(runnerRuntime('repo@sha256:abc')).toBeUndefined();
  });
});

describe('checkFilePath', () => {
  it.each([
    'a.spec.ts',
    'tests/login.spec.ts',
    '.env.example',
    'a-b_c.d/e',
    'x'.repeat(AUTOMATION_LIMITS.filePath),
  ])('accepts %s', (path) => {
    expect(checkFilePath(path)).toBe(path);
  });

  it.each([
    '',
    '/etc/passwd',
    '../evil',
    'a/../b',
    'a..b',
    './a',
    'a/./b',
    'a//b',
    'a/',
    '.',
    '-rf',
    'a b.txt',
    'a\\b',
    'a;b',
    'ünï.txt',
    'x'.repeat(AUTOMATION_LIMITS.filePath + 1),
  ])('refuses %j', (path) => {
    expect(fieldOfThrown(() => checkFilePath(path))).toBe('path');
  });
});
