/**
 * @fileoverview Unit tests for ResolutionRequiredValidator.
 * @module src/workflow-engine/handlers/validators/resolution-required.validator.spec
 * @author Rajbha Manek
 */

import {
  ResolutionRequiredValidator,
  type ResolutionRequiredConfig,
} from './resolution-required.validator';
import type { IEvaluationContext } from '../handler.types';

describe('ResolutionRequiredValidator', () => {
  const handler = new ResolutionRequiredValidator();
  const resolutionId = '123e4567-e89b-12d3-a456-426614174004';
  const otherResolutionId = '123e4567-e89b-12d3-a456-426614174005';

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
    it('accepts a config without resolution_id', () => {
      const r = handler.schema.safeParse({
        type: 'resolution_required',
      });

      expect(r.success).toBe(true);
    });

    it('accepts a config with resolution_id', () => {
      const r = handler.schema.safeParse({
        type: 'resolution_required',
        resolution_id: resolutionId,
      });

      expect(r.success).toBe(true);
    });

    it('rejects non-uuid resolution_id', () => {
      const r = handler.schema.safeParse({
        type: 'resolution_required',
        resolution_id: 'not-a-uuid',
      });

      expect(r.success).toBe(false);
    });

    it('rejects wrong type discriminator', () => {
      const r = handler.schema.safeParse({
        type: 'something_else',
      });

      expect(r.success).toBe(false);
    });
  });

  describe('validate', () => {
    it('invalid when task has no resolution and no specific resolution required', async () => {
      const cfg: ResolutionRequiredConfig = { type: 'resolution_required' };
      const result = await handler.validate(
        cfg,
        ctx({ task: { resolution_id: null } }),
      );

      expect(result.ok).toBe(false);
      expect(result.fieldPath).toBe('resolution_id');
    });

    it('ok when task has any resolution and no specific resolution required', async () => {
      const cfg: ResolutionRequiredConfig = { type: 'resolution_required' };
      const result = await handler.validate(
        cfg,
        ctx({ task: { resolution_id: resolutionId } }),
      );

      expect(result.ok).toBe(true);
    });

    it('ok when task resolution matches specified resolution_id', async () => {
      const cfg: ResolutionRequiredConfig = {
        type: 'resolution_required',
        resolution_id: resolutionId,
      };
      const result = await handler.validate(
        cfg,
        ctx({ task: { resolution_id: resolutionId } }),
      );

      expect(result.ok).toBe(true);
    });

    it('invalid when task resolution does not match specified resolution_id', async () => {
      const cfg: ResolutionRequiredConfig = {
        type: 'resolution_required',
        resolution_id: resolutionId,
      };
      const result = await handler.validate(
        cfg,
        ctx({ task: { resolution_id: otherResolutionId } }),
      );

      expect(result.ok).toBe(false);
    });

    it('invalid when task is null', async () => {
      const cfg: ResolutionRequiredConfig = { type: 'resolution_required' };
      const result = await handler.validate(cfg, ctx({ task: null }));

      expect(result.ok).toBe(false);
    });

    it('uses custom message on failure', async () => {
      const cfg: ResolutionRequiredConfig = {
        type: 'resolution_required',
        message: 'Pick a resolution before completing',
      };
      const result = await handler.validate(
        cfg,
        ctx({ task: { resolution_id: null } }),
      );

      expect(result.message).toBe('Pick a resolution before completing');
    });
  });

  describe('findReferences', () => {
    it('returns resolution id when specified', () => {
      const refs = handler.findReferences({
        type: 'resolution_required',
        resolution_id: resolutionId,
      });

      expect(refs).toEqual([{ kind: 'resolution', id: resolutionId }]);
    });

    it('returns empty list when no resolution specified', () => {
      const refs = handler.findReferences({
        type: 'resolution_required',
      });

      expect(refs).toEqual([]);
    });
  });
});
