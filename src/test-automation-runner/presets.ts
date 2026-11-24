import {
  cleanProjectPath,
  type RunPreset,
} from '../test-management/automation/automation-inputs';

// Added to the default test command only when files are selected, so a run of all tests never carries an empty flag.
interface SpecSelection {
  flags: string;
  // Reach the command as "$@", so a name is never read as shell text.
  args?: string[];
  env?: Record<string, string>;
}

interface RunnerPreset {
  // Runs before the tests, in the same shell; null when the image already has what it needs.
  install: string | null;
  // Null only for the custom preset, whose command comes from the setting.
  test: string | null;
  // Package hosts the install step must reach through the proxy.
  hosts: string[];
  // Set to the first result path, for tools that read their output file from a variable.
  resultEnv?: string;
  // Keeps a trace of failed tests, and where it ends up, for frameworks that have one.
  trace?: { flag: string; path: string };
  // Java tools ignore the proxy variables, so they get the proxy as JVM options.
  jvmOptionsEnv?: string;
  // Fixed variables the framework needs.
  env?: Record<string, string>;
  // A file the test command needs in the project folder.
  reporter?: { file: string; source: string };
  // How the default command is limited to some files.
  select?: (files: string[], workDir: string | null) => SpecSelection;
  // Added to the default command when no files are chosen.
  allFiles?: string;
  // Where the default command writes its results, when it writes more than one file.
  ownResults?: { file: string; pattern: string };
}

// Printed between the install and the tests, so the worker knows when the tests start.
export const TESTS_START_MARKER = 'XISUITE_TESTS_START';
export const TESTS_START_LINE = `${TESTS_START_MARKER}\n`;

// Prints each test's name as it starts, because the list reporter names a test only when it ends.
const PROGRESS_REPORTER = {
  file: '.xisuite-progress.cjs',
  source: `module.exports = class {
  onTestBegin(test) {
    process.stdout.write('\\u25B6 ' + test.title + '\\n');
  }
  printsToStdio() {
    return true;
  }
};
`,
};

/**
 * Playwright reads an argument as a case-insensitive pattern matched anywhere in the path, so a.spec.ts alone would
 * also run data.spec.ts.
 */
function exactPathPattern(file: string, workDir: string | null): string {
  const path = ['/work', cleanProjectPath(workDir ?? ''), file]
    .filter(Boolean)
    .join('/');

  return `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/** Surefire takes class names, so only Java and Kotlin files can be selected for Maven. */
export function mavenTestNames(files: string[]): string[] {
  const names = files
    .filter((file) => /\.(java|kt)$/.test(file))
    .map((file) => (file.split('/').pop() ?? '').replace(/\.(java|kt)$/, ''));

  return [...new Set(names)];
}

const NPM_INSTALL =
  'if [ -f package-lock.json ]; then npm ci; else npm install; fi';

// Installed globally in the Node image, so a project needn't list them.
const NODE_REPORTERS = '/usr/local/lib/node_modules';

// Some reporters don't create the folder of their output file.
const MAKE_RESULT_FOLDER = 'mkdir -p "$(dirname "$XISUITE_RESULT")"';

// Vitest matches a filter anywhere in the path, so the full path keeps a.test.ts from also running data.test.ts.
function fullPath(file: string, workDir: string | null): string {
  return ['/work', cleanProjectPath(workDir ?? ''), file]
    .filter(Boolean)
    .join('/');
}

/**
 * What each framework runs. Commands read the output file from $XISUITE_RESULT, so a result path is never pasted into
 * shell text; settings cannot set XISUITE_ variables.
 */
export const RUNNER_PRESETS: Record<RunPreset, RunnerPreset> = {
  playwright: {
    install: NPM_INSTALL,
    test: `npx playwright test --reporter=list,junit,/work/${PROGRESS_REPORTER.file}`,
    hosts: ['registry.npmjs.org'],
    resultEnv: 'PLAYWRIGHT_JUNIT_OUTPUT_NAME',
    // The list reporter stays silent until a test ends, so each action is printed as it happens.
    env: { DEBUG: 'pw:api' },
    reporter: PROGRESS_REPORTER,
    trace: {
      flag: '--trace retain-on-failure',
      path: 'test-results/*/trace.zip',
    },
    select: (files, workDir) => ({
      flags: ' "$@"',
      args: files.map((file) => exactPathPattern(file, workDir)),
    }),
  },
  pytest: {
    install:
      'if [ -f requirements.txt ]; then python -m pip install --user -r requirements.txt; fi',
    test: 'python -m pytest -v --junitxml="$XISUITE_RESULT"',
    hosts: ['pypi.org', 'files.pythonhosted.org'],
    select: (files) => ({ flags: ' "$@"', args: files }),
  },
  maven: {
    install: null,
    test: 'mvn -B -Dmaven.repo.local=/tmp/m2 test',
    hosts: ['repo.maven.apache.org', 'repo1.maven.org'],
    jvmOptionsEnv: 'MAVEN_OPTS',
    // Without the second flag, a module with none of these classes fails the whole build.
    select: (files) => ({
      flags:
        ' -Dtest="$XISUITE_MAVEN_TESTS" -Dsurefire.failIfNoSpecifiedTests=false',
      env: { XISUITE_MAVEN_TESTS: mavenTestNames(files).join(',') },
    }),
  },
  cypress: {
    install: NPM_INSTALL,
    test: 'npx cypress run --reporter junit --reporter-options "mochaFile=$XISUITE_RESULT"',
    hosts: ['registry.npmjs.org'],
    select: (files) => ({
      flags: ' --spec "$XISUITE_SPEC_CSV"',
      env: { XISUITE_SPEC_CSV: files.join(',') },
    }),
    // One file per spec: with a single name, each spec would replace the last one's results.
    ownResults: {
      file: '.xisuite-results/cypress-[hash].xml',
      pattern: '.xisuite-results/cypress-*.xml',
    },
  },
  jest: {
    install: NPM_INSTALL,
    test: `npx jest --ci --reporters=default --reporters=${NODE_REPORTERS}/jest-junit`,
    hosts: ['registry.npmjs.org'],
    resultEnv: 'JEST_JUNIT_OUTPUT_FILE',
    select: (files) => ({ flags: ' --runTestsByPath "$@"', args: files }),
  },
  vitest: {
    install: NPM_INSTALL,
    test: 'npx vitest run --reporter=default --reporter=junit --outputFile.junit="$XISUITE_RESULT"',
    hosts: ['registry.npmjs.org'],
    select: (files, workDir) => ({
      flags: ' "$@"',
      args: files.map((file) => fullPath(file, workDir)),
    }),
  },
  mocha: {
    install: NPM_INSTALL,
    test: `${MAKE_RESULT_FOLDER} && npx mocha --reporter xunit --reporter-options "output=$XISUITE_RESULT"`,
    hosts: ['registry.npmjs.org'],
    // Files named in the project's .mocharc "spec" still run beside the chosen ones.
    select: (files) => ({ flags: ' "$@"', args: files }),
  },
  // Node's own runner needs nothing installed; node_modules is never searched.
  'node-test': {
    install: null,
    test: `${MAKE_RESULT_FOLDER} && node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination="$XISUITE_RESULT"`,
    hosts: [],
    select: (files) => ({ flags: ' "$@"', args: files }),
    allFiles: '"**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}"',
  },
  custom: { install: null, test: null, hosts: [] },
  // Only the network before the framework is known; a run always uses the detected preset.
  auto: { install: null, test: null, hosts: ['registry.npmjs.org'] },
};

// A clone happens before detection, so an auto Git run's network also lets a Maven project download.
export const GIT_AUTO_HOSTS = [
  ...RUNNER_PRESETS.auto.hosts,
  ...RUNNER_PRESETS.maven.hosts,
];

// Where Surefire writes, for an auto run that turned out to be Maven, in a single or multi-module project.
export const MAVEN_AUTO_RESULT_PATHS = [
  'target/surefire-reports/TEST-*.xml',
  '*/target/surefire-reports/TEST-*.xml',
];

export interface PresetRun {
  command: string;
  env: Record<string, string>;
  hosts: string[];
  tracePath?: string;
  jvmOptionsEnv?: string;
  reporter?: { file: string; source: string };
  // What follows the command in sh -c, for the "$@" in it.
  args?: string[];
  // Replaces the setting's result paths for this run.
  resultPaths?: string[];
}

export interface PresetRunChoices {
  installCommand?: string | null;
  specFiles?: string[];
  workDir?: string | null;
}

/** On its own lines, so a comment or a trailing ; || in it can't swallow the rest, and an exit in it ends only itself. */
const inSubshell = (command: string) => `(\n${command}\n)`;

/** The shell command, variables and package hosts of one run. Older runs' copies of a setting have no choices. */
export function presetRun(
  preset: RunPreset,
  storedCommand: string | null,
  resultPaths: string[],
  keepTrace = false,
  markTestsStart = false,
  { installCommand, specFiles = [], workDir = null }: PresetRunChoices = {},
): PresetRun {
  if (preset === 'auto')
    throw new Error('An auto setting runs with its detected preset');

  const {
    install,
    test,
    hosts,
    resultEnv,
    trace,
    jvmOptionsEnv,
    env: presetEnv,
    reporter,
    select,
    allFiles,
    ownResults,
  } = RUNNER_PRESETS[preset];
  const ownCommand = storedCommand?.trim() || null;
  const ownInstall = installCommand?.trim() || null;

  if (!test && !ownCommand) throw new Error('A custom setting needs a command');

  const traced = !ownCommand && keepTrace && trace ? trace : null;
  const selection =
    !ownCommand && select && specFiles.length > 0
      ? select(specFiles, workDir)
      : null;
  const installStep = ownInstall ? inSubshell(ownInstall) : install;
  const defaultTests = `${test}${traced ? ` ${traced.flag}` : ''}${selection?.flags ?? (allFiles ? ` ${allFiles}` : '')}`;
  const tests = !ownCommand
    ? defaultTests
    : test || installStep
      ? inSubshell(ownCommand)
      : ownCommand;

  const own = ownCommand ? undefined : ownResults;
  const result = own?.file ?? resultPaths[0] ?? '';

  return {
    command: installStep
      ? `${installStep} && ${markTestsStart ? `printf '%s\\n' ${TESTS_START_MARKER} && ` : ''}${tests}`
      : tests,
    env: {
      XISUITE_RESULT: result,
      ...(resultEnv ? { [resultEnv]: result } : {}),
      ...presetEnv,
      ...(specFiles.length > 0
        ? { XISUITE_SPEC_FILES: specFiles.join(',') }
        : {}),
      ...selection?.env,
    },
    hosts,
    ...(traced ? { tracePath: traced.path } : {}),
    ...(jvmOptionsEnv ? { jvmOptionsEnv } : {}),
    ...(reporter ? { reporter } : {}),
    ...(selection?.args ? { args: selection.args } : {}),
    ...(own ? { resultPaths: [own.pattern] } : {}),
  };
}
