import { DOMParser } from '@xmldom/xmldom';

import {
  TEST_TRANSFER_LIMITS,
  type JunitStatus,
  type JunitTestcase,
  type ResultFormat,
  type ResultIteration,
  type TransferIssue,
} from '../../dto/test-transfer.dto';
import { scenarioKeys } from '../gherkin/gherkin.util';
import { fileError } from '../shared/transfer-helpers';
import {
  cleanMessage,
  cutText,
  parseResultReport,
  type EvidenceFile,
  type ParsedJunit,
} from './cucumber-json.parser';
import {
  decodeReport,
  detectJsonFormat,
  detectXmlFormat,
  isJunitXml,
  unknownFormat,
} from './result-format';
import { parseTestng } from './testng.parser';
import { parseXrayJson } from './xray-json.parser';
import { parseXunit } from './xunit.parser';

export const ELEMENT = 1;
const TIME = /^\d+(\.\d+)?$/;
const TESTCASE = /<([\w.-]+:)?testcase[\s/>]/g;
const CDATA = /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g;
const ISSUE_KEY = /^[A-Z0-9][A-Z0-9_]*-[A-Z]{0,4}\d+$/;

// The database function refuses a whole upload past these.
const MAX_ROWS = 1000;
const MAX_ITERATION_BYTES = 20000;

const dtdRefused = (label = 'JUnit') =>
  fileError(
    `${label} files with a DOCTYPE or ENTITY are not accepted`,
    undefined,
    'RESULT_XML_DTD',
  );

export interface XmlCheck {
  // Name used in messages, such as "JUnit" or "TestNG".
  label: string;

  // Counts the tests before parsing, so a huge file is refused early.
  count: RegExp;
}

const JUNIT_CHECK: XmlCheck = { label: 'JUnit', count: TESTCASE };

export interface XmlNode {
  nodeType: number;
  localName?: string | null;
  childNodes?: ArrayLike<XmlNode>;
  textContent?: string | null;
  getAttribute?: (name: string) => string | null;
}

export const elements = (node: XmlNode): XmlNode[] =>
  Array.from(node.childNodes ?? []).filter((n) => n.nodeType === ELEMENT);

/** Refuses anything that is not plain UTF-8 XML without a DTD, before the parser sees it. */
export function checkJunitBytes(
  buffer: Buffer,
  check: XmlCheck = JUNIT_CHECK,
): string {
  const junit = check === JUNIT_CHECK;
  const text = decodeReport(buffer);

  // Also refuses gzip and zip uploads, whose first character is never '<'.
  if (!text.trimStart().startsWith('<')) {
    throw junit ? unknownFormat() : formatMismatch(`a ${check.label} XML file`);
  }

  // A failure message may quote a whole web page; parseXml still refuses a real DOCTYPE.
  if (/<!DOCTYPE|<!ENTITY/i.test(text.replace(CDATA, ''))) {
    throw dtdRefused(check.label);
  }

  const count = text.match(check.count)?.length ?? 0;
  const max = TEST_TRANSFER_LIMITS.junitTestcases;

  if (count > max) {
    throw fileError(
      `The file has more than ${max} tests`,
      { testcases: count, max },
      junit ? 'RESULT_TOO_MANY_TESTS' : 'RESULT_TOO_MANY',
    );
  }

  return text;
}

/** The file is not the report its parser reads, such as a JSON file sent as TestNG. */
export const formatMismatch = (what: string) =>
  fileError(`The file is not ${what}`, undefined, 'RESULT_FORMAT_MISMATCH');

/** A report that holds no test at all. */
export const noTests = (label: string) =>
  fileError(`The ${label} report has no tests`, undefined, 'RESULT_EMPTY');

export function parseXml(text: string, label = 'JUnit'): XmlNode {
  const fail = (message: string) => {
    throw fileError(
      `The ${label} file is not well-formed XML`,
      { detail: message.split('\n')[0].slice(0, 200) },
      'RESULT_XML_INVALID',
    );
  };
  let root: XmlNode | null = null;

  try {
    const doc = new DOMParser({
      errorHandler: { warning: fail, error: fail, fatalError: fail },
    }).parseFromString(text, 'text/xml');

    if (doc.doctype) throw dtdRefused(label);

    root = doc.documentElement as unknown as XmlNode | null;
  } catch (error) {
    if (error instanceof Error && 'getResponse' in error) throw error;

    fail(error instanceof Error ? error.message : 'parse error');
  }

  if (!root) fail('no root element');

  return root as XmlNode;
}

function statusOf(testcase: XmlNode): {
  status: JunitStatus;
  message: string | null;
} {
  const children = elements(testcase);
  const failed = children.find(
    (c) => c.localName === 'failure' || c.localName === 'error',
  );

  // A failure or error wins over skipped.
  if (failed) {
    return {
      status: 'FAIL',
      message: cleanMessage(
        failed.getAttribute?.('message') || failed.textContent,
      ),
    };
  }

  const skipped = children.find((c) => c.localName === 'skipped');

  if (skipped) {
    return {
      status: 'SKIPPED',
      message: cleanMessage(skipped.getAttribute?.('message')),
    };
  }

  return { status: 'PASS', message: null };
}

// Only the testcase's own properties count; suite properties are left alone.
function testKeyOf(
  testcase: XmlNode,
  name: string,
  row: number,
  warnings: TransferIssue[],
): string | undefined {
  const properties = elements(testcase)
    .filter((c) => c.localName === 'properties')
    .flatMap(elements)
    .filter(
      (p) =>
        p.localName === 'property' &&
        p.getAttribute?.('name')?.trim() === 'test_key',
    );
  let testKey: string | undefined;

  for (const property of properties) {
    const raw = property.getAttribute?.('value') || property.textContent || '';
    const key = scenarioKeys([raw.trim().toUpperCase()]).testKey;

    if (key) testKey = key;
    else {
      warnings.push({
        row,
        code: 'KEY_INVALID',
        message: `"${raw.slice(0, 50)}" of ${name} is not a ticket key`,
        value: raw.slice(0, 50),
      });
    }
  }

  return testKey;
}

/** Issue keys from a list, upper-cased; anything that is not a key becomes a warning. */
export function issueKeys(
  values: string[],
  row: number,
  name: string,
  warnings: TransferIssue[],
): string[] {
  const keys = new Set<string>();

  for (const raw of values) {
    const key = raw.trim().toUpperCase();

    if (ISSUE_KEY.test(key)) keys.add(key);
    else {
      warnings.push({
        row,
        code: 'KEY_INVALID',
        message: `"${raw.slice(0, 50)}" of ${name} is not a ticket key`,
        value: raw.slice(0, 50),
      });
    }
  }

  return [...keys];
}

// Union of two optional lists, or nothing when both are absent.
const joined = <K extends 'requirement_keys' | 'labels'>(
  field: K,
  a: string[] | undefined,
  b: string[] | undefined,
) => (a || b ? { [field]: [...new Set([...(a ?? []), ...(b ?? [])])] } : {});

/** Any failure wins, then any pass; times add up and messages are joined. */
export function mergeTestcases(
  a: JunitTestcase,
  b: JunitTestcase,
): JunitTestcase {
  const rank = { FAIL: 3, BLOCKED: 2, PASS: 1, SKIPPED: 0 } as const;
  const status = rank[a.status] >= rank[b.status] ? a.status : b.status;
  const duration =
    a.duration_seconds === null && b.duration_seconds === null
      ? null
      : (a.duration_seconds ?? 0) + (b.duration_seconds ?? 0);
  const messages = [a.message, b.message].filter(
    (m): m is string => m !== null,
  );
  const comments = [a.comment, b.comment].filter((c): c is string => !!c);

  return {
    ...b,
    ...a,
    status,
    duration_seconds: duration,
    message:
      messages.length > 0
        ? cutText(messages.join('\n'), TEST_TRANSFER_LIMITS.junitMessage)
        : null,
    merged: a.merged + b.merged,
    ...joined('requirement_keys', a.requirement_keys, b.requirement_keys),
    ...joined('labels', a.labels, b.labels),
    ...(a.evidence || b.evidence
      ? { evidence: [...(a.evidence ?? []), ...(b.evidence ?? [])] }
      : {}),
    ...(comments.length > 0
      ? {
          comment: cutText(
            comments.join('\n'),
            TEST_TRANSFER_LIMITS.junitMessage,
          ),
        }
      : {}),
    ...(a.iterations || b.iterations
      ? {
          iterations: [...(a.iterations ?? []), ...(b.iterations ?? [])].slice(
            0,
            MAX_ROWS,
          ),
        }
      : {}),
  };
}

// Indented JSON is never shorter than the text the database measures, which adds spaces.
const iterationBytes = (row: ResultIteration) =>
  Buffer.byteLength(JSON.stringify(row, null, 1));

/** Keeps steps and iterations within what the database takes, with a warning for each cut. */
export function limitRows(
  items: JunitTestcase[],
  warnings: TransferIssue[],
): JunitTestcase[] {
  return items.map((item, index) => {
    const row = index + 1;
    const limited = { ...item };

    if (item.steps && item.steps.length > MAX_ROWS) {
      limited.steps = item.steps.slice(0, MAX_ROWS);
      warnings.push({
        row,
        code: 'STEPS_TRIMMED',
        message: `${item.name}: only the first ${MAX_ROWS} of ${item.steps.length} steps are recorded`,
        value: item.name,
      });
    }

    if (item.iterations) {
      const fitting = item.iterations.filter(
        (it) => iterationBytes(it) <= MAX_ITERATION_BYTES,
      );
      const kept = fitting.slice(0, MAX_ROWS);

      if (kept.length < item.iterations.length) {
        limited.iterations = kept;
        warnings.push({
          row,
          code: 'ITERATIONS_TRIMMED',
          message: `${item.name}: ${item.iterations.length - kept.length} of ${item.iterations.length} iterations are too large or past the first ${MAX_ROWS}, so they are not shown`,
          value: item.name,
        });
      }
    }

    return limited;
  });
}

/** Files of one result go under its test key, or its class and name when it has none; files sharing a key add up. */
export function addEvidence(
  evidence: Map<string, EvidenceFile[]>,
  item: Pick<JunitTestcase, 'test_key' | 'classname' | 'name'>,
  files: EvidenceFile[],
): void {
  if (files.length === 0) return;

  const key = item.test_key ?? `${item.classname}\u0000${item.name}`;

  evidence.set(key, [...(evidence.get(key) ?? []), ...files]);
}

/** Tests of a JUnit report, merged by class name and name. */
export function parseJunit(buffer: Buffer): ParsedJunit {
  const root = parseXml(checkJunitBytes(buffer));

  if (root.localName !== 'testsuites' && root.localName !== 'testsuite') {
    throw unknownFormat();
  }

  // Walked without recursion, depth checked before any text is read.
  const found: XmlNode[] = [];
  const stack: [XmlNode, number][] = [[root, 1]];

  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [XmlNode, number];

    if (depth > TEST_TRANSFER_LIMITS.junitDepth) {
      throw fileError(
        `The JUnit file is nested more than ${TEST_TRANSFER_LIMITS.junitDepth} levels deep`,
        undefined,
        'RESULT_XML_TOO_DEEP',
      );
    }

    if (node.localName === 'testcase') {
      found.push(node);
      continue;
    }

    const children = elements(node);

    for (let i = children.length - 1; i >= 0; i--) {
      stack.push([children[i], depth + 1]);
    }
  }

  const invalid: TransferIssue[] = [];
  const warnings: TransferIssue[] = [];
  const merged = new Map<string, JunitTestcase>();

  found.forEach((testcase, index) => {
    const row = index + 1;

    // Kept whole: the length decides whether the name fits an automation key.
    const name = cleanMessage(testcase.getAttribute?.('name'), Infinity) ?? '';
    const classname =
      cleanMessage(testcase.getAttribute?.('classname'), Infinity) ?? '';

    if (name === '') {
      invalid.push({
        row,
        code: 'NAME_MISSING',
        message: 'A test in the report has no name',
      });

      return;
    }

    const rawTime = (testcase.getAttribute?.('time') ?? '').trim();
    let duration: number | null = null;

    if (rawTime !== '') {
      if (TIME.test(rawTime)) duration = Number(rawTime);
      else {
        warnings.push({
          row,
          code: 'TIME_INVALID',
          message: `Time "${rawTime.slice(0, 20)}" of ${name} is ignored`,
          value: name,
        });
      }
    }

    const testKey = testKeyOf(testcase, name, row, warnings);
    // Results with different test keys belong to different tests, whatever their names.
    const key = `${classname}\u0000${name}\u0000${testKey ?? ''}`;
    const earlier = merged.get(key);
    const item: JunitTestcase = {
      name,
      classname,
      ...statusOf(testcase),
      duration_seconds: duration,
      merged: 1,
      ...(testKey ? { test_key: testKey } : {}),
    };

    merged.set(key, earlier ? mergeTestcases(earlier, item) : item);
  });

  return {
    testcases: found.length,
    items: [...merged.values()],
    invalid,
    warnings,
  };
}

type OtherFormat = Exclude<ResultFormat, 'junit' | 'cucumber' | 'behave'>;
type ReportParser = (
  buffer: Buffer,
  options: { keepEvidence?: boolean },
) => ParsedJunit;

const OTHER_FORMATS: readonly ResultFormat[] = [
  'testng',
  'xunit',
  'xray',
] satisfies OtherFormat[];

const isOther = (format: ResultFormat | null): format is OtherFormat =>
  format !== null && OTHER_FORMATS.includes(format);

// Looked up on call: these parsers import this file, so a table built at load could see them unset.
function otherParser(format: OtherFormat): ReportParser {
  const parsers: Record<OtherFormat, ReportParser> = {
    testng: parseTestng,
    xunit: parseXunit,
    xray: parseXrayJson,
  };

  return parsers[format];
}

// A list of features goes the Cucumber way as before, so only an object is sniffed here.
const jsonObjectFormat = (buffer: Buffer): ResultFormat | null =>
  /^\uFEFF?\s*\{/.test(buffer.subarray(0, 64 * 1024).toString('utf8'))
    ? detectJsonFormat(buffer)
    : null;

/** Sends a report to its parser: the requested format, else what the file's head says. */
export function parseResultFile(
  buffer: Buffer,
  options: { keepEvidence?: boolean; format?: ResultFormat } = {},
): ParsedJunit & { format: ResultFormat } {
  // JUnit, Cucumber and Behave keep the way they were always chosen.
  const other = options.format
    ? options.format
    : isJunitXml(buffer)
      ? null
      : (detectXmlFormat(buffer) ?? jsonObjectFormat(buffer));

  if (isOther(other)) {
    return {
      ...otherParser(other)(buffer, { keepEvidence: options.keepEvidence }),
      format: other,
    };
  }

  const junit = options.format
    ? options.format === 'junit'
    : isJunitXml(buffer);

  return junit
    ? { ...parseJunit(buffer), format: 'junit' }
    : parseResultReport(buffer, options);
}
