import {
  cleanProjectPath,
  specFilesIn,
} from '../test-management/automation/automation-inputs';

type JsPreset = 'playwright' | 'cypress' | 'vitest' | 'jest' | 'mocha';

export type DetectedPreset = JsPreset | 'maven' | 'node-test';

export interface DetectedFramework {
  preset: DetectedPreset;
  image_key: string;
  reason: string;
}

export type FrameworkDetection =
  | DetectedFramework
  | { unsupported: 'pytest' | 'gradle' }
  | null;

// When a project matches more than one framework at the same strength, the first one wins.
const ORDER: JsPreset[] = ['playwright', 'cypress', 'vitest', 'jest', 'mocha'];

// Built-in image keys; the operator can still give a key its own image.
export const DETECTED_IMAGE_KEYS: Record<DetectedPreset, string> = {
  playwright: 'playwright',
  cypress: 'cypress-15',
  vitest: 'node-24',
  jest: 'node-24',
  mocha: 'node-24',
  maven: 'maven-3.9-java21',
  'node-test': 'node-24',
};

export const PACKAGE_JSON_BYTES = 1024 * 1024;

const CONFIG_FILES: Record<JsPreset, RegExp> = {
  playwright: /^playwright\.config\.[cm]?[jt]s$/,
  cypress: /^(cypress\.config\.[^/]+|cypress\.json)$/,
  vitest: /^vitest\.config\.[^/]+$/,
  jest: /^jest\.config\.[^/]+$/,
  mocha: /^\.mocharc(\.[^/]+)?$/,
};

const PACKAGES: Record<JsPreset, string[]> = {
  playwright: ['@playwright/test', 'playwright'],
  cypress: ['cypress'],
  vitest: ['vitest'],
  jest: ['jest'],
  mocha: ['mocha'],
};

const UNSUPPORTED: Record<string, 'pytest' | 'gradle'> = {
  'pytest.ini': 'pytest',
  'conftest.py': 'pytest',
  'requirements.txt': 'pytest',
  'build.gradle': 'gradle',
  'build.gradle.kts': 'gradle',
  'settings.gradle': 'gradle',
  'settings.gradle.kts': 'gradle',
  gradlew: 'gradle',
};

interface PackageJson {
  dependencies?: unknown;
  devDependencies?: unknown;
  scripts?: unknown;
  jest?: unknown;
}

function parsePackageJson(text: string | null): PackageJson | null {
  if (text === null || Buffer.byteLength(text) > PACKAGE_JSON_BYTES)
    return null;

  try {
    const parsed: unknown = JSON.parse(text);

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as PackageJson)
      : null;
  } catch {
    return null;
  }
}

const hasKey = (value: unknown, key: string): boolean =>
  typeof value === 'object' && value !== null && Object.hasOwn(value, key);

/**
 * Which test framework a project uses, from the files at the top of its tests folder. Config files decide first,
 * then package.json dependencies, then its test script, then a Maven pom.xml, then Node.js test runner files in any
 * folder. Gradle and Python projects are named but not run.
 */
export function detectFramework(
  files: string[],
  read: (path: string) => string | null,
  workDir: string | null,
): FrameworkDetection {
  const folder = cleanProjectPath(workDir ?? '');
  const prefix = folder ? `${folder}/` : '';
  const topLevel = new Set(
    files
      .map(cleanProjectPath)
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length))
      .filter((name) => name !== '' && !name.includes('/')),
  );
  const pkg = topLevel.has('package.json')
    ? parsePackageJson(read(`${prefix}package.json`))
    : null;
  const testScript =
    pkg && hasKey(pkg.scripts, 'test')
      ? (pkg.scripts as Record<string, unknown>).test
      : undefined;

  const signals: ((preset: JsPreset) => string | null)[] = [
    (preset) =>
      [...topLevel].sort().find((name) => CONFIG_FILES[preset].test(name)) ??
      (preset === 'jest' && hasKey(pkg, 'jest')
        ? 'package.json "jest" key'
        : null),
    (preset) => {
      for (const group of ['devDependencies', 'dependencies'] as const) {
        if (PACKAGES[preset].some((name) => hasKey(pkg?.[group], name))) {
          return `package.json ${group}`;
        }
      }

      return null;
    },
    (preset) =>
      typeof testScript === 'string' &&
      new RegExp(`\\b${preset}\\b`).test(testScript)
        ? 'package.json scripts.test'
        : null,
  ];

  // The strongest signal wins; within one strength, the fixed order decides.
  for (const signal of signals) {
    const winner = ORDER.find((preset) => signal(preset));

    if (!winner) continue;

    const others = ORDER.filter(
      (preset) => preset !== winner && signals.some((check) => check(preset)),
    );

    return {
      preset: winner,
      image_key: DETECTED_IMAGE_KEYS[winner],
      reason: `${signal(winner)}${others.length > 0 ? `; also found ${others.join(', ')}` : ''}`,
    };
  }

  if (topLevel.has('pom.xml')) {
    return {
      preset: 'maven',
      image_key: DETECTED_IMAGE_KEYS.maven,
      reason: 'pom.xml',
    };
  }

  if (typeof testScript === 'string' && /\bnode\s+--test\b/.test(testScript)) {
    return {
      preset: 'node-test',
      image_key: DETECTED_IMAGE_KEYS['node-test'],
      reason: 'package.json scripts.test',
    };
  }

  if (specFilesIn(files, 'node-test', workDir).length > 0) {
    return {
      preset: 'node-test',
      image_key: DETECTED_IMAGE_KEYS['node-test'],
      reason: 'node:test files',
    };
  }

  const unsupported = Object.keys(UNSUPPORTED)
    .filter((name) => topLevel.has(name))
    .map((name) => UNSUPPORTED[name]);

  return unsupported.length > 0 ? { unsupported: unsupported[0] } : null;
}
