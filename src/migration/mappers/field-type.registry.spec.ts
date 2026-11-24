/**
 * P5 field-type registry unit tests (pure — no jsdom/sanitizer import, which Jest can't transform).
 *
 * The regression these exist to prevent: SILENT fidelity loss. A field that maps to a type whose
 * options are dropped, or that degrades without a `lossy` note, produces a migration that reports
 * success while quietly losing customer data.
 */

import { FIELD_TYPES_WITH_OPTIONS } from '../../custom-fields/models/custom-field.model';
import type {
  NormalizedField,
  NormalizedFieldOption,
} from '../model/normalized';
import { mapField, toFieldKey } from './field-type.registry';

const CFT = 'com.atlassian.jira.plugin.system.customfieldtypes:';

const field = (over: Partial<NormalizedField> = {}): NormalizedField => ({
  sourceId: 'customfield_10100',
  name: 'Test Field',
  isCustom: true,
  schemaType: 'string',
  required: false,
  ...over,
});

const opt = (
  id: string,
  value: string,
  children?: NormalizedFieldOption[],
): NormalizedFieldOption => ({ id, value, ...(children ? { children } : {}) });

describe('P5 field-type registry', () => {
  describe('exclusion runs BEFORE type mapping', () => {
    it('skips system fields — they are native task columns owned by the issues phase', () => {
      const out = mapField(field({ isCustom: false, name: 'Summary' }));

      expect(out.kind).toBe('skip');
    });

    it('routes gh-sprint / gh-epic-link / gh-lexo-rank / gh-epic-label to native, never custom_field', () => {
      const natives: [string, string][] = [
        ['com.pyxis.greenhopper.jira:gh-sprint', 'sprint'],
        ['com.pyxis.greenhopper.jira:gh-epic-link', 'parent_task_id'],
        ['com.pyxis.greenhopper.jira:gh-lexo-rank', 'rank'],
        ['com.pyxis.greenhopper.jira:gh-epic-label', 'title'],
      ];

      for (const [schemaCustom, native] of natives) {
        const out = mapField(field({ schemaCustom }));

        expect(out).toMatchObject({ kind: 'native', native });
      }
    });

    it('skips JPO/devsummary plugin-internal prefixes', () => {
      expect(
        mapField(
          field({
            schemaCustom: 'com.atlassian.jpo:jpo-custom-field-baseline-start',
          }),
        ).kind,
      ).toBe('skip');
      expect(
        mapField(
          field({
            schemaCustom:
              'com.atlassian.jira.plugins.jira-development-integration-plugin:devsummary',
          }),
        ).kind,
      ).toBe('skip');
    });

    it('excludes a native/plugin field EVEN WHEN it carries allowedValues (exclusion wins)', () => {
      const out = mapField(
        field({
          schemaCustom: 'com.pyxis.greenhopper.jira:gh-sprint',
          allowedValues: [opt('1', 'Sprint 1')],
        }),
      );

      expect(out.kind).toBe('native');
    });
  });

  describe('option-bearing types keep their options (the multicheckboxes regression)', () => {
    // The bug: multicheckboxes mapped to 'checkbox', which is NOT in FIELD_TYPES_WITH_OPTIONS, so
    // every allowed value was discarded AND no lossy note fired (the downgrade branch only runs for
    // option-bearing types). Silent data loss.
    it('maps multicheckboxes → multiselect and PRESERVES all options', () => {
      const out = mapField(
        field({
          schemaCustom: `${CFT}multicheckboxes`,
          name: 'Betroffene Systeme',
          allowedValues: [
            opt('10100', 'CRM'),
            opt('10101', 'ERP'),
            opt('10102', 'Shop'),
          ],
        }),
      );

      expect(out.kind).toBe('custom_field');
      if (out.kind !== 'custom_field') throw new Error('unreachable');

      expect(out.fieldType).toBe('multiselect');
      expect(FIELD_TYPES_WITH_OPTIONS).toContain(out.fieldType);
      expect(out.options).toHaveLength(3);
      expect(out.options.map((o) => o.value)).toEqual([
        '10100',
        '10101',
        '10102',
      ]);
      expect(out.lossy).toBeUndefined();
    });

    it('never maps any Jira type to a non-option-bearing type while dropping real options', () => {
      // Guards the whole class of bug, not just multicheckboxes.
      const optionBearingJiraTypes = [
        `${CFT}select`,
        `${CFT}multiselect`,
        `${CFT}radiobuttons`,
        `${CFT}multicheckboxes`,
        `${CFT}cascadingselect`,
      ];

      for (const schemaCustom of optionBearingJiraTypes) {
        const out = mapField(
          field({
            schemaCustom,
            allowedValues: [opt('1', 'A'), opt('2', 'B')],
          }),
        );

        expect(out.kind).toBe('custom_field');
        if (out.kind !== 'custom_field') throw new Error('unreachable');

        expect(out.options.length).toBeGreaterThan(0);
        expect(FIELD_TYPES_WITH_OPTIONS).toContain(out.fieldType);
      }
    });
  });

  describe('options are keyed on the Jira option ID, never the display value', () => {
    it('uses id for value and display text for label (test data is German/localized)', () => {
      const out = mapField(
        field({
          schemaCustom: `${CFT}select`,
          allowedValues: [opt('10500', 'Größe')],
        }),
      );

      if (out.kind !== 'custom_field') throw new Error('unreachable');
      expect(out.options[0]).toMatchObject({
        value: '10500',
        label: 'Größe',
        level: 0,
      });
    });

    it('flattens Jira nested cascading children to parent_value + level (FieldOption is FLAT)', () => {
      const out = mapField(
        field({
          schemaCustom: `${CFT}cascadingselect`,
          allowedValues: [
            opt('1', 'Parent', [opt('11', 'Child A'), opt('12', 'Child B')]),
          ],
        }),
      );

      if (out.kind !== 'custom_field') throw new Error('unreachable');
      expect(out.fieldType).toBe('cascading_select');
      expect(out.options).toEqual([
        { value: '1', label: 'Parent', level: 0 },
        { value: '11', label: 'Child A', parent_value: '1', level: 1 },
        { value: '12', label: 'Child B', parent_value: '1', level: 1 },
      ]);
    });
  });

  describe('empty options downgrade instead of throwing', () => {
    // CustomFieldsService.create throws BadRequestException on empty options for option-bearing
    // types — that would fail the whole item for what is really a fidelity loss.
    it('downgrades an option-less select to string WITH a lossy note', () => {
      const out = mapField(
        field({ schemaCustom: `${CFT}select`, allowedValues: [] }),
      );

      if (out.kind !== 'custom_field') throw new Error('unreachable');
      expect(out.fieldType).toBe('string');
      expect(out.options).toEqual([]);
      expect(out.lossy).toBeTruthy();
    });

    it('leaves NO option-bearing type with empty options (would throw in the service)', () => {
      for (const schemaCustom of [
        `${CFT}select`,
        `${CFT}multiselect`,
        `${CFT}radiobuttons`,
        `${CFT}multicheckboxes`,
        `${CFT}cascadingselect`,
      ]) {
        const out = mapField(field({ schemaCustom, allowedValues: undefined }));

        if (out.kind !== 'custom_field') throw new Error('unreachable');
        if (FIELD_TYPES_WITH_OPTIONS.includes(out.fieldType)) {
          expect(out.options.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('lossy vendor types are flagged, not dropped', () => {
    it('flags grouppicker/version/project as lossy label migrations', () => {
      for (const schemaCustom of [
        `${CFT}grouppicker`,
        `${CFT}version`,
        `${CFT}project`,
      ]) {
        const out = mapField(field({ schemaCustom }));

        if (out.kind !== 'custom_field') throw new Error('unreachable');
        expect(out.fieldType).toBe('label');
        expect(out.lossy).toBeTruthy();
      }
    });

    it('degrades an unknown vendor key to text with a lossy note rather than throwing', () => {
      const out = mapField(
        field({
          schemaCustom: 'com.acme:totally-unknown',
          schemaType: 'weird',
        }),
      );

      if (out.kind !== 'custom_field') throw new Error('unreachable');
      expect(out.fieldType).toBe('string');
      expect(out.lossy).toBeTruthy();
    });
  });

  describe('toFieldKey conforms to the DTO regex (stage code bypasses DTO validation)', () => {
    const RE = /^[a-z][a-z0-9_]*$/;

    it('produces a conforming key for realistic and hostile source ids', () => {
      for (const id of [
        'customfield_10012',
        'CUSTOMFIELD-10012',
        'summary',
        'field with spaces',
        'Größe-Feld',
        '123numeric-start',
        '___',
      ]) {
        expect(toFieldKey(id)).toMatch(RE);
      }
    });

    it('never emits a trailing underscore', () => {
      expect(toFieldKey('abc---')).not.toMatch(/_$/);
    });
  });

  it('marks required fields via validationRules', () => {
    const out = mapField(
      field({ schemaCustom: `${CFT}textfield`, required: true }),
    );

    if (out.kind !== 'custom_field') throw new Error('unreachable');
    expect(out.validationRules).toEqual({ required: true });
  });
});
