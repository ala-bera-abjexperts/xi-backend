/**
 * @fileoverview Unit tests for ScreenFieldsRequiredValidator.
 * @module src/workflow-engine/handlers/validators/screen-fields-required.validator.spec
 * @author Rajbha Manek
 */

import {
  ScreenFieldsRequiredValidator,
  type ScreenFieldsRequiredConfig,
} from './screen-fields-required.validator';
import type { IEvaluationContext } from '../handler.types';

describe('ScreenFieldsRequiredValidator', () => {
  const handler = new ScreenFieldsRequiredValidator();
  const groupId = '123e4567-e89b-12d3-a456-426614174006';
  const fieldA = '123e4567-e89b-12d3-a456-426614174007';
  const fieldB = '123e4567-e89b-12d3-a456-426614174008';

  const ctx = (
    overrides: Partial<IEvaluationContext> = {},
  ): IEvaluationContext => ({
    organizationId: 'org-1',
    spaceId: 'space-1',
    taskId: 'task-1',
    task: null,
    transitionId: 'tx-1',
    transition: null,
    userId: 'user-1',
    user: null,
    userRoles: [],
    userGroups: [],
    customFieldValues: {},
    ...overrides,
  });

  describe('schema', () => {
    it('accepts a valid config', () => {
      const r = handler.schema.safeParse({
        type: 'screen_fields_required',
        screen_field_group_id: groupId,
      });

      expect(r.success).toBe(true);
    });

    it('accepts a config with custom message', () => {
      const r = handler.schema.safeParse({
        type: 'screen_fields_required',
        screen_field_group_id: groupId,
        message: 'Fill in all required fields',
      });

      expect(r.success).toBe(true);
    });

    it('rejects non-uuid screen_field_group_id', () => {
      const r = handler.schema.safeParse({
        type: 'screen_fields_required',
        screen_field_group_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'something_else',
        screen_field_group_id: groupId,
      });

      expect(r.success).toBe(false);
    });
  });

  describe('validate', () => {
    const cfg: ScreenFieldsRequiredConfig = {
      type: 'screen_fields_required',
      screen_field_group_id: groupId,
    };

    it('ok when all required fields are present', async () => {
      const result = await handler.validate(
        cfg,
        ctx({
          transition: {
            required_field_ids: [fieldA, fieldB],
            payload: { [fieldA]: 'a', [fieldB]: 'b' },
          },
        }),
      );

      expect(result.ok).toBe(true);
    });

    it('invalid with fieldPath pointing to the first missing field', async () => {
      const result = await handler.validate(
        cfg,
        ctx({
          transition: {
            required_field_ids: [fieldA, fieldB],
            payload: { [fieldB]: 'b' },
          },
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.fieldPath).toBe(fieldA);
    });

    it('invalid when a required field is empty string', async () => {
      const result = await handler.validate(
        cfg,
        ctx({
          transition: {
            required_field_ids: [fieldA],
            payload: { [fieldA]: '' },
          },
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.fieldPath).toBe(fieldA);
    });

    it('invalid when a required field is null', async () => {
      const result = await handler.validate(
        cfg,
        ctx({
          transition: {
            required_field_ids: [fieldA],
            payload: { [fieldA]: null },
          },
        }),
      );

      expect(result.ok).toBe(false);
    });

    it('invalid when a required field is an empty array', async () => {
      const result = await handler.validate(
        cfg,
        ctx({
          transition: {
            required_field_ids: [fieldA],
            payload: { [fieldA]: [] },
          },
        }),
      );

      expect(result.ok).toBe(false);
    });

    it('ok when required_field_ids is empty', async () => {
      const result = await handler.validate(
        cfg,
        ctx({
          transition: { required_field_ids: [], payload: {} },
        }),
      );

      expect(result.ok).toBe(true);
    });

    it('ok when required_field_ids is missing entirely (no requirements)', async () => {
      const result = await handler.validate(
        cfg,
        ctx({
          transition: { payload: {} },
        }),
      );

      expect(result.ok).toBe(true);
    });

    it('invalid when transition is missing', async () => {
      const result = await handler.validate(cfg, ctx({ transition: null }));

      expect(result.ok).toBe(false);
      expect(result.fieldPath).toBe('transition');
    });

    it('uses custom message on failure', async () => {
      const result = await handler.validate(
        { ...cfg, message: 'Please fill all required fields' },
        ctx({
          transition: {
            required_field_ids: [fieldA],
            payload: {},
          },
        }),
      );

      expect(result.message).toBe('Please fill all required fields');
    });
  });

  describe('findReferences', () => {
    it('returns the screen field group id as a field-group reference', () => {
      const refs = handler.findReferences({
        type: 'screen_fields_required',
        screen_field_group_id: groupId,
      });

      expect(refs).toEqual([{ kind: 'field_group', id: groupId }]);
    });
  });
});
