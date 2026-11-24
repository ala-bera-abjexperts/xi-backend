import type { ResultFormat } from '../../dto/test-transfer.dto';
import { fileError } from '../shared/transfer-helpers';

type Json = Record<string, unknown>;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16_BOMS = [Buffer.from([0xff, 0xfe]), Buffer.from([0xfe, 0xff])];

const UNKNOWN_MESSAGE =
  'This is not a Cucumber, Behave or Xray JSON report, or a JUnit, TestNG or xUnit XML report.';

// Enough to reach the root element past a long prolog or licence comment.
const SNIFF_BYTES = 64 * 1024;

export const unknownFormat = () =>
  fileError(UNKNOWN_MESSAGE, undefined, 'RESULT_FORMAT_UNKNOWN');

/** True when the file's first element is a JUnit root; a JSON report never starts with '<'. */
export function isJunitXml(buffer: Buffer): boolean {
  const body = buffer.subarray(0, 3).equals(UTF8_BOM)
    ? buffer.subarray(3)
    : buffer;
  const head = body.subarray(0, SNIFF_BYTES).toString('utf8').trimStart();

  if (!head.startsWith('<')) return false;

  const root = /<(?![?!])(?:[\w.-]+:)?([\w.-]+)/.exec(
    head.replace(/<!--[\s\S]*?(-->|$)/g, ''),
  )?.[1];

  return root === 'testsuites' || root === 'testsuite';
}

// Root element of each supported XML report.
const XML_ROOTS: Record<string, ResultFormat> = {
  testsuites: 'junit',
  testsuite: 'junit',
  'testng-results': 'testng',
  assemblies: 'xunit',
  assembly: 'xunit',
};

const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

/** Format of an XML result report from its root element, or null when it is not one we read. */
export function detectXmlFormat(buffer: Buffer): ResultFormat | null {
  const head = buffer
    .subarray(0, SNIFF_BYTES)
    .toString('utf8')
    .replace(BOM, '')
    .replace(/<!--[\s\S]*?(-->|$)/g, '');

  // A JSON report may quote XML inside a string.
  if (!head.trimStart().startsWith('<')) return null;

  const root = /<(?![?!])(?:[\w.-]+:)?([\w.-]+)/.exec(head);

  return root && Object.hasOwn(XML_ROOTS, root[1]) ? XML_ROOTS[root[1]] : null;
}

/** Format of a JSON result file: an object with tests is Xray JSON, a list of features is Cucumber or Behave. */
export function detectJsonFormat(buffer: Buffer): ResultFormat | null {
  const head = buffer
    .subarray(0, SNIFF_BYTES)
    .toString('utf8')
    .replace(BOM, '');
  const first = head.trimStart()[0];

  if (first === '{') {
    if (!/"tests"\s*:/.test(head)) return null;

    // Other reports, such as Playwright's, nest a "tests" key; Xray has it at the top.
    try {
      const parsed: unknown = JSON.parse(
        buffer.toString('utf8').replace(BOM, ''),
      );

      return typeof parsed === 'object' && parsed !== null && 'tests' in parsed
        ? 'xray'
        : null;
    } catch {
      // Broken JSON still reaches the Xray parser, which says what is wrong.
      return 'xray';
    }
  }

  if (first !== '[') return null;

  try {
    return formatOf(readReport(buffer));
  } catch {
    return null;
  }
}

/** A report's bytes as text; empty files, other encodings and binary files are refused. */
export function decodeReport(buffer: Buffer): string {
  if (!buffer || buffer.length === 0) {
    throw fileError('The file is empty', undefined, 'RESULT_EMPTY');
  }

  const head = buffer.subarray(0, 2);

  // PowerShell's > writes UTF-16, which is otherwise only a confusing "not JSON".
  if (UTF16_BOMS.some((bom) => head.equals(bom))) {
    throw fileError(
      'The report must be saved as UTF-8',
      undefined,
      'RESULT_NOT_UTF8',
    );
  }

  if (buffer.includes(0)) throw unknownFormat();

  const body = buffer.subarray(0, 3).equals(UTF8_BOM)
    ? buffer.subarray(3)
    : buffer;

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw fileError(
      'The report must be saved as UTF-8',
      undefined,
      'RESULT_NOT_UTF8',
    );
  }
}

/** Reads a report's bytes into its list of features; anything else is refused with a reason a person can act on. */
export function readReport(buffer: Buffer): Json[] {
  const text = decodeReport(buffer);
  let root: unknown;

  try {
    root = JSON.parse(text);
  } catch {
    // A list that stops early was probably cut off; other text is another format, such as XML.
    if (text.trimStart().startsWith('[')) {
      throw fileError(
        'The report is not valid JSON, so it may be cut off',
        undefined,
        'RESULT_NOT_JSON',
      );
    }

    throw unknownFormat();
  }

  if (!Array.isArray(root)) throw unknownFormat();

  if (root.length === 0) {
    throw fileError(
      'The report has no features',
      undefined,
      'RESULT_NO_FEATURES',
    );
  }

  const isFeature = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  if (!root.every(isFeature) || !root.some((f) => Array.isArray(f.elements))) {
    throw unknownFormat();
  }

  return root;
}

/** Decided from the parsed report, so it does not depend on the order a tool writes its keys in. */
export function formatOf(features: Json[]): ResultFormat {
  const [first] = features;

  return typeof first.uri !== 'string' && typeof first.location === 'string'
    ? 'behave'
    : 'cucumber';
}
