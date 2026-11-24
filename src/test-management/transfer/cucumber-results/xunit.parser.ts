import {
  TEST_TRANSFER_LIMITS,
  type JunitStatus,
  type JunitTestcase,
  type TransferIssue,
} from '../../dto/test-transfer.dto';
import { fileError } from '../shared/transfer-helpers';
import {
  cleanMessage,
  type EvidenceFile,
  type ParsedJunit,
} from './cucumber-json.parser';
import {
  checkJunitBytes,
  elements,
  formatMismatch,
  issueKeys,
  limitRows,
  mergeTestcases,
  noTests,
  parseXml,
  type XmlNode,
} from './junit.parser';

const TIME = /^\d+(\.\d+)?$/;

const STATUS = new Map<string, JunitStatus>([
  ['Pass', 'PASS'],
  ['Fail', 'FAIL'],
]);

const child = (node: XmlNode, name: string): XmlNode | undefined =>
  elements(node).find((c) => c.localName === name);

// Without a method attribute, the display name is "Namespace.Class.Method(args)".
function methodOf(test: XmlNode): string {
  const method = (test.getAttribute?.('method') ?? '').trim();

  if (method !== '') return method;

  const name = (test.getAttribute?.('name') ?? '')
    .trim()
    .replace(/\([\s\S]*\)$/, '')
    .trim();

  return name.slice(name.lastIndexOf('.') + 1).trim();
}

function messageOf(test: XmlNode, status: JunitStatus): string | null {
  if (status === 'FAIL') {
    const failure = child(test, 'failure');

    return cleanMessage(failure && child(failure, 'message')?.textContent);
  }

  return status === 'SKIPPED'
    ? cleanMessage(child(test, 'reason')?.textContent)
    : null;
}

type TraitMeta = Partial<
  Pick<JunitTestcase, 'test_key' | 'requirement_keys' | 'labels'>
>;

function readTraits(
  test: XmlNode,
  name: string,
  row: number,
  warnings: TransferIssue[],
): TraitMeta {
  const tests: string[] = [];
  const requirements: string[] = [];
  const labels: string[] = [];
  const traits = elements(test)
    .filter((c) => c.localName === 'traits')
    .flatMap(elements)
    .filter((t) => t.localName === 'trait');

  for (const trait of traits) {
    const key = (trait.getAttribute?.('name') ?? '').trim().toLowerCase();
    const values = (trait.getAttribute?.('value') ?? '')
      .split(/[\s,]+/)
      .filter((v) => v !== '');

    if (key === 'test') tests.push(...values);
    else if (key === 'requirement') requirements.push(...values);
    else if (key === 'labels') labels.push(...values);
  }

  const meta: TraitMeta = {};
  const [testKey] = issueKeys(tests, row, name, warnings);
  const requirementKeys = issueKeys(requirements, row, name, warnings);

  if (testKey) meta.test_key = testKey;
  if (requirementKeys.length > 0) meta.requirement_keys = requirementKeys;
  if (labels.length > 0) meta.labels = [...new Set(labels)];

  return meta;
}

/** Tests of an xUnit.net v2 report, merged by type and method (theory rows fold into one). */
export function parseXunit(
  buffer: Buffer,
  options: { keepEvidence?: boolean } = {},
): ParsedJunit {
  const root = parseXml(
    checkJunitBytes(buffer, {
      label: 'xUnit',
      count: /<([\w.-]+:)?test[\s/>]/g,
    }),
    'xUnit',
  );

  if (root.localName !== 'assemblies' && root.localName !== 'assembly') {
    throw formatMismatch('an xUnit report (no assemblies)');
  }

  // Walked without recursion, depth checked before any text is read.
  const found: XmlNode[] = [];
  const stack: [XmlNode, number][] = [[root, 1]];

  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [XmlNode, number];

    if (depth > TEST_TRANSFER_LIMITS.junitDepth) {
      throw fileError(
        `The xUnit file is nested more than ${TEST_TRANSFER_LIMITS.junitDepth} levels deep`,
        undefined,
        'RESULT_XML_TOO_DEEP',
      );
    }

    if (node.localName === 'test') {
      found.push(node);
      continue;
    }

    const children = elements(node);

    for (let i = children.length - 1; i >= 0; i--) {
      stack.push([children[i], depth + 1]);
    }
  }

  if (found.length === 0) throw noTests('xUnit');

  const invalid: TransferIssue[] = [];
  const warnings: TransferIssue[] = [];
  const merged = new Map<string, JunitTestcase>();

  found.forEach((test, index) => {
    const row = index + 1;
    const name = methodOf(test);
    const classname = (test.getAttribute?.('type') ?? '').trim();

    if (name === '') {
      invalid.push({
        row,
        code: 'NAME_MISSING',
        message: 'A test has no method name',
      });

      return;
    }

    const rawTime = (test.getAttribute?.('time') ?? '').trim();
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

    const status =
      STATUS.get((test.getAttribute?.('result') ?? '').trim()) ?? 'SKIPPED';
    const item: JunitTestcase = {
      name,
      classname,
      status,
      duration_seconds: duration,
      message: messageOf(test, status),
      merged: 1,
      ...readTraits(test, name, row, warnings),
    };
    // Results with different test keys belong to different tests, as in JUnit.
    const key = `${classname}\u0000${name}\u0000${item.test_key ?? ''}`;
    const earlier = merged.get(key);

    merged.set(key, earlier ? mergeTestcases(earlier, item) : item);
  });

  return {
    testcases: found.length,
    items: limitRows([...merged.values()], warnings),
    invalid,
    warnings,
    ...(options.keepEvidence
      ? { evidence: new Map<string, EvidenceFile[]>() }
      : {}),
  };
}
