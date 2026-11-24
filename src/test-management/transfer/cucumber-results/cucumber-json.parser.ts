import {
  TEST_TRANSFER_LIMITS,
  type JunitStatus,
  type JunitTestcase,
  type ResultFormat,
  type TransferIssue,
} from '../../dto/test-transfer.dto';
import { scenarioKeys } from '../gherkin/gherkin.util';
import { fileError } from '../shared/transfer-helpers';
import { formatOf, readReport } from './result-format';

type Json = Record<string, unknown>;

export interface EvidenceFile {
  name: string;
  data: Buffer;
}

export interface ParsedJunit {
  // Scenarios in the file, before outline rows are rolled up.
  testcases: number;
  items: JunitTestcase[];
  invalid: TransferIssue[];
  warnings: TransferIssue[];

  // Evidence bytes by test key; only filled when asked for, so a preview never holds them.
  evidence?: Map<string, EvidenceFile[]>;

  // Xray JSON only: the execution the file names and the details it gives a new one.
  xray?: XrayFileInfo;
}

export interface XrayFileInfo {
  execution_key?: string;
  summary?: string;
  description?: string;
  version?: string;
  revision?: string;
  test_plan_key?: string;
  test_environments?: string[];
}

interface ScenarioResult {
  name: string;
  status: JunitStatus;
  duration: number | null;
  message: string | null;
  files: EvidenceFile[];
}

interface FoundScenario {
  element: Json;
  runs: Json[];
  featureTags: string[];
  featureId: string;
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const objects = (value: unknown): Json[] => list(value).filter(isObject);

// Control characters a Postgres text column refuses (NUL) or a screen cannot show.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const EXTENSIONS = new Map<string, string>([
  ['jpeg', 'jpg'],
  ['plain', 'txt'],
  ['xcucumberl', 'txt'],
]);
const MAX_ITERATIONS = 1000;

/** Cuts text without leaving half of an emoji, which the database refuses in JSON. */
export function cutText(text: string, max: number): string {
  const cut = text.slice(0, max);

  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function cleanMessage(
  value: string | null | undefined,
  max: number = TEST_TRANSFER_LIMITS.junitMessage,
): string | null {
  const cleaned = (value ?? '').replace(CONTROL, '').trim();

  return cleaned === '' ? null : cutText(cleaned, max);
}

export function evidenceFile(
  rawName: string,
  rawData: string,
  row: number,
  name: string,
  warnings: TransferIssue[],
): EvidenceFile | null {
  const fileName = (rawName.split(/[\\/]/).pop() ?? '')
    .replace(CONTROL, '')
    .trim()
    .slice(0, 255);
  const encoded = rawData.replace(/\s+/g, '');
  const data =
    encoded !== '' && encoded.length % 4 === 0 && BASE64.test(encoded)
      ? Buffer.from(encoded, 'base64')
      : null;

  if (fileName === '' || !data || data.length === 0) {
    warnings.push({
      row,
      code: 'EVIDENCE_INVALID',
      message: `An evidence file of ${name} is missing a name or is not valid base64`,
      value: name,
    });

    return null;
  }

  return { name: fileName, data };
}

// Cucumber tags are objects with an '@' name, Behave tags are plain strings.
const tagsOf = (value: unknown): string[] =>
  list(value)
    .map((t) => (isObject(t) ? text(t.name) : text(t)).trim().replace(/^@/, ''))
    .filter((t) => t !== '');

const isBackground = (element: Json): boolean =>
  [element.type, element.keyword].some(
    (v) => text(v).trim().toLowerCase() === 'background',
  );

// Hooks and steps in the order they ran; a step's own hooks sit around it.
const runsOf = (element: Json): Json[] => [
  ...objects(element.before),
  ...objects(element.steps).flatMap((step) => [
    ...objects(step.before),
    step,
    ...objects(step.after),
  ]),
  ...objects(element.after),
];

const errorText = (value: unknown): string =>
  Array.isArray(value) ? value.map(text).join('\n') : text(value);

function extensionOf(mime: string): string {
  const sub = (mime.split('/')[1] ?? '')
    .split(/[;+]/)[0]
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10);

  return EXTENSIONS.get(sub) ?? (sub || 'bin');
}

// Plain words can also be valid base64, so text only counts as encoded when it decodes to readable text.
function isEncodedText(compact: string): boolean {
  if (compact === '' || compact.length % 4 !== 0 || !BASE64.test(compact)) {
    return false;
  }

  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(compact, 'base64'),
    );

    return decoded.replace(CONTROL, '') === decoded;
  } catch {
    return false;
  }
}

function embeddedFile(
  embedding: Json,
  n: number,
  row: number,
  name: string,
  warnings: TransferIssue[],
): EvidenceFile | null {
  const mime = (
    text(embedding.mime_type) ||
    (isObject(embedding.media) ? text(embedding.media.type) : '')
  )
    .trim()
    .toLowerCase();
  const raw = text(embedding.data);
  const data =
    mime.startsWith('text/') && !isEncodedText(raw.replace(/[\r\n]/g, ''))
      ? Buffer.from(raw, 'utf8').toString('base64')
      : raw;

  return evidenceFile(
    `step-${n}.${extensionOf(mime)}`,
    data,
    row,
    name,
    warnings,
  );
}

// Ambiguous steps and Behave errors fail the scenario, as the runners themselves treat them.
const FAILED_STEPS = new Set([
  'failed',
  'ambiguous',
  'error',
  'hook_error',
  'cleanup_error',
]);
const KNOWN_STEPS = new Set([
  ...FAILED_STEPS,
  'passed',
  'skipped',
  'untested',
  'undefined',
  'pending',
]);

function resultOf(
  found: FoundScenario,
  perSecond: number,
  firstFile: number,
  row: number,
  name: string,
  warnings: TransferIssue[],
): ScenarioResult {
  const statuses: string[] = [];
  const files: EvidenceFile[] = [];
  let duration: number | null = null;
  let message: string | null = null;

  for (const run of found.runs) {
    const result: Json = isObject(run.result) ? run.result : {};
    const status = text(result.status).trim().toLowerCase() || 'missing';

    statuses.push(status);

    if (
      typeof result.duration === 'number' &&
      Number.isFinite(result.duration) &&
      result.duration >= 0
    ) {
      duration = (duration ?? 0) + result.duration / perSecond;
    }

    if (FAILED_STEPS.has(status) && message === null) {
      message = cleanMessage(errorText(result.error_message));
    }

    for (const embedding of objects(run.embeddings)) {
      const file = embeddedFile(
        embedding,
        firstFile + files.length + 1,
        row,
        name,
        warnings,
      );

      if (file) files.push(file);
    }
  }

  // Behave also writes the scenario's own status, which catches hook errors.
  if (typeof found.element.status === 'string') {
    statuses.push(found.element.status.trim().toLowerCase());
  }

  const status: JunitStatus = statuses.some((s) => FAILED_STEPS.has(s))
    ? 'FAIL'
    : statuses.length > 0 && statuses.every((s) => s === 'passed')
      ? 'PASS'
      : 'SKIPPED';

  if (status === 'SKIPPED') {
    if (statuses.some((s) => s === 'undefined' || s === 'pending')) {
      warnings.push({
        row,
        code: 'STEP_NOT_IMPLEMENTED',
        message: `${name}: a step is undefined or pending, so no result was recorded`,
        value: name,
      });
    } else if (
      statuses.length === 0 ||
      statuses.some((s) => !KNOWN_STEPS.has(s))
    ) {
      warnings.push({
        row,
        code: 'NO_RESULT',
        message: `${name}: the report has no usable result for this scenario`,
        value: name,
      });
    }
  }

  return { name, status, duration, message, files };
}

// Outline examples share a key: any failure fails the test, and a skipped example does not undo the passes.
function rollUp(
  key: string,
  results: ScenarioResult[],
  warnings: TransferIssue[],
  row: number,
): JunitTestcase {
  const statuses = results.map((r) => r.status);
  const durations = results
    .map((r) => r.duration)
    .filter((d): d is number => d !== null);
  const messages = results
    .map((r) => r.message)
    .filter((m): m is string => m !== null);
  const files = results.flatMap((r) => r.files);
  const passed = statuses.includes('PASS');
  const item: JunitTestcase = {
    name: key,
    classname: '',
    status: statuses.includes('FAIL') ? 'FAIL' : passed ? 'PASS' : 'SKIPPED',
    duration_seconds:
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) : null,
    message: cleanMessage(messages.join('\n')),
    merged: results.length,
    test_key: key,
  };

  if (results.length > 1) {
    item.iterations = results
      .slice(0, MAX_ITERATIONS)
      .map(({ status, name }) => ({ status, name }));

    if (results.length > MAX_ITERATIONS) {
      warnings.push({
        row,
        code: 'ITERATIONS_TRUNCATED',
        message: `${key}: only the first ${MAX_ITERATIONS} of ${results.length} examples are shown; the result counts all of them`,
        value: key,
      });
    }

    if (item.status === 'PASS' && statuses.includes('SKIPPED')) {
      warnings.push({
        row,
        code: 'EXAMPLES_SKIPPED',
        message: `${key}: some examples were skipped, so the result only reflects the ones that ran`,
        value: key,
      });
    }
  }

  if (files.length > 0) {
    item.evidence = files.map((f) => ({ name: f.name, size: f.data.length }));
  }

  return item;
}

// A retry repeats a scenario exactly. Outline examples differ by line, or else by the text of their steps.
function attemptOf(scenario: FoundScenario, row: number): string {
  const line = scenario.element.line;

  if (typeof line !== 'number') return `row:${row}`;

  const steps = objects(scenario.element.steps).map((s) => text(s.name));

  return JSON.stringify([
    scenario.featureId,
    line,
    text(scenario.element.name),
    steps,
  ]);
}

function scenariosOf(features: Json[]): FoundScenario[] {
  const found: FoundScenario[] = [];

  for (const feature of features) {
    const featureTags = tagsOf(feature.tags);
    const featureId = text(feature.uri) || text(feature.location);

    const walk = (elements: Json[], nested: boolean) => {
      let background: Json[] = [];

      for (const element of elements) {
        if (isBackground(element)) {
          background = runsOf(element);
          continue;
        }

        // Rules hold their own scenarios and cannot nest further.
        if (!nested && Array.isArray(element.elements)) {
          walk(objects(element.elements), true);
          continue;
        }

        // Cucumber writes the background before each scenario; it belongs to the next one.
        found.push({
          element,
          runs: [...background, ...runsOf(element)],
          featureTags,
          featureId,
        });
        background = [];
      }
    };

    walk(objects(feature.elements), false);
  }

  return found;
}

const isTestTag = (tag: string) => /^test_/i.test(tag);

/** Scenario results of a Cucumber or Behave JSON report, matched to existing tests by their key tags. */
export function parseResultReport(
  buffer: Buffer,
  options: { keepEvidence?: boolean; format?: ResultFormat } = {},
): ParsedJunit & { format: ResultFormat } {
  const features = readReport(buffer);
  const format = options.format ?? formatOf(features);

  // Step durations are nanoseconds in Cucumber reports and seconds in Behave ones.
  const perSecond = format === 'behave' ? 1 : 1e9;
  const found = scenariosOf(features);
  const max = TEST_TRANSFER_LIMITS.junitTestcases;

  if (found.length > max) {
    throw fileError(
      `The report has more than ${max} scenarios`,
      { scenarios: found.length, max },
      'RESULT_TOO_MANY',
    );
  }

  const invalid: TransferIssue[] = [];
  const warnings: TransferIssue[] = [];
  const groups = new Map<string, Map<string, ScenarioResult>>();
  const fileCounts = new Map<string, number>();

  found.forEach((scenario, index) => {
    const row = index + 1;
    const name =
      cleanMessage(text(scenario.element.name), 255) ?? `Scenario ${row}`;

    // Reports copy feature tags onto each scenario, so those say nothing about the scenario itself.
    const inherited = new Set(scenario.featureTags);
    const { testKeys } = scenarioKeys(
      tagsOf(scenario.element.tags).filter((t) => !inherited.has(t)),
    );
    const featureKeys = scenarioKeys(
      scenario.featureTags.filter(isTestTag),
    ).testKeys;

    if (featureKeys.length > 0) {
      invalid.push({
        row,
        code: 'FEATURE_TEST_KEY',
        message: `${name}: the feature has a test key tag; put test keys on scenarios`,
        value: featureKeys.join(', '),
      });

      return;
    }

    if (testKeys.length > 1) {
      invalid.push({
        row,
        code: 'TEST_KEY_CONFLICT',
        message: `${name}: the scenario names more than one test: ${testKeys.join(', ')}`,
        value: testKeys.join(', '),
      });

      return;
    }

    if (testKeys.length === 0) {
      invalid.push({
        row,
        code: 'NO_TEST_KEY',
        message: `${name}: no test key tag; results are only recorded for existing tests`,
        value: name,
      });

      return;
    }

    const key = testKeys[0];
    const firstFile = fileCounts.get(key) ?? 0;
    const result = resultOf(
      scenario,
      perSecond,
      firstFile,
      row,
      name,
      warnings,
    );
    const group = groups.get(key) ?? new Map<string, ScenarioResult>();

    // The last attempt of a retried scenario is the one that counts.
    group.set(attemptOf(scenario, row), result);
    groups.set(key, group);
    fileCounts.set(key, firstFile + result.files.length);
  });

  const items: JunitTestcase[] = [];
  const evidence = new Map<string, EvidenceFile[]>();

  for (const [key, group] of groups) {
    const results = [...group.values()];
    const item = rollUp(key, results, warnings, items.length + 1);
    const files = results.flatMap((r) => r.files);

    if (options.keepEvidence && files.length > 0) evidence.set(key, files);

    items.push(item);
  }

  return {
    format,
    testcases: found.length,
    items,
    invalid,
    warnings,
    ...(options.keepEvidence ? { evidence } : {}),
  };
}
