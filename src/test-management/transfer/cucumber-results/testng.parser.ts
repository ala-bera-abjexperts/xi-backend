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

const keyOf = (classname: string, name: string) => `${classname}\u0000${name}`;

const words = (value: string): string[] =>
  value.split(/[\s,]+/).filter((v) => v !== '');

function statusOf(method: XmlNode): {
  status: JunitStatus;
  message: string | null;
} {
  const status = (method.getAttribute?.('status') ?? '').trim().toUpperCase();

  if (status === 'PASS') return { status: 'PASS', message: null };
  if (status !== 'FAIL') return { status: 'SKIPPED', message: null };

  const exception = elements(method).find((c) => c.localName === 'exception');
  const text = exception
    ? elements(exception).find((c) => c.localName === 'message')?.textContent
    : null;

  return {
    status: 'FAIL',
    message: cleanMessage(text || exception?.getAttribute?.('class')),
  };
}

// Xray's TestNG extension writes test, requirement and labels as method attributes.
function readAttributes(
  method: XmlNode,
  name: string,
  row: number,
  warnings: TransferIssue[],
  groupLabels: string[],
): Partial<JunitTestcase> {
  const meta: Partial<JunitTestcase> = {};
  const requirements: string[] = [];
  const labels = [...groupLabels];
  const attributes = elements(method)
    .filter((c) => c.localName === 'attributes')
    .flatMap(elements)
    .filter((a) => a.localName === 'attribute');

  for (const attribute of attributes) {
    const key = (attribute.getAttribute?.('name') ?? '').trim();
    const value = (attribute.textContent ?? '').trim();

    if (value === '') continue;

    if (key === 'test') {
      const [testKey] = issueKeys([value], row, name, warnings);

      if (testKey) meta.test_key = testKey;
    } else if (key === 'requirement') {
      requirements.push(...words(value));
    } else if (key === 'labels') {
      labels.push(...value.split(/\s+/).filter((v) => v !== ''));
    }
  }

  const requirementKeys = issueKeys(requirements, row, name, warnings);

  if (requirementKeys.length > 0) meta.requirement_keys = requirementKeys;
  if (labels.length > 0) meta.labels = [...new Set(labels)];

  for (const [attribute, field] of [
    ['started-at', 'started_at'],
    ['finished-at', 'finished_at'],
  ] as const) {
    const time = (method.getAttribute?.(attribute) ?? '').trim();

    if (time !== '') meta[field] = time.slice(0, 50);
  }

  return meta;
}

/** Test methods of a TestNG report, merged by class and method name (any failure wins, times add up). */
export function parseTestng(
  buffer: Buffer,
  options: { keepEvidence?: boolean } = {},
): ParsedJunit {
  const root = parseXml(
    checkJunitBytes(buffer, {
      label: 'TestNG',
      count: /<([\w.-]+:)?test-method[\s/>]/g,
    }),
    'TestNG',
  );

  if (root.localName !== 'testng-results') {
    throw formatMismatch('a TestNG report (no testng-results)');
  }

  // Walked without recursion; the nearest class and group ride along on the stack.
  const found: { method: XmlNode; classname: string }[] = [];
  const groups = new Map<string, string[]>();
  const stack: [XmlNode, number, string, string][] = [[root, 1, '', '']];

  while (stack.length > 0) {
    const [node, depth, className, groupName] = stack.pop() as [
      XmlNode,
      number,
      string,
      string,
    ];

    if (depth > TEST_TRANSFER_LIMITS.junitDepth) {
      throw fileError(
        `The TestNG file is nested more than ${TEST_TRANSFER_LIMITS.junitDepth} levels deep`,
        undefined,
        'RESULT_XML_TOO_DEEP',
      );
    }

    if (node.localName === 'test-method') {
      // Setup and teardown methods are not tests.
      if (node.getAttribute?.('is-config') !== 'true') {
        found.push({ method: node, classname: className });
      }

      continue;
    }

    if (node.localName === 'method' && groupName !== '') {
      const key = keyOf(
        (node.getAttribute?.('class') ?? '').trim(),
        (node.getAttribute?.('name') ?? '').trim(),
      );

      groups.set(key, [...(groups.get(key) ?? []), groupName]);
      continue;
    }

    const nextClass =
      node.localName === 'class'
        ? (node.getAttribute?.('name') ?? '').trim()
        : className;
    const nextGroup =
      node.localName === 'group'
        ? (node.getAttribute?.('name') ?? '').trim()
        : groupName;
    const children = elements(node);

    for (let i = children.length - 1; i >= 0; i--) {
      stack.push([children[i], depth + 1, nextClass, nextGroup]);
    }
  }

  if (found.length === 0) throw noTests('TestNG');

  const invalid: TransferIssue[] = [];
  const warnings: TransferIssue[] = [];
  const merged = new Map<string, JunitTestcase>();

  found.forEach(({ method, classname }, index) => {
    const row = index + 1;
    const name = (method.getAttribute?.('name') ?? '').trim();

    if (name === '') {
      invalid.push({
        row,
        code: 'NAME_MISSING',
        message: 'A test method has no name',
      });

      return;
    }

    const rawTime = (method.getAttribute?.('duration-ms') ?? '').trim();
    let duration: number | null = null;

    if (rawTime !== '') {
      if (TIME.test(rawTime)) duration = Number(rawTime) / 1000;
      else {
        warnings.push({
          row,
          code: 'TIME_INVALID',
          message: `Time "${rawTime.slice(0, 20)}" of ${name} is ignored`,
          value: name,
        });
      }
    }

    const { status, message } = statusOf(method);
    const testcase: JunitTestcase = {
      name,
      classname,
      status,
      duration_seconds: duration,
      message,
      merged: 1,
      ...readAttributes(
        method,
        name,
        row,
        warnings,
        groups.get(keyOf(classname, name)) ?? [],
      ),
    };

    // Results with different test keys belong to different tests, as in JUnit.
    const key = `${keyOf(classname, name)}\u0000${testcase.test_key ?? ''}`;
    const earlier = merged.get(key);

    merged.set(key, earlier ? mergeTestcases(earlier, testcase) : testcase);
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
