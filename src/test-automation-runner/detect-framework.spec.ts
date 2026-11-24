import { detectFramework } from './detect-framework';

const project = (
  files: Record<string, string>,
  workDir: string | null = null,
) =>
  detectFramework(Object.keys(files), (path) => files[path] ?? null, workDir);

const pkg = (body: Record<string, unknown>) => JSON.stringify(body);

describe('detectFramework', () => {
  it.each([
    [
      'playwright',
      'playwright',
      {
        'package.json': pkg({
          devDependencies: { '@playwright/test': '~1.62.0' },
        }),
        'playwright.config.js': '',
        'tests/login.spec.js': '',
      },
      'playwright.config.js',
    ],
    [
      'cypress',
      'cypress-15',
      {
        'package.json': pkg({ devDependencies: { cypress: '15.5.0' } }),
        'cypress.config.js': '',
        'cypress/e2e/cart.cy.js': '',
      },
      'cypress.config.js',
    ],
    [
      'jest',
      'node-24',
      {
        'package.json': pkg({
          devDependencies: { jest: '^30.5.2' },
          scripts: { test: 'jest' },
        }),
        'tests/cart.test.js': '',
      },
      'package.json devDependencies',
    ],
    [
      'vitest',
      'node-24',
      {
        'package.json': pkg({
          devDependencies: { vitest: '^5.1.0' },
          scripts: { test: 'vitest run' },
        }),
        'tests/price.test.ts': '',
      },
      'package.json devDependencies',
    ],
    [
      'mocha',
      'node-24',
      {
        'package.json': pkg({
          devDependencies: { mocha: '^12.0.3' },
          scripts: { test: 'mocha' },
        }),
        'test/text.test.js': '',
      },
      'package.json devDependencies',
    ],
  ])('finds %s in the sample project', (preset, imageKey, files, reason) => {
    expect(project(files)).toEqual({ preset, image_key: imageKey, reason });
  });

  it('finds Playwright from its config file alone, as in a Next.js app without the package', () => {
    expect(
      project({
        'package.json': pkg({ devDependencies: { typescript: '5.5.4' } }),
        'playwright.config.ts': '',
        'tests/auth.spec.ts': '',
      }),
    ).toEqual({
      preset: 'playwright',
      image_key: 'playwright',
      reason: 'playwright.config.ts',
    });
  });

  it('looks only in the tests folder of a monorepo', () => {
    const files = {
      'package.json': pkg({ devDependencies: { jest: '30' } }),
      'apps/web/package.json': pkg({ devDependencies: { vitest: '5' } }),
      'apps/web/src/a.test.ts': '',
    };

    expect(project(files, 'apps/web')).toMatchObject({ preset: 'vitest' });
    expect(project(files, './apps/web/')).toMatchObject({ preset: 'vitest' });
    expect(project(files, 'apps/api')).toBeNull();
  });

  it('picks by strength, then by the fixed order, and names what else it found', () => {
    expect(
      project({
        'package.json': pkg({
          devDependencies: { jest: '30', '@playwright/test': '1' },
        }),
        'jest.config.js': '',
      }),
    ).toEqual({
      preset: 'jest',
      image_key: 'node-24',
      reason: 'jest.config.js; also found playwright',
    });

    expect(
      project({
        'package.json': pkg({
          devDependencies: { jest: '30', '@playwright/test': '1' },
        }),
      }),
    ).toEqual({
      preset: 'playwright',
      image_key: 'playwright',
      reason: 'package.json devDependencies; also found jest',
    });
  });

  it('counts a "jest" key and the test script', () => {
    expect(
      project({ 'package.json': pkg({ jest: { testEnvironment: 'node' } }) }),
    ).toMatchObject({
      preset: 'jest',
      reason: 'package.json "jest" key',
    });
    expect(
      project({
        'package.json': pkg({ scripts: { test: 'mocha --recursive' } }),
      }),
    ).toMatchObject({
      preset: 'mocha',
      reason: 'package.json scripts.test',
    });
    expect(project({ '.mocharc.yml': '' })).toMatchObject({
      preset: 'mocha',
      reason: '.mocharc.yml',
    });
  });

  it('ignores a broken, non-object or huge package.json, and config files still decide', () => {
    expect(project({ 'package.json': '{ not json' })).toBeNull();
    expect(project({ 'package.json': '["jest"]' })).toBeNull();
    expect(
      project({
        'package.json': `{"devDependencies":{"jest":"1"},"x":"${'a'.repeat(1024 * 1024)}"}`,
      }),
    ).toBeNull();
    expect(
      project({ 'package.json': '{ not json', 'cypress.json': '{}' }),
    ).toMatchObject({ preset: 'cypress' });
  });

  it('ignores files below the top of the tests folder, installed packages and dot-folders', () => {
    expect(
      project({
        'node_modules/jest/package.json': pkg({ name: 'jest' }),
        '.github/playwright.config.ts': '',
        'tests/jest.config.js': '',
      }),
    ).toBeNull();
  });

  it('detects Maven and names pytest projects instead of running them', () => {
    expect(project({ 'pom.xml': '<project/>' })).toEqual({
      preset: 'maven',
      image_key: 'maven-3.9-java21',
      reason: 'pom.xml',
    });
    expect(project({ 'conftest.py': '', 'test_a.py': '' })).toEqual({
      unsupported: 'pytest',
    });
    expect(project({ 'requirements.txt': 'pytest' })).toEqual({
      unsupported: 'pytest',
    });
  });

  it('lets a Node.js framework win over a pom.xml beside it', () => {
    expect(
      project({
        'pom.xml': '<project/>',
        'package.json': pkg({ devDependencies: { jest: '30' } }),
      }),
    ).toMatchObject({ preset: 'jest', image_key: 'node-24' });
  });

  it('prefers a pom.xml over a Python or Gradle file beside it', () => {
    expect(
      project({ 'pom.xml': '<project/>', 'requirements.txt': '' }),
    ).toMatchObject({ preset: 'maven' });
    expect(
      project({ 'pom.xml': '<project/>', 'build.gradle': '' }),
    ).toMatchObject({ preset: 'maven' });
  });

  it('finds a pom.xml only at the top of the tests folder', () => {
    expect(project({ 'api/pom.xml': '<project/>' })).toBeNull();
    expect(project({ 'api/pom.xml': '<project/>' }, 'api')).toMatchObject({
      preset: 'maven',
    });
  });

  it.each([
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'gradlew',
  ])('names a project with %s as Gradle', (file) => {
    expect(project({ [file]: '' })).toEqual({ unsupported: 'gradle' });
  });

  it('prefers a Node.js framework over a Python file beside it', () => {
    expect(
      project({ 'requirements.txt': '', 'vitest.config.ts': '' }),
    ).toMatchObject({ preset: 'vitest' });
  });

  describe('Node.js test runner', () => {
    const nodeTest = (reason: string) => ({
      preset: 'node-test',
      image_key: 'node-24',
      reason,
    });

    it('finds test files in any folder when no other framework is there', () => {
      expect(project({ 'tests/cart.test.js': '' })).toEqual(
        nodeTest('node:test files'),
      );
      expect(project({ 'src/deep/price.spec.mts': '' })).toEqual(
        nodeTest('node:test files'),
      );
      expect(
        project({
          'package.json': pkg({ type: 'module' }),
          'a.test.ts': '',
        }),
      ).toEqual(nodeTest('node:test files'));
    });

    it('finds a test script that runs node --test', () => {
      expect(
        project({
          'package.json': pkg({ scripts: { test: 'node  --test test/' } }),
        }),
      ).toEqual(nodeTest('package.json scripts.test'));
    });

    it('lets every other framework and a pom.xml win', () => {
      expect(
        project({
          'package.json': pkg({ devDependencies: { jest: '30' } }),
          'a.test.js': '',
        }),
      ).toMatchObject({ preset: 'jest' });
      expect(
        project({
          'package.json': pkg({ scripts: { test: 'node --test && mocha' } }),
        }),
      ).toMatchObject({ preset: 'mocha' });
      expect(project({ 'pom.xml': '<project/>', 'a.test.js': '' })).toEqual({
        preset: 'maven',
        image_key: 'maven-3.9-java21',
        reason: 'pom.xml',
      });
    });

    it('wins over a Python or Gradle file, which still answer alone', () => {
      expect(project({ 'requirements.txt': '', 'a.test.js': '' })).toEqual(
        nodeTest('node:test files'),
      );
      expect(project({ 'build.gradle': '', 'a.spec.ts': '' })).toEqual(
        nodeTest('node:test files'),
      );
      expect(project({ 'requirements.txt': '', 'test_a.py': '' })).toEqual({
        unsupported: 'pytest',
      });
      expect(project({ gradlew: '', 'src/App.test.tsx': '' })).toEqual({
        unsupported: 'gradle',
      });
    });

    it('ignores installed packages, dot-folders, JSX and other folders', () => {
      expect(
        project({
          'node_modules/x/a.test.js': '',
          '.github/b.test.js': '',
          'src/c.test.jsx': '',
        }),
      ).toBeNull();
      expect(project({ 'web/a.test.js': '' }, 'api')).toBeNull();
      expect(project({ 'api/a.test.js': '' }, 'api')).toEqual(
        nodeTest('node:test files'),
      );
    });

    it('finds no test script in other words', () => {
      expect(
        project({
          'package.json': pkg({ scripts: { test: 'nodemon --test' } }),
        }),
      ).toBeNull();
    });
  });

  it('answers null when nothing is found', () => {
    expect(project({})).toBeNull();
    expect(project({ 'README.md': '', 'src/index.js': '' })).toBeNull();
  });
});
