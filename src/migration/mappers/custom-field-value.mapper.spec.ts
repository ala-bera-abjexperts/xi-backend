/**
 * `toXisuiteFieldValue` unit tests (pure — no DI).
 *
 * Every fixture below is a REAL value taken from Jira SDP-1, the issue used to verify the live
 * migration. The bug these guard against: storing Jira's raw JSON made the task detail page throw
 * `Objects are not valid as a React child (found: object with keys {id, self, value, disabled})`
 * and render blank, while the database looked perfectly populated.
 */

import { toXisuiteFieldValue } from './custom-field-value.mapper';

const opt = (id: string, value: string) => ({
  id,
  self: `http://jira/rest/api/2/customFieldOption/${id}`,
  value,
  disabled: false,
});

describe('toXisuiteFieldValue', () => {
  describe('option-bearing types → the option VALUE (= Jira option id)', () => {
    it('maps a multi-checkbox array to option ids (SDP-1: Alpha | Gamma)', () => {
      expect(
        toXisuiteFieldValue(
          [opt('10003', 'Alpha'), opt('10005', 'Gamma')],
          'multiselect',
        ),
      ).toEqual(['10003', '10005']);
    });

    it('maps a single select to a scalar id (SDP-1: Alpha)', () => {
      expect(toXisuiteFieldValue(opt('10012', 'Alpha'), 'select')).toBe(
        '10012',
      );
    });

    it('maps radio the same way (SDP-1: Beta)', () => {
      expect(toXisuiteFieldValue(opt('10007', 'Beta'), 'radio')).toBe('10007');
    });

    it('maps a cascading select to the CHILD id (SDP-1: Alpha > Alpha One)', () => {
      const cascading = {
        ...opt('10015', 'Alpha'),
        child: opt('10018', 'Alpha One'),
      };

      expect(toXisuiteFieldValue(cascading, 'cascading_select')).toBe('10018');
    });

    it('falls back to the parent when a cascading value has no child', () => {
      expect(
        toXisuiteFieldValue(opt('10015', 'Alpha'), 'cascading_select'),
      ).toBe('10015');
    });

    it('uses the id, NOT the human label — the renderer looks up options by id', () => {
      // Returning "Alpha" would match no option and display a raw string forever.
      expect(toXisuiteFieldValue(opt('10012', 'Alpha'), 'select')).not.toBe(
        'Alpha',
      );
    });
  });

  describe('users → XISUITE ids via the crosswalk', () => {
    const resolve = (s: string) =>
      s === 'christian.kienzl' ? 'user-uuid-1' : null;

    it('resolves a single user picker', () => {
      expect(
        toXisuiteFieldValue(
          { name: 'christian.kienzl' },
          'user_select',
          resolve,
        ),
      ).toBe('user-uuid-1');
    });

    it('DROPS an unresolvable user rather than storing a raw username', () => {
      // The renderer treats the value as a user id; a username renders as a broken user forever.
      expect(
        toXisuiteFieldValue({ name: 'ghost' }, 'user_select', resolve),
      ).toBeUndefined();
    });

    it('resolves multi-user pickers and drops the unresolvable ones', () => {
      expect(
        toXisuiteFieldValue(
          [{ name: 'christian.kienzl' }, { name: 'ghost' }],
          'user_multi',
          resolve,
        ),
      ).toEqual(['user-uuid-1']);
    });

    it('omits the field when no user resolves', () => {
      expect(
        toXisuiteFieldValue([{ name: 'ghost' }], 'user_multi', resolve),
      ).toBeUndefined();
    });
  });

  describe('checkbox', () => {
    it('treats the STRING "false" as false (SDP-1: Job Checkbox / Hidden Job Switch)', () => {
      // Boolean("false") === true — the exact trap this guards.
      expect(toXisuiteFieldValue('false', 'checkbox')).toBe(false);
      expect(toXisuiteFieldValue('true', 'checkbox')).toBe(true);
    });
  });

  describe('entity pickers degraded to label', () => {
    it('renders a project picker as its name (SDP-1: SCRUM DEFAULT Project)', () => {
      expect(
        toXisuiteFieldValue(
          { id: '10000', key: 'SDP', name: 'SCRUM DEFAULT Project' },
          'label',
        ),
      ).toBe('SCRUM DEFAULT Project');
    });

    it('joins multi-entity pickers', () => {
      expect(
        toXisuiteFieldValue([{ name: 'v1.0' }, { name: 'v2.0' }], 'label'),
      ).toBe('v1.0, v2.0');
    });
  });

  describe('scalars pass through', () => {
    it.each([
      ['SDP migration test value', 'string'],
      [42.5, 'number'],
      ['2026-07-20', 'date'],
      ['2026-07-20T15:30:00.000+0000', 'datetime'],
      ['https://example.com/sdp-migration-test', 'url'],
    ])('keeps %p for type %s', (value, type) => {
      expect(toXisuiteFieldValue(value, type)).toBe(value);
    });

    it('never emits "[object Object]" for an unexpected object', () => {
      const out = toXisuiteFieldValue({ name: 'Thing' }, 'string');

      expect(out).toBe('Thing');
      expect(String(out)).not.toContain('object Object');
    });
  });

  describe('emptiness → omit the key entirely', () => {
    it.each([null, undefined, []])('omits %p', (value) => {
      expect(toXisuiteFieldValue(value, 'multiselect')).toBeUndefined();
    });
  });
});
