/**
 * @fileoverview Tests for persisted workflow-rule shape normalization.
 * @module src/workflow-engine/handlers/rule-config.spec
 * @author Rajbha Manek
 */

import { normalizeRuleConfig } from './rule-config';

describe('normalizeRuleConfig', () => {
  it('flattens editor rule entries into handler configs', () => {
    expect(
      normalizeRuleConfig({
        id: 'rule-1',
        type: 'field_required',
        config: {
          field_id: 'field-1',
          message: 'Required',
        },
      }),
    ).toEqual({
      type: 'field_required',
      field_id: 'field-1',
      message: 'Required',
    });
  });

  it('preserves already-flat backend configs', () => {
    const flat = {
      type: 'set_resolution',
      resolution_id: 'resolution-1',
    };

    expect(normalizeRuleConfig(flat)).toBe(flat);
  });

  it('normalizes recursive editor condition groups', () => {
    expect(
      normalizeRuleConfig({
        id: 'group-1',
        kind: 'group',
        op: 'all',
        children: [
          {
            id: 'rule-1',
            type: 'field_equals',
            config: { field_id: 'sys:summary', value: 'QA' },
          },
        ],
      }),
    ).toEqual({
      type: 'group',
      op: 'all',
      children: [
        {
          type: 'field_equals',
          field_id: 'sys:summary',
          value: 'QA',
        },
      ],
    });
  });
});
