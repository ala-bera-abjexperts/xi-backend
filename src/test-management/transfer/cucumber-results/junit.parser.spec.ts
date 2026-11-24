import { HttpException } from '@nestjs/common';

import { TEST_TRANSFER_LIMITS } from '../../dto/test-transfer.dto';
import { mergeTestcases, parseResultFile } from './junit.parser';
import { detectJsonFormat, detectXmlFormat } from './result-format';
import { parseTestng } from './testng.parser';
import { checkJsonBytes, parseXrayJson } from './xray-json.parser';
import { parseXunit } from './xunit.parser';

const report = (testcases: string) =>
  Buffer.from(`<testsuite name="s">${testcases}</testsuite>`);

const withKey = (key: string, inner = '') =>
  `<testcase classname="c" name="n"><properties><property name="test_key" value="${key}"/></properties>${inner}</testcase>`;

describe('parseResultFile, repeated tests', () => {
  it('keeps results with different test keys apart', () => {
    const { items } = parseResultFile(
      report(`${withKey('T-1', '<failure/>')}${withKey('T-2')}`),
    );

    expect(items.map(({ test_key, status }) => ({ test_key, status }))).toEqual(
      [
        { test_key: 'T-1', status: 'FAIL' },
        { test_key: 'T-2', status: 'PASS' },
      ],
    );
  });

  it('still combines repeats with the same key', () => {
    const { items } = parseResultFile(
      report(`${withKey('T-1')}${withKey('T-1', '<failure/>')}`),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: 'FAIL', merged: 2 });
  });

  it('still combines repeats with no key', () => {
    const plain = '<testcase classname="c" name="n"/>';
    const { items } = parseResultFile(report(`${plain}${plain}`));

    expect(items).toHaveLength(1);
    expect(items[0].merged).toBe(2);
  });
});

describe('parseResultFile, long messages', () => {
  const limit = TEST_TRANSFER_LIMITS.junitMessage;
  const hasHalfEmoji = (text: string) => /[\uD800-\uDBFF]$/.test(text);

  it('does not cut an emoji in half at the limit', () => {
    const message = `${'a'.repeat(limit - 1)}😀 more`;
    const { items } = parseResultFile(
      report(
        `<testcase classname="c" name="n"><failure message="${message}"/></testcase>`,
      ),
    );

    expect(items[0].message?.length).toBeLessThanOrEqual(limit);
    expect(hasHalfEmoji(items[0].message ?? '')).toBe(false);
  });

  it('does not cut an emoji in half when combining messages', () => {
    const message = `${'a'.repeat(limit - 3)}😀😀`;
    const failing = `<testcase classname="c" name="n"><failure message="${message}"/></testcase>`;
    const { items } = parseResultFile(report(`${failing}${failing}`));

    expect(items[0].message?.length).toBeLessThanOrEqual(limit);
    expect(hasHalfEmoji(items[0].message ?? '')).toBe(false);
  });
});

describe('result-format (ported)', () => {
  const xml = (body: string) => Buffer.from(body, 'utf8');

  describe('detectXmlFormat', () => {
    it('reads the root element of each supported report', () => {
      expect(detectXmlFormat(xml('<testsuites/>'))).toBe('junit');
      expect(detectXmlFormat(xml('<testsuite name="a"/>'))).toBe('junit');
      expect(detectXmlFormat(xml('<testng-results/>'))).toBe('testng');
      expect(detectXmlFormat(xml('<assemblies/>'))).toBe('xunit');
    });

    it('skips the prolog, a BOM, comments and a namespace prefix', () => {
      expect(
        detectXmlFormat(
          xml(
            String.fromCharCode(0xfeff) +
              '<?xml version="1.0"?>\n<!-- <robot> in a comment -->\n<ns:testsuites xmlns:ns="x"/>',
          ),
        ),
      ).toBe('junit');
    });

    it('returns null for anything else', () => {
      expect(detectXmlFormat(xml('<html/>'))).toBeNull();
      expect(detectXmlFormat(xml('{"tests": []}'))).toBeNull();
      expect(detectXmlFormat(xml(''))).toBeNull();
    });
  });

  describe('detectJsonFormat', () => {
    it('reads an object with tests as Xray JSON and leaves everything else', () => {
      expect(detectJsonFormat(Buffer.from(' {"info": {}, "tests": []}'))).toBe(
        'xray',
      );
      expect(detectJsonFormat(Buffer.from('[{"name": "a"}]'))).toBeNull();
      expect(
        detectJsonFormat(Buffer.from('[{"uri": "a.feature", "elements": []}]')),
      ).toBe('cucumber');
      expect(
        detectJsonFormat(
          Buffer.from('[{"location": "a.feature:1", "elements": []}]'),
        ),
      ).toBe('behave');
      expect(detectJsonFormat(Buffer.from('{"cases": []}'))).toBeNull();
      expect(detectJsonFormat(Buffer.from('<testsuites/>'))).toBeNull();
    });

    it('leaves a report that only nests a tests key', () => {
      const playwright = JSON.stringify({
        config: {},
        suites: [{ title: 'a', specs: [{ title: 'b', tests: [] }] }],
      });

      expect(detectJsonFormat(Buffer.from(playwright))).toBeNull();
    });

    it('still sends broken JSON with tests to the Xray parser', () => {
      expect(detectJsonFormat(Buffer.from('{"tests": [}'))).toBe('xray');
    });

    it('reads Xray JSON that starts with a byte order mark', () => {
      expect(detectJsonFormat(Buffer.from('﻿{"tests": []}'))).toBe('xray');
    });
  });
});

describe('testng (ported)', () => {
  const xml = (body: string) => Buffer.from(body, 'utf8');

  const report = (classes: string, suiteExtra = '') =>
    xml(`<?xml version="1.0" encoding="UTF-8"?>
<testng-results total="1">
  <reporter-output/>
  <suite name="suite">
    ${suiteExtra}
    <test name="test">
      ${classes}
    </test>
  </suite>
</testng-results>`);

  function messageOf(run: () => unknown): string {
    try {
      run();
    } catch (error) {
      return ((error as HttpException).getResponse() as { message: string })
        .message;
    }

    throw new Error('expected an error');
  }

  describe('parseTestng', () => {
    it('maps PASS, FAIL, SKIP and unknown statuses', () => {
      const result = parseTestng(
        report(`<class name="app.Auth">
  <test-method status="PASS" name="login" duration-ms="1500"/>
  <test-method status="FAIL" name="logout" duration-ms="200">
    <exception class="java.lang.AssertionError"><message><![CDATA[expected 200]]></message></exception>
  </test-method>
  <test-method status="FAIL" name="reset"><exception class="java.lang.IllegalStateException"/></test-method>
  <test-method status="SKIP" name="sso"/>
  <test-method name="nostatus"/>
  <test-method status="WEIRD" name="odd"/>
</class>`),
      );

      expect(result.testcases).toBe(6);
      expect(
        result.items.map((t) => [
          t.classname,
          t.name,
          t.status,
          t.duration_seconds,
          t.message,
        ]),
      ).toEqual([
        ['app.Auth', 'login', 'PASS', 1.5, null],
        ['app.Auth', 'logout', 'FAIL', 0.2, 'expected 200'],
        ['app.Auth', 'reset', 'FAIL', null, 'java.lang.IllegalStateException'],
        ['app.Auth', 'sso', 'SKIPPED', null, null],
        ['app.Auth', 'nostatus', 'SKIPPED', null, null],
        ['app.Auth', 'odd', 'SKIPPED', null, null],
      ]);
    });

    it('skips config methods and numbers rows among test methods only', () => {
      const result = parseTestng(
        report(`<class name="a.B">
  <test-method status="PASS" is-config="true" name="setUp"/>
  <test-method status="PASS" name="t1"/>
  <test-method status="FAIL" is-config="true" name="tearDown"/>
  <test-method status="PASS" name=" "/>
</class>`),
      );

      expect(result.testcases).toBe(2);
      expect(result.items.map((t) => t.name)).toEqual(['t1']);
      expect(result.invalid).toEqual([
        { row: 2, code: 'NAME_MISSING', message: 'A test method has no name' },
      ]);
    });

    it('keeps methods of different classes apart', () => {
      const result = parseTestng(
        report(`<class name="a.One"><test-method status="PASS" name="t"/></class>
<class name="a.Two"><test-method status="FAIL" name="t"/></class>`),
      );

      expect(result.items.map((t) => [t.classname, t.name, t.status])).toEqual([
        ['a.One', 't', 'PASS'],
        ['a.Two', 't', 'FAIL'],
      ]);
    });

    it('merges data-provider rows: a failure wins and durations add up', () => {
      const result = parseTestng(
        report(`<class name="a.B">
  <test-method status="PASS" name="row" duration-ms="1000"/>
  <test-method status="FAIL" name="row" duration-ms="2500"><exception class="E"><message>second row</message></exception></test-method>
  <test-method status="PASS" name="row" duration-ms="500"/>
</class>`),
      );

      expect(result.testcases).toBe(3);
      expect(result.items).toEqual([
        expect.objectContaining({
          classname: 'a.B',
          name: 'row',
          status: 'FAIL',
          duration_seconds: 4,
          message: 'second row',
          merged: 3,
        }),
      ]);
    });

    it('reads test, requirement and labels attributes', () => {
      const result = parseTestng(
        report(`<class name="a.B">
  <test-method status="PASS" name="t" started-at="2026-10-26T10:00:00Z" finished-at="2026-10-26T10:00:01Z">
    <attributes>
      <attribute name="test"><![CDATA[calc-1]]></attribute>
      <attribute name="requirement"><![CDATA[CALC-2, CALC-3 nope]]></attribute>
      <attribute name="labels"><![CDATA[core  ui]]></attribute>
    </attributes>
  </test-method>
</class>`),
      );

      expect(result.items[0]).toEqual({
        name: 't',
        classname: 'a.B',
        status: 'PASS',
        duration_seconds: null,
        message: null,
        merged: 1,
        test_key: 'CALC-1',
        requirement_keys: ['CALC-2', 'CALC-3'],
        labels: ['core', 'ui'],
        started_at: '2026-10-26T10:00:00Z',
        finished_at: '2026-10-26T10:00:01Z',
      });
      expect(result.warnings).toEqual([
        expect.objectContaining({ row: 1, code: 'KEY_INVALID', value: 'nope' }),
      ]);
    });

    it('turns suite groups into labels of the matching methods', () => {
      const result = parseTestng(
        report(
          `<class name="a.B">
  <test-method status="PASS" name="t1">
    <attributes><attribute name="labels">ui</attribute></attributes>
  </test-method>
  <test-method status="PASS" name="t2"/>
</class>`,
          `<groups>
  <group name="smoke"><method signature="t1()" name="t1" class="a.B"/></group>
  <group name="regression">
    <method signature="t1()" name="t1" class="a.B"/>
    <method signature="t1()" name="t1" class="other.C"/>
  </group>
</groups>`,
        ),
      );

      expect(result.items.map((t) => [t.name, t.labels])).toEqual([
        ['t1', ['smoke', 'regression', 'ui']],
        ['t2', undefined],
      ]);
    });

    it('ignores a duration it cannot read and warns about it', () => {
      const result = parseTestng(
        report(`<class name="a.B">
  <test-method status="PASS" name="a" duration-ms="1,5"/>
  <test-method status="PASS" name="b" duration-ms="-2"/>
</class>`),
      );

      expect(result.items.map((t) => t.duration_seconds)).toEqual([null, null]);
      expect(result.warnings).toEqual([
        {
          row: 1,
          code: 'TIME_INVALID',
          message: 'Time "1,5" of a is ignored',
          value: 'a',
        },
        {
          row: 2,
          code: 'TIME_INVALID',
          message: 'Time "-2" of b is ignored',
          value: 'b',
        },
      ]);
    });

    it('returns exactly the plain fields for a plain report', () => {
      const result = parseTestng(
        report(
          '<class name="a.B"><test-method status="PASS" signature="t()" name="t" duration-ms="20"/></class>',
        ),
        { keepEvidence: true },
      );

      expect(result).toEqual({
        testcases: 1,
        items: [
          {
            name: 't',
            classname: 'a.B',
            status: 'PASS',
            duration_seconds: 0.02,
            message: null,
            merged: 1,
          },
        ],
        invalid: [],
        warnings: [],
        evidence: new Map(),
      });
      expect(
        parseTestng(
          report(
            '<class name="a.B"><test-method status="PASS" name="t"/></class>',
          ),
        ).evidence,
      ).toBeUndefined();
    });

    it('refuses a file whose root is not testng-results', () => {
      expect(
        messageOf(() =>
          parseTestng(xml('<testsuite><testcase name="a"/></testsuite>')),
        ),
      ).toBe('The file is not a TestNG report (no testng-results)');
    });

    it('refuses a DOCTYPE', () => {
      expect(
        messageOf(() =>
          parseTestng(xml('<!DOCTYPE x [<!ENTITY a "b">]><testng-results/>')),
        ),
      ).toBe('TestNG files with a DOCTYPE or ENTITY are not accepted');
    });

    it('refuses a file nested too deep', () => {
      const deep = '<a>'.repeat(40) + '</a>'.repeat(40);

      expect(
        messageOf(() =>
          parseTestng(xml(`<testng-results>${deep}</testng-results>`)),
        ),
      ).toMatch(/nested more than \d+ levels deep/);
    });
  });
});

describe('xunit (ported)', () => {
  const xml = (body: string) => Buffer.from(body, 'utf8');

  const report = (tests: string) =>
    xml(`<?xml version="1.0" encoding="utf-8"?>
<assemblies>
  <assembly name="Calc.Tests.dll">
    <collection name="Calc">
${tests}
    </collection>
  </assembly>
</assemblies>`);

  function messageOf(run: () => unknown): string {
    try {
      run();
    } catch (error) {
      return ((error as HttpException).getResponse() as { message: string })
        .message;
    }

    throw new Error('expected an error');
  }

  describe('parseXunit', () => {
    it('maps Pass, Fail, Skip and NotRun results to statuses', () => {
      const result = parseXunit(
        report(`
      <test name="Calc.Add" type="Calc.Tests" method="Add" time="0.5" result="Pass"/>
      <test name="Calc.Sub" type="Calc.Tests" method="Sub" time="1.25" result="Fail">
        <failure exception-type="Xunit.Sdk.EqualException"><message>Assert.Equal() Failure</message><stack-trace>at Calc</stack-trace></failure>
      </test>
      <test name="Calc.Mul" type="Calc.Tests" method="Mul" result="Skip"><reason><![CDATA[not ready]]></reason></test>
      <test name="Calc.Div" type="Calc.Tests" method="Div" result="NotRun"/>
      <test name="Calc.Mod" type="Calc.Tests" method="Mod"/>`),
      );

      expect(result.testcases).toBe(5);
      expect(
        result.items.map((t) => [
          t.name,
          t.status,
          t.duration_seconds,
          t.message,
        ]),
      ).toEqual([
        ['Add', 'PASS', 0.5, null],
        ['Sub', 'FAIL', 1.25, 'Assert.Equal() Failure'],
        ['Mul', 'SKIPPED', null, 'not ready'],
        ['Div', 'SKIPPED', null, null],
        ['Mod', 'SKIPPED', null, null],
      ]);
      expect(result.invalid).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('returns exactly the plain fields when a test has no traits', () => {
      const result = parseXunit(
        report(
          '<test name="Calc.Add" type="Calc.Tests" method="Add" time="0.5" result="Pass"/>',
        ),
      );

      expect(result.items).toEqual([
        {
          name: 'Add',
          classname: 'Calc.Tests',
          status: 'PASS',
          duration_seconds: 0.5,
          message: null,
          merged: 1,
        },
      ]);
      expect(result).not.toHaveProperty('evidence');
      expect(
        parseXunit(report('<test type="A" method="b" result="Pass"/>'), {
          keepEvidence: true,
        }).evidence,
      ).toEqual(new Map());
    });

    it('merges theory rows: a failure wins and times add up', () => {
      const result = parseXunit(
        report(`
      <test name="Calc.Tests.Adds(a: 1, b: 2)" type="Calc.Tests" method="Adds" time="1" result="Pass"/>
      <test name="Calc.Tests.Adds(a: 2, b: 2)" type="Calc.Tests" method="Adds" time="2" result="Fail"><failure><message>wrong sum</message></failure></test>
      <test name="Calc.Tests.Adds(a: 3, b: 2)" type="Calc.Tests" method="Adds" time="0.5" result="Pass"/>
      <test name="Other.Adds" type="Other" method="Adds" time="4" result="Pass"/>`),
      );

      expect(result.testcases).toBe(4);
      expect(result.items).toEqual([
        expect.objectContaining({
          name: 'Adds',
          classname: 'Calc.Tests',
          status: 'FAIL',
          duration_seconds: 3.5,
          message: 'wrong sum',
          merged: 3,
        }),
        expect.objectContaining({
          classname: 'Other',
          status: 'PASS',
          merged: 1,
        }),
      ]);
    });

    it('maps test, requirement and labels traits, names compared case-insensitively', () => {
      const result = parseXunit(
        report(`
      <test name="Calc.Add" type="Calc.Tests" method="Add" result="Pass">
        <traits>
          <trait name="Test" value="calc-2"/>
          <trait name="requirement" value="CALC-1, CALC-3 nope"/>
          <trait name="LABELS" value="core UI core"/>
          <trait name="Category" value="ignored"/>
        </traits>
      </test>`),
      );

      expect(result.items[0]).toEqual(
        expect.objectContaining({
          test_key: 'CALC-2',
          requirement_keys: ['CALC-1', 'CALC-3'],
          labels: ['core', 'UI'],
        }),
      );
      expect(result.warnings).toEqual([
        expect.objectContaining({ row: 1, code: 'KEY_INVALID', value: 'nope' }),
      ]);
    });

    it('falls back to the display name without its parameters when method is missing', () => {
      const result = parseXunit(
        report(`
      <test name="Calc.Tests.Divides(x: 1.5)" type="Calc.Tests" result="Pass"/>
      <test name="Calc.Tests.Divides(x: 3)" type="Calc.Tests" result="Pass"/>
      <test name="" type="Calc.Tests" result="Pass"/>`),
      );

      expect(result.items).toEqual([
        expect.objectContaining({ name: 'Divides', merged: 2 }),
      ]);
      expect(result.invalid).toEqual([
        {
          row: 3,
          code: 'NAME_MISSING',
          message: 'A test has no method name',
        },
      ]);
    });

    it('ignores a time it cannot read and warns about it', () => {
      const result = parseXunit(
        report(
          '<test name="Calc.Add" type="Calc.Tests" method="Add" time="1,5" result="Pass"/>',
        ),
      );

      expect(result.items[0].duration_seconds).toBeNull();
      expect(result.warnings).toEqual([
        expect.objectContaining({
          row: 1,
          code: 'TIME_INVALID',
          value: 'Add',
        }),
      ]);
    });

    it('accepts a single assembly as the root', () => {
      const result = parseXunit(
        xml(
          '<assembly><collection><test type="A" method="b" result="Pass"/></collection></assembly>',
        ),
      );

      expect(result.items).toHaveLength(1);
    });

    it('refuses a file that is not an xUnit report', () => {
      expect(messageOf(() => parseXunit(xml('<testsuites/>')))).toBe(
        'The file is not an xUnit report (no assemblies)',
      );
    });

    it('refuses a DOCTYPE', () => {
      expect(
        messageOf(() =>
          parseXunit(
            xml('<!DOCTYPE assemblies [<!ENTITY x "y">]><assemblies/>'),
          ),
        ),
      ).toBe('xUnit files with a DOCTYPE or ENTITY are not accepted');
    });
  });
});

describe('xray-json (ported)', () => {
  const json = (body: unknown) => Buffer.from(JSON.stringify(body), 'utf8');
  const results = (...tests: unknown[]) => parseXrayJson(json({ tests }));
  const PNG = Buffer.from('png-bytes').toString('base64');

  function errorOf(run: () => unknown): { message: string; data?: unknown } {
    try {
      run();
    } catch (error) {
      return (error as HttpException).getResponse() as {
        message: string;
        data?: unknown;
      };
    }

    throw new Error('expected an error');
  }

  describe('checkJsonBytes', () => {
    it('refuses empty, NUL, non UTF-8 and invalid JSON files', () => {
      expect(
        errorOf(() => checkJsonBytes(Buffer.alloc(0), 'Xray JSON')),
      ).toEqual(expect.objectContaining({ message: 'The file is empty' }));
      expect(
        errorOf(() =>
          checkJsonBytes(Buffer.from([0x7b, 0x00, 0x7d]), 'Xray JSON'),
        ),
      ).toEqual(expect.objectContaining({ code: 'RESULT_FORMAT_UNKNOWN' }));
      expect(
        errorOf(() =>
          checkJsonBytes(Buffer.from([0x22, 0xff, 0x22]), 'Xray JSON'),
        ).message,
      ).toBe('The report must be saved as UTF-8');

      const invalid = errorOf(() =>
        checkJsonBytes(Buffer.from('{"tests": [', 'utf8'), 'Xray JSON'),
      );

      expect(invalid.message).toBe('The Xray JSON file is not valid JSON');
      expect(typeof (invalid.data as { detail: unknown }).detail).toBe(
        'string',
      );
    });

    it('accepts a UTF-8 BOM', () => {
      const body = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('{"a":1}', 'utf8'),
      ]);

      expect(checkJsonBytes(body, 'Xray JSON')).toEqual({ a: 1 });
    });
  });

  describe('parseXrayJson', () => {
    it('refuses a file without tests, with no tests or with too many tests', () => {
      expect(errorOf(() => parseXrayJson(json({ info: {} }))).message).toBe(
        'The file is not an Xray JSON results file (no tests)',
      );
      expect(errorOf(() => parseXrayJson(json([]))).message).toBe(
        'The file is not an Xray JSON results file (no tests)',
      );
      expect(errorOf(() => results())).toEqual(
        expect.objectContaining({
          code: 'RESULT_EMPTY',
          message: 'The Xray JSON report has no tests',
        }),
      );

      const tooMany = errorOf(() =>
        parseXrayJson(
          json({
            tests: Array.from({ length: 5001 }, () => ({
              testKey: 'CALC-1',
              status: 'PASSED',
            })),
          }),
        ),
      );

      expect(tooMany).toEqual(
        expect.objectContaining({
          code: 'RESULT_TOO_MANY',
          message: 'The file has more than 5000 tests',
          data: { tests: 5001, max: 5000 },
        }),
      );
    });

    it('reads a plain test with a key as the minimal item', () => {
      const result = results({ testKey: ' newspace-tc5 ', status: 'PASSED' });

      expect(result).toEqual({
        testcases: 1,
        items: [
          {
            name: 'NEWSPACE-TC5',
            classname: '',
            status: 'PASS',
            duration_seconds: null,
            message: null,
            merged: 1,
            test_key: 'NEWSPACE-TC5',
          },
        ],
        invalid: [],
        warnings: [],
      });
    });

    it('names a generic test by its definition and a manual test by its summary', () => {
      const result = results(
        {
          testInfo: {
            summary: 'Sum of two numbers',
            type: ' Generic ',
            definition: '  com.calc.SumTest.addsTwo  ',
            requirementKeys: ['calc-12', 'bad key'],
            labels: ['smoke', 'smoke', ' api '],
          },
          status: 'PASSED',
        },
        {
          testInfo: {
            summary: 'Login with SSO',
            type: 'Manual',
            labels: ['ui'],
          },
          status: 'FAILED',
        },
        {
          testInfo: {
            summary: 'Checkout',
            type: 'Cucumber',
            scenario: 'Scenario: pay\n  Given a cart',
          },
          status: 'PASSED',
        },
      );

      expect(result.items).toEqual([
        expect.objectContaining({
          name: 'com.calc.SumTest.addsTwo',
          summary: 'Sum of two numbers',
          test_type: 'Generic',
          definition: 'com.calc.SumTest.addsTwo',
          requirement_keys: ['CALC-12'],
          labels: ['smoke', 'api'],
        }),
        expect.objectContaining({
          name: 'Login with SSO',
          status: 'FAIL',
          test_type: 'Manual',
          labels: ['ui'],
        }),
        expect.objectContaining({
          name: 'Checkout',
          definition: 'Scenario: pay\n  Given a cart',
        }),
      ]);
      expect(result.items[0].test_key).toBeUndefined();
      expect(result.warnings).toEqual([
        expect.objectContaining({
          row: 1,
          code: 'KEY_INVALID',
          value: 'bad key',
        }),
      ]);
    });

    it('warns that steps in testInfo are not created for a new test', () => {
      const result = results(
        {
          testInfo: { summary: 'New test', steps: [{ action: 'Open' }] },
          status: 'PASSED',
        },
        {
          testKey: 'CALC-12',
          testInfo: { summary: 'Known test', steps: [{ action: 'Open' }] },
          status: 'PASSED',
        },
      );

      expect(result.warnings).toEqual([
        {
          row: 1,
          code: 'STEPS_NOT_CREATED',
          message:
            'Steps in testInfo of New test are not copied to new test cases',
        },
      ]);
      expect(result.items[1]).toEqual(
        expect.objectContaining({ name: 'CALC-12', summary: 'Known test' }),
      );
    });

    it('lists tests it cannot read as invalid', () => {
      const result = results(
        'text',
        { status: 'PASSED' },
        { testInfo: { type: 'Manual' }, status: 'PASSED' },
        { testKey: 'CALC-1' },
        {
          testKey: 'CALC-2',
          status: 'PASSED',
          steps: [{ status: 'PASSED' }],
          iterations: [{ status: 'PASSED' }],
        },
      );

      expect(result.testcases).toBe(5);
      expect(result.items).toEqual([]);
      expect(result.invalid.map((i) => [i.row, i.code, i.message])).toEqual([
        [1, 'TEST_INVALID', 'Test 1 is not an object'],
        [2, 'TEST_KEY_MISSING', 'Test 2 has neither testKey nor testInfo'],
        [3, 'SUMMARY_MISSING', 'Test 3 has no summary in testInfo'],
        [4, 'STATUS_MISSING', 'Test 4 has no status'],
        [
          5,
          'STRUCTURE_INVALID',
          'Test 5 mixes steps with examples or iterations',
        ],
      ]);
    });

    it('maps test statuses, records ABORTED as BLOCKED and custom ones as SKIPPED', () => {
      const statuses = [
        'PASSED',
        'pass',
        'FAILED',
        'fail',
        'BLOCKED',
        'ABORTED',
        'TODO',
        'EXECUTING',
        'Retest',
      ];
      const result = results(
        ...statuses.map((status, i) => ({ testKey: `CALC-${i + 1}`, status })),
      );

      expect(result.items.map((t) => t.status)).toEqual([
        'PASS',
        'PASS',
        'FAIL',
        'FAIL',
        'BLOCKED',
        'BLOCKED',
        'SKIPPED',
        'SKIPPED',
        'SKIPPED',
      ]);
      expect(result.warnings).toEqual([
        {
          row: 6,
          code: 'STATUS_CHANGED',
          message: 'CALC-6: ABORTED is recorded as BLOCKED',
        },
        expect.objectContaining({
          row: 9,
          code: 'STATUS_IGNORED',
          value: 'Retest',
        }),
      ]);
    });

    it('maps steps in order and warns once about unknown step statuses', () => {
      const result = results({
        testKey: 'NEWSPACE-T650',
        status: 'FAILED',
        steps: [
          { status: 'PASSED', actualResult: 'Opened', comment: 'fine' },
          { status: 'FAILED', actualResult: '  ' },
          { status: 'ABORTED' },
          { status: 'EXECUTING' },
          { status: 'NA' },
          { status: 'NOT_APPLICABLE' },
          { status: 'WAITING' },
          { status: 'OTHER' },
        ],
      });

      expect(result.items[0].steps).toEqual([
        { status: 'PASS', actual_result: 'Opened', comment: 'fine' },
        { status: 'FAIL', actual_result: null, comment: null },
        { status: 'BLOCKED', actual_result: null, comment: null },
        { status: 'TODO', actual_result: null, comment: null },
        { status: 'NOT_APPLICABLE', actual_result: null, comment: null },
        { status: 'NOT_APPLICABLE', actual_result: null, comment: null },
        { status: 'TODO', actual_result: null, comment: null },
        { status: 'TODO', actual_result: null, comment: null },
      ]);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          row: 1,
          code: 'STATUS_IGNORED',
          value: 'WAITING',
        }),
      ]);
    });

    it('adds iteration and example lines after the comment', () => {
      const result = results(
        {
          testKey: 'CALC-1',
          status: 'FAILED',
          comment: 'Ran on staging',
          iterations: [
            {
              name: 'first',
              parameters: [
                { name: 'a', value: '1' },
                { name: 'b', value: '2' },
              ],
              status: 'PASSED',
            },
            { status: 'failed' },
          ],
        },
        {
          testKey: 'CALC-2',
          status: 'PASSED',
          results: [{ status: 'PASSED' }],
        },
        { testKey: 'CALC-3', status: 'FAILED', examples: ['PASSED', 'FAILED'] },
      );

      expect(result.items.map((t) => t.comment)).toEqual([
        'Ran on staging\nIteration 1 (a=1, b=2): PASSED\nIteration 2: FAILED',
        'Iteration 1: PASSED',
        'Example 1: PASSED\nExample 2: FAILED',
      ]);
    });

    it('keeps one row per iteration and example', () => {
      const result = results(
        {
          testKey: 'CALC-1',
          status: 'FAILED',
          iterations: [
            {
              name: 'first',
              parameters: [{ name: 'a', value: '1' }, 'bad'],
              log: 'ok\u0000',
              status: 'PASSED',
            },
            { status: 'aborted' },
            { status: 'EXECUTING' },
            { status: 'weird' },
          ],
        },
        {
          testKey: 'CALC-2',
          status: 'PASSED',
          results: [{ status: 'PASSED' }],
        },
        { testKey: 'CALC-3', status: 'FAILED', examples: ['PASSED', 'FAILED'] },
        { testKey: 'CALC-4', status: 'PASSED' },
      );

      expect(result.items.map((t) => t.iterations)).toEqual([
        [
          {
            status: 'PASS',
            name: 'first',
            parameters: [{ name: 'a', value: '1' }],
            comment: 'ok',
          },
          { status: 'BLOCKED' },
          { status: 'TODO' },
          { status: 'TODO' },
        ],
        [{ status: 'PASS' }],
        [{ status: 'PASS' }, { status: 'FAIL' }],
        undefined,
      ]);
    });

    it('caps iterations, their parameters and an oversized row', () => {
      const many = Array.from({ length: 1005 }, () => ({ status: 'PASSED' }));
      const parameters = Array.from({ length: 25 }, (_, i) => ({
        name: `p${i}`,
        value: 'v'.repeat(600),
      }));
      const huge = Array.from({ length: 20 }, (_, i) => ({
        name: `p${i}`,
        value: '\u{1F600}'.repeat(500),
      }));
      const parsed = results(
        { testKey: 'CALC-1', status: 'PASSED', iterations: many },
        {
          testKey: 'CALC-2',
          status: 'PASSED',
          iterations: [{ parameters, status: 'PASSED' }],
        },
        {
          testKey: 'CALC-3',
          status: 'PASSED',
          iterations: [{ name: 'big', parameters: huge, status: 'PASSED' }],
        },
      );
      const [capped, params, oversized] = parsed.items;

      expect(capped.iterations).toHaveLength(1000);
      expect(params.iterations?.[0].parameters).toHaveLength(20);
      expect(params.iterations?.[0].parameters?.[0].value).toHaveLength(500);
      // The database refuses a row over 20000 bytes, so it is left out with a warning.
      expect(oversized.iterations).toEqual([]);
      expect(parsed.warnings.map((w) => [w.row, w.code])).toEqual([
        [1, 'ITERATIONS_TRIMMED'],
        [3, 'ITERATIONS_TRIMMED'],
      ]);
    });

    it('reads start and finish times and their duration', () => {
      const result = results(
        {
          testKey: 'CALC-1',
          status: 'PASSED',
          start: '2026-10-26T10:00:00+01:00',
          finish: '2026-10-26T10:00:02.500+01:00',
        },
        {
          testKey: 'CALC-2',
          status: 'PASSED',
          start: '2026-10-26T10:00:05Z',
          finish: '2026-10-26T10:00:00Z',
        },
        { testKey: 'CALC-3', status: 'PASSED', start: 'soon' },
      );

      expect(
        result.items.map((t) => [
          t.started_at,
          t.finished_at,
          t.duration_seconds,
        ]),
      ).toEqual([
        ['2026-10-26T10:00:00+01:00', '2026-10-26T10:00:02.500+01:00', 2.5],
        ['2026-10-26T10:00:05Z', '2026-10-26T10:00:00Z', null],
        ['soon', undefined, null],
      ]);
    });

    it('keeps test and step evidence bytes only when asked for', () => {
      const body = json({
        tests: [
          {
            testKey: 'CALC-1',
            status: 'FAILED',
            evidence: [
              {
                data: PNG,
                filename: 'shots/home.png',
                contentType: 'image/png',
              },
              { data: '%%%', filename: 'bad.png' },
            ],
            steps: [
              {
                status: 'FAILED',
                evidences: [{ data: PNG, filename: 'step.png' }],
              },
            ],
          },
        ],
      });
      const preview = parseXrayJson(body);
      const kept = parseXrayJson(body, { keepEvidence: true });
      const size = Buffer.from('png-bytes').length;

      expect(preview.items[0].evidence).toEqual([
        { name: 'home.png', size },
        { name: 'step-1-step.png', size },
      ]);
      expect(preview.evidence).toBeUndefined();
      expect(preview.warnings).toEqual([
        expect.objectContaining({ code: 'EVIDENCE_INVALID', value: 'CALC-1' }),
      ]);
      expect(
        kept.evidence?.get('CALC-1')?.map((f) => [f.name, f.data.toString()]),
      ).toEqual([
        ['home.png', 'png-bytes'],
        ['step-1-step.png', 'png-bytes'],
      ]);
    });

    it('collects test and step defects without duplicates', () => {
      const result = results({
        testKey: 'CALC-1',
        status: 'FAILED',
        defects: ['calc-50', 'CALC-51'],
        steps: [
          { status: 'FAILED', defects: ['CALC-51', 'CALC-52'] },
          { status: 'PASSED' },
        ],
      });

      expect(result.items[0].defect_keys).toEqual([
        'CALC-50',
        'CALC-51',
        'CALC-52',
      ]);
    });

    it('reads the execution key and info and lists fields it does not store', () => {
      const result = parseXrayJson(
        json({
          testExecutionKey: 'newspace-te7',
          info: {
            project: 'NEWSPACE',
            summary: 'Nightly run',
            description: 'All regression tests',
            version: 'v1.2',
            revision: 'abc123',
            user: 'admin',
            startDate: '2026-10-26T10:00:00Z',
            testPlanKey: 'NEWSPACE-TP3',
            testEnvironments: ['Chrome', ' ', 'Chrome', 'Linux'],
          },
          tests: [
            {
              testKey: 'CALC-1',
              status: 'PASSED',
              executedBy: 'alice',
              assignee: 'bob',
            },
            { testKey: 'CALC-2', status: 'PASSED', customFields: [] },
          ],
        }),
      );

      // The upload chooses the execution and its details, so the file's own are only reported.
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: 'EXECUTION_KEY_IGNORED',
          value: 'NEWSPACE-TE7',
        }),
        expect.objectContaining({
          code: 'FIELD_NOT_STORED',
          value:
            'info.summary, info.description, info.version, info.revision, info.testPlanKey, info.testEnvironments, info.user, info.project, executedBy, assignee, customFields',
        }),
      ]);
    });

    it('warns about an execution key that is not a ticket key', () => {
      const result = parseXrayJson(
        json({
          testExecutionKey: 'nightly',
          tests: [{ testKey: 'CALC-1', status: 'PASSED' }],
        }),
      );

      expect(result.warnings).toEqual([
        expect.objectContaining({
          row: 0,
          code: 'KEY_INVALID',
          value: 'nightly',
        }),
      ]);
    });

    it('merges a test key that appears twice and keeps the first steps', () => {
      const result = results(
        {
          testKey: 'CALC-1',
          status: 'PASSED',
          defects: ['CALC-50'],
          steps: [{ status: 'PASSED' }],
        },
        {
          testKey: 'CALC-1',
          status: 'FAILED',
          defects: ['CALC-51'],
          steps: [{ status: 'FAILED' }, { status: 'FAILED' }],
        },
      );

      expect(result.testcases).toBe(2);
      expect(result.items).toEqual([
        expect.objectContaining({
          name: 'CALC-1',
          status: 'FAIL',
          merged: 2,
          defect_keys: ['CALC-50', 'CALC-51'],
          steps: [{ status: 'PASS', actual_result: null, comment: null }],
        }),
      ]);
    });
  });
});

describe('parseResultFile, other formats', () => {
  const codeOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return ((error as HttpException).getResponse() as { code: string }).code;
    }

    throw new Error('expected an error');
  };
  const testng = Buffer.from(
    '<testng-results><suite><test><class name="a.B"><test-method status="PASS" name="t"/></class></test></suite></testng-results>',
  );
  const xray = Buffer.from(
    JSON.stringify({ tests: [{ testKey: 'CALC-1', status: 'PASSED' }] }),
  );

  it('reads each new format from the file when none is given', () => {
    expect(parseResultFile(testng).format).toBe('testng');
    expect(
      parseResultFile(
        Buffer.from(
          '<assemblies><test type="A" method="b" result="Pass"/></assemblies>',
        ),
      ).format,
    ).toBe('xunit');
    expect(parseResultFile(xray).format).toBe('xray');
  });

  it('keeps JUnit, Cucumber and Behave as before', () => {
    expect(
      parseResultFile(
        Buffer.from('<testsuite><testcase name="a"/></testsuite>'),
      ).format,
    ).toBe('junit');
    expect(
      parseResultFile(
        Buffer.from(
          JSON.stringify([
            {
              uri: 'a.feature',
              elements: [
                {
                  name: 's',
                  tags: [{ name: '@TEST_CALC-1' }],
                  steps: [{ result: { status: 'passed' } }],
                },
              ],
            },
          ]),
        ),
      ).format,
    ).toBe('cucumber');
    expect(codeOf(() => parseResultFile(testng, { format: 'junit' }))).toBe(
      'RESULT_FORMAT_UNKNOWN',
    );
    expect(codeOf(() => parseResultFile(Buffer.from('{"a": 1}')))).toBe(
      'RESULT_FORMAT_UNKNOWN',
    );
  });

  it('refuses a file that is not the picked format', () => {
    const junit = Buffer.from('<testsuite><testcase name="a"/></testsuite>');

    expect(codeOf(() => parseResultFile(junit, { format: 'testng' }))).toBe(
      'RESULT_FORMAT_MISMATCH',
    );
    expect(codeOf(() => parseResultFile(junit, { format: 'xray' }))).toBe(
      'RESULT_NOT_JSON',
    );
    expect(
      codeOf(() => parseResultFile(Buffer.from('[]'), { format: 'xray' })),
    ).toBe('RESULT_FORMAT_MISMATCH');
  });

  it('refuses a report without tests and one with too many', () => {
    expect(
      codeOf(() => parseResultFile(Buffer.from('<testng-results/>'))),
    ).toBe('RESULT_EMPTY');

    const many = '<test-method status="PASS" name="t"/>'.repeat(5001);

    expect(
      codeOf(() =>
        parseResultFile(
          Buffer.from(`<testng-results>${many}</testng-results>`),
        ),
      ),
    ).toBe('RESULT_TOO_MANY');
    expect(
      codeOf(() =>
        parseResultFile(
          Buffer.from(
            `<testsuite>${'<testcase name="t"/>'.repeat(5001)}</testsuite>`,
          ),
        ),
      ),
    ).toBe('RESULT_TOO_MANY_TESTS');
  });

  it('does not take XML quoted inside a JSON report for an XML report', () => {
    expect(
      detectXmlFormat(Buffer.from('{"tests": [], "x": "<robot>"}')),
    ).toBeNull();
    expect(
      parseResultFile(
        Buffer.from(
          JSON.stringify({
            tests: [
              { testKey: 'CALC-1', status: 'PASSED', comment: '<robot>' },
            ],
          }),
        ),
      ).format,
    ).toBe('xray');
  });

  it('keeps at most 1000 steps and warns about the rest', () => {
    const steps = Array.from({ length: 1001 }, () => ({ status: 'PASSED' }));
    const parsed = parseResultFile(
      Buffer.from(
        JSON.stringify({
          tests: [{ testKey: 'CALC-1', status: 'PASSED', steps }],
        }),
      ),
    );

    expect(parsed.items[0].steps).toHaveLength(1000);
    expect(parsed.warnings).toEqual([
      expect.objectContaining({
        row: 1,
        code: 'STEPS_TRIMMED',
        value: 'CALC-1',
      }),
    ]);
  });
});

describe('mergeTestcases, other formats', () => {
  const base = {
    classname: 'c',
    name: 'n',
    duration_seconds: null,
    message: null,
    merged: 1,
  };

  it('joins keys, labels, comments, evidence and iterations', () => {
    const merged = mergeTestcases(
      {
        ...base,
        status: 'PASS',
        requirement_keys: ['R-1'],
        labels: ['a'],
        comment: 'first',
        evidence: [{ name: 'x.png', size: 1 }],
        iterations: [{ status: 'PASS' }],
      },
      {
        ...base,
        status: 'FAIL',
        requirement_keys: ['R-1', 'R-2'],
        labels: ['b'],
        comment: 'second',
        evidence: [{ name: 'y.png', size: 2 }],
        iterations: [{ status: 'FAIL' }],
      },
    );

    expect(merged).toMatchObject({
      status: 'FAIL',
      requirement_keys: ['R-1', 'R-2'],
      labels: ['a', 'b'],
      comment: 'first\nsecond',
      evidence: [
        { name: 'x.png', size: 1 },
        { name: 'y.png', size: 2 },
      ],
      iterations: [{ status: 'PASS' }, { status: 'FAIL' }],
      merged: 2,
    });
  });

  it('adds nothing new to plain JUnit results', () => {
    expect(
      mergeTestcases({ ...base, status: 'PASS' }, { ...base, status: 'FAIL' }),
    ).toEqual({ ...base, status: 'FAIL', merged: 2 });
  });
});

describe('parseXrayJson, details for a new execution', () => {
  const xray = (body: unknown) =>
    parseXrayJson(Buffer.from(JSON.stringify(body)));

  it('keeps the execution key and the info a new execution can use', () => {
    const result = xray({
      testExecutionKey: 'calc-te7',
      info: {
        summary: '  Nightly run ',
        description: 'All regression tests',
        version: 'v1.2',
        revision: 'abc123',
        testPlanKey: ' calc-tp3 ',
        testEnvironments: ['Chrome', ' ', 'Chrome', 'Linux'],
        user: 'admin',
      },
      tests: [{ testKey: 'CALC-1', status: 'PASSED' }],
    });

    expect(result.xray).toEqual({
      execution_key: 'CALC-TE7',
      summary: 'Nightly run',
      description: 'All regression tests',
      version: 'v1.2',
      revision: 'abc123',
      test_plan_key: 'CALC-TP3',
      test_environments: ['Chrome', 'Linux'],
    });
  });

  it('has no details when the file gives none', () => {
    const result = xray({ tests: [{ testKey: 'CALC-1', status: 'PASSED' }] });

    expect(result.xray).toBeUndefined();
  });

  it('leaves out an execution key that is not a ticket key', () => {
    const result = xray({
      testExecutionKey: 'nightly',
      info: { summary: 'Run' },
      tests: [{ testKey: 'CALC-1', status: 'PASSED' }],
    });

    expect(result.xray).toEqual({ summary: 'Run' });
  });

  it('reaches the details through parseResultFile', () => {
    const result = parseResultFile(
      Buffer.from(
        JSON.stringify({
          info: { testPlanKey: 'CALC-TP1' },
          tests: [{ testKey: 'CALC-1', status: 'PASSED' }],
        }),
      ),
      { format: 'xray' },
    );

    expect(result.xray).toEqual({ test_plan_key: 'CALC-TP1' });
  });
});
