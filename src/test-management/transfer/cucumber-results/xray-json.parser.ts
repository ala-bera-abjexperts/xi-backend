import {
  TEST_TRANSFER_LIMITS,
  type JunitStatus,
  type JunitTestcase,
  type ResultIteration,
  type ResultStep,
  type TransferIssue,
} from '../../dto/test-transfer.dto';
import { fileError } from '../shared/transfer-helpers';
import {
  cleanMessage,
  evidenceFile,
  type EvidenceFile,
  type ParsedJunit,
  type XrayFileInfo,
} from './cucumber-json.parser';
import {
  addEvidence,
  formatMismatch,
  issueKeys,
  limitRows,
  mergeTestcases,
  noTests,
} from './junit.parser';
import { decodeReport } from './result-format';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] =>
  list(value)
    .map((v) => text(v).trim())
    .filter((v) => v !== '');
const upper = (value: unknown): string => text(value).trim().toUpperCase();

const TEST_STATUS = new Map<string, JunitStatus>([
  ['PASSED', 'PASS'],
  ['PASS', 'PASS'],
  ['FAILED', 'FAIL'],
  ['FAIL', 'FAIL'],
  ['BLOCKED', 'BLOCKED'],
  ['ABORTED', 'BLOCKED'],
  ['TODO', 'SKIPPED'],
  ['EXECUTING', 'SKIPPED'],
]);

const STEP_STATUS = new Map<string, ResultStep['status']>([
  ['PASSED', 'PASS'],
  ['PASS', 'PASS'],
  ['FAILED', 'FAIL'],
  ['FAIL', 'FAIL'],
  ['BLOCKED', 'BLOCKED'],
  ['ABORTED', 'BLOCKED'],
  ['TODO', 'TODO'],
  ['EXECUTING', 'TODO'],
  ['NOT_APPLICABLE', 'NOT_APPLICABLE'],
  ['NA', 'NOT_APPLICABLE'],
]);

// Execution details the upload form sets instead of the file.
const INFO_FIELDS = [
  'summary',
  'description',
  'version',
  'revision',
  'testPlanKey',
  'testEnvironments',
  'user',
  'project',
];

const iterationStatus = (value: unknown): ResultIteration['status'] => {
  const status = TEST_STATUS.get(upper(value));

  return !status || ['TODO', 'EXECUTING'].includes(upper(value))
    ? 'TODO'
    : status;
};

// One row per data-driven iteration or outline example, in file order.
function iterationRows(
  iterations: unknown[],
  examples: unknown[],
): ResultIteration[] {
  const rows = iterations.map((entry): ResultIteration => {
    const iteration: Json = isObject(entry) ? entry : {};
    const row: ResultIteration = { status: iterationStatus(iteration.status) };
    const name = cleanMessage(text(iteration.name), 255);
    const comment = cleanMessage(text(iteration.log), 1000);
    const parameters = list(iteration.parameters)
      .filter(isObject)
      .slice(0, 20)
      .map((p) => ({
        name: cleanMessage(text(p.name), 100) ?? '',
        value: cleanMessage(text(p.value), 500) ?? '',
      }));

    if (name) row.name = name;
    if (parameters.length > 0) row.parameters = parameters;
    if (comment) row.comment = comment;

    return row;
  });

  return [
    ...rows,
    ...examples.map((s): ResultIteration => ({ status: iterationStatus(s) })),
  ];
}

/** Strict UTF-8 JSON; returns the parsed value for the caller to narrow. */
export function checkJsonBytes(buffer: Buffer, label: string): unknown {
  const text = decodeReport(buffer);

  try {
    const value: unknown = JSON.parse(text);

    return value;
  } catch (error) {
    throw fileError(
      `The ${label} file is not valid JSON`,
      {
        detail: (error instanceof Error ? error.message : 'parse error').slice(
          0,
          200,
        ),
      },
      'RESULT_NOT_JSON',
    );
  }
}

function evidenceOf(
  raw: unknown,
  prefix: string,
  row: number,
  name: string,
  warnings: TransferIssue[],
): EvidenceFile[] {
  const files: EvidenceFile[] = [];

  for (const entry of list(raw)) {
    const item: Json = isObject(entry) ? entry : {};
    const file = evidenceFile(
      text(item.filename),
      text(item.data),
      row,
      name,
      warnings,
    );

    // Prefixed after reading, as evidenceFile keeps only the last path segment.
    if (file)
      files.push({ ...file, name: `${prefix}${file.name}`.slice(0, 255) });
  }

  return files;
}

function readTest(
  raw: unknown,
  row: number,
  invalid: TransferIssue[],
  warnings: TransferIssue[],
  ignored: Set<string>,
): { item: JunitTestcase; files: EvidenceFile[] } | null {
  if (!isObject(raw)) {
    invalid.push({
      row,
      code: 'TEST_INVALID',
      message: `Test ${row} is not an object`,
    });

    return null;
  }

  for (const field of ['executedBy', 'assignee', 'customFields']) {
    if (raw[field] !== undefined) ignored.add(field);
  }

  const rawKey = text(raw.testKey).trim();
  const [testKey] =
    rawKey === '' ? [] : issueKeys([rawKey], row, `test ${row}`, warnings);
  const info = isObject(raw.testInfo) ? raw.testInfo : null;

  if (!testKey && !info) {
    invalid.push({
      row,
      code: 'TEST_KEY_MISSING',
      message: `Test ${row} has neither testKey nor testInfo`,
    });

    return null;
  }

  const summary = info ? cleanMessage(text(info.summary), 255) : null;

  if (!testKey && !summary) {
    invalid.push({
      row,
      code: 'SUMMARY_MISSING',
      message: `Test ${row} has no summary in testInfo`,
    });

    return null;
  }

  const steps = list(raw.steps);
  const iterations = list(
    Array.isArray(raw.iterations) ? raw.iterations : raw.results,
  );
  const examples = list(raw.examples);

  if (steps.length > 0 && (iterations.length > 0 || examples.length > 0)) {
    invalid.push({
      row,
      code: 'STRUCTURE_INVALID',
      message: `Test ${row} mixes steps with examples or iterations`,
    });

    return null;
  }

  const rawStatus = text(raw.status).trim();

  if (rawStatus === '') {
    invalid.push({
      row,
      code: 'STATUS_MISSING',
      message: `Test ${row} has no status`,
    });

    return null;
  }

  // A generic test is known by its definition, other new tests by their summary.
  const generic = info ? cleanMessage(text(info.definition), 1000) : null;
  const name = testKey || generic || summary || '';
  const status = TEST_STATUS.get(rawStatus.toUpperCase());

  if (rawStatus.toUpperCase() === 'ABORTED') {
    warnings.push({
      row,
      code: 'STATUS_CHANGED',
      message: `${name}: ABORTED is recorded as BLOCKED`,
    });
  } else if (!status) {
    warnings.push({
      row,
      code: 'STATUS_IGNORED',
      message: `${name}: status "${rawStatus.slice(0, 50)}" is recorded as SKIPPED`,
      value: rawStatus.slice(0, 50),
    });
  }

  const start = text(raw.start).trim().slice(0, 50);
  const finish = text(raw.finish).trim().slice(0, 50);
  const ms = Date.parse(finish) - Date.parse(start);
  const item: JunitTestcase = {
    name,
    classname: '',
    status: status ?? 'SKIPPED',
    duration_seconds: ms >= 0 ? ms / 1000 : null,
    message: null,
    merged: 1,
  };

  if (testKey) item.test_key = testKey;
  if (summary) item.summary = summary;
  if (start !== '') item.started_at = start;
  if (finish !== '') item.finished_at = finish;

  if (info) {
    const testType = cleanMessage(text(info.type), 100);
    const definition = cleanMessage(
      text(info.definition) || text(info.scenario),
      10000,
    );
    const requirementKeys = issueKeys(
      strings(info.requirementKeys),
      row,
      name,
      warnings,
    );
    const labels = [...new Set(strings(info.labels))];

    if (testType) item.test_type = testType;
    if (definition) item.definition = definition;
    if (requirementKeys.length > 0) item.requirement_keys = requirementKeys;
    if (labels.length > 0) item.labels = labels;

    // Steps of a test that does not exist yet are not created by a results import.
    if (!testKey && list(info.steps).length > 0) {
      warnings.push({
        row,
        code: 'STEPS_NOT_CREATED',
        message: `Steps in testInfo of ${name} are not copied to new test cases`,
      });
    }
  }

  const defects = strings(raw.defects);
  const files = evidenceOf(
    raw.evidence ?? raw.evidences,
    '',
    row,
    name,
    warnings,
  );
  const resultSteps: ResultStep[] = [];
  let unknownStep = false;

  steps.forEach((entry, index) => {
    const step: Json = isObject(entry) ? entry : {};
    const stepStatus = STEP_STATUS.get(upper(step.status));

    if (!stepStatus && !unknownStep) {
      unknownStep = true;
      warnings.push({
        row,
        code: 'STATUS_IGNORED',
        message: `${name}: step status "${text(step.status).slice(0, 50)}" is recorded as TODO`,
        value: text(step.status).slice(0, 50),
      });
    }

    defects.push(...strings(step.defects));
    files.push(
      ...evidenceOf(
        step.evidence ?? step.evidences,
        `step-${index + 1}-`,
        row,
        name,
        warnings,
      ),
    );
    resultSteps.push({
      status: stepStatus ?? 'TODO',
      actual_result: cleanMessage(text(step.actualResult), 10000),
      comment: cleanMessage(text(step.comment), 4000),
    });
  });

  const lines = [
    text(raw.comment),
    ...iterations.map((entry, index) => {
      const iteration: Json = isObject(entry) ? entry : {};
      const params = list(iteration.parameters)
        .filter(isObject)
        .map((p) => `${text(p.name)}=${text(p.value)}`)
        .join(', ');

      return `Iteration ${index + 1}${params ? ` (${params})` : ''}: ${upper(iteration.status) || 'TODO'}`;
    }),
    ...examples.map(
      (s, index) => `Example ${index + 1}: ${upper(s) || 'TODO'}`,
    ),
  ];
  const comment = cleanMessage(
    lines.filter((l) => l.trim() !== '').join('\n'),
    TEST_TRANSFER_LIMITS.junitMessage,
  );
  const defectKeys = issueKeys(defects, row, name, warnings);
  const rows = iterationRows(iterations, examples);

  if (comment) item.comment = comment;
  if (resultSteps.length > 0) item.steps = resultSteps;
  if (rows.length > 0) item.iterations = rows;
  if (defectKeys.length > 0) item.defect_keys = defectKeys;
  if (files.length > 0) {
    item.evidence = files.map((f) => ({ name: f.name, size: f.data.length }));
  }

  return { item, files };
}

// The same test twice: merged like JUnit, defects add up, steps stay those of the first.
function mergeXray(a: JunitTestcase, b: JunitTestcase): JunitTestcase {
  const item = mergeTestcases(a, b);
  const defects = [
    ...new Set([...(a.defect_keys ?? []), ...(b.defect_keys ?? [])]),
  ];

  delete item.steps;
  if (a.steps) item.steps = a.steps;
  if (defects.length > 0) item.defect_keys = defects;

  return item;
}

/** Tests of an Xray JSON results file, merged by name like a JUnit report. */
export function parseXrayJson(
  buffer: Buffer,
  options: { keepEvidence?: boolean } = {},
): ParsedJunit {
  const root = checkJsonBytes(buffer, 'Xray JSON');
  const max = TEST_TRANSFER_LIMITS.junitTestcases;

  if (!isObject(root) || !Array.isArray(root.tests)) {
    throw formatMismatch('an Xray JSON results file (no tests)');
  }

  const tests = list(root.tests);

  if (tests.length === 0) throw noTests('Xray JSON');
  if (tests.length > max) {
    throw fileError(
      `The file has more than ${max} tests`,
      { tests: tests.length, max },
      'RESULT_TOO_MANY',
    );
  }

  const invalid: TransferIssue[] = [];
  const warnings: TransferIssue[] = [];
  const ignored = new Set<string>();
  const merged = new Map<string, JunitTestcase>();
  const evidence = new Map<string, EvidenceFile[]>();
  const rawKey = text(root.testExecutionKey).trim();
  const [executionKey] =
    rawKey === '' ? [] : issueKeys([rawKey], 0, 'the test execution', warnings);

  // The results go to the execution the upload names, so the file's own one is only reported.
  if (executionKey) {
    warnings.push({
      row: 0,
      code: 'EXECUTION_KEY_IGNORED',
      message: `The file names ${executionKey}; the results are recorded in the execution of this upload`,
      value: executionKey,
    });
  }

  const details: XrayFileInfo = executionKey
    ? { execution_key: executionKey }
    : {};

  if (isObject(root.info)) {
    const info = root.info;

    INFO_FIELDS.filter((f) => info[f] !== undefined).forEach((f) =>
      ignored.add(`info.${f}`),
    );

    for (const [field, max] of [
      ['summary', 255],
      ['description', 10000],
      ['version', 100],
      ['revision', 100],
    ] as const) {
      const value = cleanMessage(text(info[field]), max);

      if (value) details[field] = value;
    }

    // Only looked up when a new execution is made, so an unknown key is reported there.
    const planKey = upper(info.testPlanKey).slice(0, 100);
    const environments = [...new Set(strings(info.testEnvironments))];

    if (planKey) details.test_plan_key = planKey;
    if (environments.length > 0) details.test_environments = environments;
  }

  tests.forEach((test, index) => {
    const read = readTest(test, index + 1, invalid, warnings, ignored);

    if (!read) return;

    const { item, files } = read;
    const key = `${item.classname}\u0000${item.name}`;
    const earlier = merged.get(key);

    if (options.keepEvidence) addEvidence(evidence, item, files);

    merged.set(key, earlier ? mergeXray(earlier, item) : item);
  });

  if (ignored.size > 0) {
    warnings.push({
      row: 0,
      code: 'FIELD_NOT_STORED',
      message: `These fields of the file are not stored: ${[...ignored].join(', ')}`,
      value: [...ignored].join(', '),
    });
  }

  return {
    testcases: tests.length,
    items: limitRows([...merged.values()], warnings),
    invalid,
    warnings,
    ...(options.keepEvidence ? { evidence } : {}),
    ...(Object.keys(details).length > 0 ? { xray: details } : {}),
  };
}
