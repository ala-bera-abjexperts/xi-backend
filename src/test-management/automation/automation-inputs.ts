import { BadRequestException } from '@nestjs/common';

import { assertPublicHttpUrl } from '../../common/security/ssrf-guard';
import { MIN_SECRET_LENGTH } from '../../test-automation-runner/mask-log';

// Limits mirror the test_automation_configs CHECKs; the database re-checks them.
export const AUTOMATION_LIMITS = {
  name: 100,
  repoUrl: 2000,
  repoRef: 200,
  workDir: 500,
  command: 2000,
  resultPaths: 20,
  resultPath: 500,
  envEntries: 50,
  envValue: 4000,
  hosts: 50,
  host: 253,
  ciUrl: 2000,
  ciHeaders: 20,
  ciHeaderValue: 4000,
  ciBody: 10000,
  zipBytes: 50 * 1024 * 1024,
  zipEntries: 5000,
  zipUnpackedBytes: 300 * 1024 * 1024,
  queuedRuns: 20,
  filePath: 512,
  fileTextBytes: 1024 * 1024,
  specFiles: 200,
  // Docker's env file limits a line to about 64 KB.
  specFilesBytes: 32 * 1024,
} as const;

const DEFAULT_QUEUE_PER_SPACE = 10;
const MAX_QUEUE_PER_ORG = 1000;

/** How many runs one organisation may have waiting. 20 by default; at most 1000, the most one database answer holds. */
export function readQueuePerOrg(
  raw = process.env.TM_RUNNER_QUEUE_PER_ORG,
): number {
  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    return AUTOMATION_LIMITS.queuedRuns;
  }

  return Math.min(value, MAX_QUEUE_PER_ORG);
}

/** How many runs one space may have waiting. 10 by default; never more than the organisation's limit. */
export function readQueuePerSpace(
  raw = process.env.TM_RUNNER_QUEUE_PER_SPACE,
): number {
  const value = Number(raw);
  const perSpace =
    !Number.isInteger(value) || value < 1 ? DEFAULT_QUEUE_PER_SPACE : value;

  return Math.min(perSpace, readQueuePerOrg());
}

export const AUTOMATION_PRESETS = [
  'playwright',
  'pytest',
  'maven',
  'cypress',
  'jest',
  'vitest',
  'mocha',
  'custom',
  'auto',
] as const;
export type AutomationPreset = (typeof AUTOMATION_PRESETS)[number];

// Only ever detected for an auto run; a setting can't save it, so the database check stays as it is.
export type RunPreset = AutomationPreset | 'node-test';

// An auto setting gets its framework and image when a run starts, and one fixed result file.
export const AUTO_IMAGE_KEY = 'auto';
export const AUTO_RESULT_PATH = '.xisuite-results/results.xml';

// What the workflow editor will open or commit.
export const WORKFLOW_CONTENT_BYTES = 64 * 1024;

export const CI_GOING_STATES = ['queued', 'running', 'importing'];

// Test types of these kinds are run by a CI tool; the others are manual.
export const AUTOMATED_TEST_KINDS = ['unstructured', 'gherkin'];

// Over this many, {testKeys} is left empty, which means run every test.
export const MAX_TEST_KEYS = 100;

// The same test as isCiRunInProgress, for a database query on REQUESTED runs.
export const CI_IN_PROGRESS_FILTER = `result_summary->ci->>state.in.(${CI_GOING_STATES.join(',')}),result_summary->>send_pending.eq.true`;

/** Still being sent, or followed on GitHub; its record can't be deleted yet. */
export function isCiRunInProgress(run: {
  status: string;
  result_summary: Record<string, unknown> | null;
}): boolean {
  if (run.status !== 'REQUESTED') return false;

  const ci = run.result_summary?.ci as { state?: string } | undefined;

  return (
    run.result_summary?.send_pending === true ||
    CI_GOING_STATES.includes(ci?.state ?? '')
  );
}

const REF_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,100}$/;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const HOST_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:\d{1,5})?$/;

// The runner sets these itself, so a setting may not override them.
const RESERVED_ENV = new Set([
  'PATH',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
]);
const BLOCKED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
]);

export function invalid(field: string, message: string): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_FAILED',
    field,
    message,
    // The error filter forwards only data, code and message.
    data: { field },
  });
}

/** Without query and hash: a CI URL often carries its token in the query string. */
export function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);

    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

/** A branch or tag name; a leading dash could be read by git as an option. */
export function checkRepoRef(value: string, field = 'ci_ref'): string {
  if (
    !REF_PATTERN.test(value) ||
    value.startsWith('-') ||
    value.includes('..')
  ) {
    throw invalid(
      field,
      'Use a branch or tag name made of letters, digits, . _ / and -',
    );
  }

  return value;
}

// A saved login wins; other saved headers still let the connection sign the request.
export const hasAuthorization = (headers: Record<string, string>): boolean =>
  Object.keys(headers).some((name) => name.toLowerCase() === 'authorization');

/** Headers sent with a CI job request. */
export function checkHeaders(
  value: Record<string, unknown>,
): Record<string, string> {
  const entries = Object.entries(value);

  if (entries.length > AUTOMATION_LIMITS.ciHeaders) {
    throw invalid(
      'ci_headers',
      `At most ${AUTOMATION_LIMITS.ciHeaders} headers are allowed`,
    );
  }

  const clean: Record<string, string> = {};

  for (const [name, raw] of entries) {
    if (
      !HEADER_NAME_PATTERN.test(name) ||
      BLOCKED_HEADERS.has(name.toLowerCase())
    ) {
      throw invalid('ci_headers', `The header ${name} is not allowed`);
    }

    if (
      typeof raw !== 'string' ||
      raw.length > AUTOMATION_LIMITS.ciHeaderValue ||
      /[\r\n\0]/.test(raw)
    ) {
      throw invalid(
        'ci_headers',
        `The value of ${name} must be one line of text`,
      );
    }

    // The characters Node accepts in a header; anything else can never be sent.
    if (/[^\t\x20-\x7e\x80-\xff]/.test(raw)) {
      throw invalid(
        'ci_headers',
        `The value of ${name} has a character that can't be sent in a header`,
      );
    }

    clean[name] = raw;
  }

  return clean;
}

/** The CI job URL must be a public https address. */
export async function checkCiUrl(value: string): Promise<string> {
  if (value.length > AUTOMATION_LIMITS.ciUrl)
    throw invalid('ci_url', 'The URL is too long');

  try {
    await assertPublicHttpUrl(value);
  } catch (error) {
    // The guard has no error code; its DNS failure is told apart by message.
    if (
      error instanceof Error &&
      error.message.endsWith('could not be resolved')
    ) {
      throw invalid(
        'ci_url',
        'This address could not be found. Check the host name of the CI tool',
      );
    }

    throw invalid(
      'ci_url',
      'Use a public https URL without a user name or password',
    );
  }

  return value;
}

/** A workflow file name; it becomes part of the address the token is sent to. */
/** Whether a setting could be saved with this file name. */
export function isWorkflowFileName(value: string): boolean {
  try {
    checkWorkflowFile(value);

    return true;
  } catch {
    return false;
  }
}

/** Only what the app can check without a YAML parser: the size, and that the workflow can be started. */
export function checkWorkflowContent(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > WORKFLOW_CONTENT_BYTES) {
    throw invalid('content', 'The workflow file is too long');
  }

  const startable = value
    .split('\n')
    .some(
      (line) =>
        !line.trimStart().startsWith('#') && line.includes('workflow_dispatch'),
    );

  if (!startable) {
    throw invalid(
      'content',
      'The workflow needs workflow_dispatch, so it can be started from here',
    );
  }

  return value;
}

export function checkWorkflowFile(value: string): string {
  if (!/^[\w.-]+\.ya?ml$/.test(value) || value.length > 255) {
    throw invalid(
      'ci_workflow',
      'Enter the workflow file name, such as tests.yml',
    );
  }

  return value;
}

/** Values a started workflow receives; the names are the workflow's own inputs. */
export function checkCiInputs(
  value: Record<string, unknown>,
): Record<string, string> {
  const clean: Record<string, string> = {};

  for (const [name, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][\w-]{0,99}$/.test(name)) {
      throw invalid('ci_inputs', `The input name ${name} is not allowed`);
    }

    if (typeof raw !== 'string') {
      throw invalid('ci_inputs', `The input ${name} must be text`);
    }

    clean[name] = raw;
  }

  return clean;
}

/** Fills {name} placeholders with JSON-escaped values, so a key can never break the JSON body. */
export function renderTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(
    /\{(executionKey|executionId|planKey|planId|spaceKey|spaceId|runId|baseUrl|testKeys)\}/g,
    (_, name: string) => JSON.stringify(values[name] ?? '').slice(1, -1),
  );
}

/** A git repository must be a public https URL without a user name or password in it. */
export async function checkRepoUrl(value: string): Promise<string> {
  if (value.length > AUTOMATION_LIMITS.repoUrl)
    throw invalid('repo_url', 'The repository URL is too long');

  try {
    await assertPublicHttpUrl(value);
  } catch {
    throw invalid(
      'repo_url',
      'Use a public https repository URL without a user name or password',
    );
  }

  return value;
}

/** A path inside the project; it can never point outside the run folder. */
export function checkRelativePath(field: string, value: string): string {
  const parts = value.split('/');

  if (
    value.length === 0 ||
    value.length > AUTOMATION_LIMITS.resultPath ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    /^[A-Za-z]:/.test(value) ||
    parts.includes('..')
  ) {
    throw invalid(
      field,
      'Use a path inside the project, such as reports/results.xml',
    );
  }

  return value;
}

/** A new file in a setting's zip. Stricter than a result path, because these names can end up as command arguments. */
export function checkFilePath(value: string): string {
  if (
    value.length > AUTOMATION_LIMITS.filePath ||
    !/^[A-Za-z0-9._/-]+$/.test(value) ||
    value.startsWith('-') ||
    value.includes('..') ||
    value.split('/').some((part) => part === '' || part === '.')
  ) {
    throw invalid(
      'path',
      'Use a relative path of letters, digits, . _ / and -, such as tests/login.spec.ts',
    );
  }

  return value;
}

/** The test files one run is limited to: same rule as a new file in a zip, one copy of each, in a fixed order. */
export function checkSpecFiles(value: string[]): string[] {
  const files = [...new Set(value.map((path) => checkFilePath(path)))].sort();

  if (
    Buffer.byteLength(files.join(',')) > AUTOMATION_LIMITS.specFilesBytes ||
    files.length > AUTOMATION_LIMITS.specFiles
  ) {
    throw invalid(
      'spec_files',
      'Too many test files were selected. Select fewer, or run all tests',
    );
  }

  return files;
}

/** ./a//b/ and a/b name the same place. */
export function cleanProjectPath(value: string): string {
  return value
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/');
}

const SPEC_FILE_PATTERNS: Record<Exclude<RunPreset, 'custom'>, RegExp> = {
  playwright: /\.(spec|test)\.[^/]+$/,
  cypress: /\.(cy|spec|test)\.[^/]+$/,
  pytest: /(^|\/)(test_[^/]*|[^/]*_test)\.py$/,
  // Surefire's default class names: Test*, *Test, *Tests and *TestCase.
  maven: /(^|\/)(Test[^/]*|[^/]*(Test|Tests|TestCase))\.(java|kt)$/,
  jest: /(\.(spec|test)\.[cm]?[jt]sx?|(^|\/)__tests__\/[^/]+\.[cm]?[jt]sx?)$/,
  vitest: /\.(spec|test)\.[cm]?[jt]sx?$/,
  mocha: /(\.(spec|test)\.[cm]?[jt]sx?|(^|\/)test\/[^/]+\.[cm]?[jt]sx?)$/,
  // The files of the default node --test glob; it can't run JSX.
  'node-test': /\.(spec|test)\.[cm]?[jt]s$/,
  // Any file one of the Node.js frameworks or Maven would run, until the framework is known.
  auto: /(\.(cy|spec|test)\.[^/]+|(^|\/)(__tests__|test)\/[^/]+\.[cm]?[jt]sx?)$|(^|\/)(Test[^/]*|[^/]*(Test|Tests|TestCase))\.(java|kt)$/,
};

function isSpecPath(path: string): boolean {
  try {
    checkFilePath(path);

    return true;
  } catch {
    return false;
  }
}

/**
 * What a run can be limited to, relative to the tests folder, because that is where the tests start. Dot files and
 * installed packages are never offered, and names outside the path rule can't be selected.
 */
export function specFilesIn(
  names: string[],
  preset: RunPreset,
  workDir: string | null,
): string[] {
  const folder = cleanProjectPath(workDir ?? '');
  const prefix = folder ? `${folder}/` : '';
  const files = names
    .map(cleanProjectPath)
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length))
    .filter(
      (name) =>
        !name
          .split('/')
          .some((part) => part.startsWith('.') || part === 'node_modules') &&
        isSpecPath(name) &&
        (preset === 'custom' || SPEC_FILE_PATTERNS[preset].test(name)),
    );

  return [...new Set(files)];
}

/** Plain variables and secrets share the same name rules. */
export function checkEnv(
  field: string,
  value: Record<string, unknown>,
): Record<string, string> {
  const entries = Object.entries(value);

  if (entries.length > AUTOMATION_LIMITS.envEntries) {
    throw invalid(
      field,
      `At most ${AUTOMATION_LIMITS.envEntries} variables are allowed`,
    );
  }

  const clean: Record<string, string> = {};

  for (const [key, raw] of entries) {
    if (
      !ENV_KEY_PATTERN.test(key) ||
      RESERVED_ENV.has(key) ||
      key.startsWith('XISUITE_')
    ) {
      throw invalid(field, `The variable name ${key} is not allowed`);
    }

    if (
      typeof raw !== 'string' ||
      raw.length > AUTOMATION_LIMITS.envValue ||
      raw.includes('\0')
    ) {
      throw invalid(
        field,
        `The value of ${key} must be text of at most ${AUTOMATION_LIMITS.envValue} characters`,
      );
    }

    // Containers read these from a file with one value per line.
    if (/[\r\n]/.test(raw)) {
      throw invalid(
        field,
        `The value of ${key} cannot have line breaks; encode it as base64`,
      );
    }

    // The log mask skips anything shorter, so it would show in logs.
    if (field === 'secrets' && raw.length < MIN_SECRET_LENGTH) {
      throw invalid(
        field,
        `The secret ${key} must have at least ${MIN_SECRET_LENGTH} characters`,
      );
    }

    clean[key] = raw;
  }

  return clean;
}

/** Public hosts the tests may reach; private ones are only ever set by the server operator. */
export async function checkHosts(value: string[]): Promise<string[]> {
  if (value.length > AUTOMATION_LIMITS.hosts) {
    throw invalid(
      'allowed_hosts',
      `At most ${AUTOMATION_LIMITS.hosts} hosts are allowed`,
    );
  }

  const hosts = [...new Set(value.map((host) => host.trim().toLowerCase()))];

  for (const host of hosts) {
    if (!HOST_PATTERN.test(host))
      throw invalid('allowed_hosts', `${host} is not a host name`);

    const port = Number(host.split(':')[1] ?? 443);

    if (port < 1 || port > 65535)
      throw invalid('allowed_hosts', `${host} has a port outside 1 to 65535`);

    try {
      await assertPublicHttpUrl(`https://${host}`);
    } catch {
      throw invalid('allowed_hosts', `${host} is not a public host`);
    }
  }

  return hosts;
}

export interface RunnerImage {
  key: string;
  image: string;
}

/**
 * Images the server operator allows, from TM_RUNNER_IMAGES as JSON ({"playwright-1.62": "repo@sha256:…"}).
 * Only images pinned by digest are offered; anything else in the setting is ignored.
 */
export function runnerImages(
  raw = process.env.TM_RUNNER_IMAGES,
): RunnerImage[] {
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return [];

    return Object.entries(parsed as Record<string, unknown>)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' &&
          /@sha256:[0-9a-f]{64}$/.test(entry[1]),
      )
      .filter(([key]) => /^[a-z0-9][a-z0-9._-]{0,99}$/.test(key))
      .map(([key, image]) => ({ key, image }));
  } catch {
    return [];
  }
}

// Dockerfile stages built on the runner machine (docker compose --profile tm-runner-images build), so they need no
// line in the server settings.
const BUILT_IN_RUNNER_IMAGES: RunnerImage[] = [
  { key: 'playwright', image: 'xis-tm-runner-playwright:latest' },
  { key: 'cypress-15', image: 'xis-tm-runner-cypress:latest' },
  { key: 'node-24', image: 'xis-tm-runner-node:latest' },
  { key: 'maven-3.9-java21', image: 'xis-tm-runner-junit:latest' },
];

// Read from the built images, for the form; change together with their Dockerfile stages.
const BUILT_IN_RUNTIMES: Record<string, { language: string; version: string }> =
  {
    'xis-tm-runner-playwright:latest': {
      language: 'Node.js',
      version: '24 (Playwright 1.62)',
    },
    'xis-tm-runner-cypress:latest': {
      language: 'Node.js',
      version: '24 (Cypress 15.5)',
    },
    'xis-tm-runner-node:latest': {
      language: 'Node.js',
      version: '24 (Jest, Vitest, Mocha)',
    },
    'xis-tm-runner-junit:latest': {
      language: 'Java',
      version: '21 (Maven 3.9)',
    },
  };

/** Nothing for the operator's own images, because only their owner knows what is in them. */
export function runnerRuntime(
  image: string,
): { language: string; version: string } | undefined {
  return BUILT_IN_RUNTIMES[image];
}

export function isBuiltInRunnerImage(image: string): boolean {
  return BUILT_IN_RUNNER_IMAGES.some((item) => item.image === image);
}

/** What runs can use: the operator's list, then built-in images while the runner is on. The operator's key wins. */
export function availableRunnerImages(): RunnerImage[] {
  const configured = runnerImages();

  if (!runnerEnabled()) return configured;

  return [
    ...configured,
    ...BUILT_IN_RUNNER_IMAGES.filter(
      ({ key }) => !configured.some((item) => item.key === key),
    ),
  ];
}

export function runnerEnabled(): boolean {
  return process.env.TM_RUNNER_ENABLED === '1';
}
