/**
 * @fileoverview Unit tests for WikiFieldKeysService — the allow-list that
 * decides which custom fields a space's wiki accepts values for.
 *
 * This replaced a `custom_fields.contexts.includes('wiki')` gate that could
 * never pass (nothing in the product writes 'wiki' into that column), so every
 * custom-field save on a wiki page was rejected with a 400. These tests lock in
 * the replacement behaviour: assignments are the source of truth, group
 * assignments expand to their members, and keys already stored on the page are
 * always tolerated so one stale key cannot block unrelated edits forever.
 *
 * @module src/wiki/wiki-field-keys.service.spec
 */

import { BadRequestException } from '@nestjs/common';

import { WikiFieldKeysService } from './wiki-field-keys.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

const ORG = '11111111-1111-1111-1111-111111111111';
const SPACE = '22222222-2222-2222-2222-222222222222';

/** Minimal PostgREST chain double: builders return `this`, the chain is thenable. */
function buildChain(resolved: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;

  chain.select = jest.fn().mockImplementation(self);
  chain.eq = jest.fn().mockImplementation(self);
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled);

  return chain;
}

describe('WikiFieldKeysService', () => {
  let service: WikiFieldKeysService;
  let mockFrom: jest.Mock;

  function withAssignments(rows: unknown[]) {
    mockFrom.mockReturnValue(buildChain({ data: rows, error: null }));
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    service = new WikiFieldKeysService(supa);
  });

  describe('getAssignedFieldKeys', () => {
    it('collects standalone assignment keys', async () => {
      withAssignments([
        { assignment_type: 'field', custom_field: { field_key: 'owner' } },
      ]);

      const keys = await service.getAssignedFieldKeys(ORG, SPACE);

      expect([...keys]).toEqual(['owner']);
    });

    it('expands group assignments into their member field keys', async () => {
      withAssignments([
        {
          assignment_type: 'group',
          field_group: {
            fields: [
              { custom_field: { field_key: 'review_date' } },
              { custom_field: { field_key: 'reviewer' } },
            ],
          },
        },
      ]);

      const keys = await service.getAssignedFieldKeys(ORG, SPACE);

      expect([...keys].sort()).toEqual(['review_date', 'reviewer']);
    });

    it('dedupes a field assigned both standalone and via a group', async () => {
      withAssignments([
        { assignment_type: 'field', custom_field: { field_key: 'owner' } },
        {
          assignment_type: 'group',
          field_group: { fields: [{ custom_field: { field_key: 'owner' } }] },
        },
      ]);

      const keys = await service.getAssignedFieldKeys(ORG, SPACE);

      expect([...keys]).toEqual(['owner']);
    });

    it('tolerates null embeds and missing members without throwing', async () => {
      withAssignments([
        { assignment_type: 'field', custom_field: null },
        { assignment_type: 'group', field_group: null },
        { assignment_type: 'group', field_group: { fields: null } },
        {
          assignment_type: 'group',
          field_group: { fields: [{ custom_field: null }] },
        },
      ]);

      const keys = await service.getAssignedFieldKeys(ORG, SPACE);

      expect(keys.size).toBe(0);
    });

    it('returns an empty set (no query) when org or space is missing', async () => {
      const keys = await service.getAssignedFieldKeys('', SPACE);

      expect(keys.size).toBe(0);
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('scopes the query by organization AND space', async () => {
      const chain = buildChain({ data: [], error: null });

      mockFrom.mockReturnValue(chain);

      await service.getAssignedFieldKeys(ORG, SPACE);

      expect(mockFrom).toHaveBeenCalledWith('wiki_field_assignments');
      expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(chain.eq).toHaveBeenCalledWith('space_id', SPACE);
    });
  });

  describe('assertKeysAllowed', () => {
    it('accepts a key assigned standalone', async () => {
      withAssignments([
        { assignment_type: 'field', custom_field: { field_key: 'owner' } },
      ]);

      await expect(
        service.assertKeysAllowed(ORG, SPACE, ['owner']),
      ).resolves.toBeUndefined();
    });

    it('accepts a key that comes from an assigned group', async () => {
      withAssignments([
        {
          assignment_type: 'group',
          field_group: {
            fields: [{ custom_field: { field_key: 'reviewer' } }],
          },
        },
      ]);

      await expect(
        service.assertKeysAllowed(ORG, SPACE, ['reviewer']),
      ).resolves.toBeUndefined();
    });

    it('rejects an unassigned key and names it', async () => {
      withAssignments([
        { assignment_type: 'field', custom_field: { field_key: 'owner' } },
      ]);

      await expect(
        service.assertKeysAllowed(ORG, SPACE, ['not_assigned']),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.assertKeysAllowed(ORG, SPACE, ['not_assigned']),
      ).rejects.toThrow(/not_assigned/);
    });

    it('tolerates an unassigned key that is already stored on the page', async () => {
      withAssignments([
        { assignment_type: 'field', custom_field: { field_key: 'owner' } },
      ]);

      // The panel PUTs the full map; without tolerance a single un-assigned
      // legacy key would 400 every unrelated edit forever.
      await expect(
        service.assertKeysAllowed(
          ORG,
          SPACE,
          ['legacy_key', 'owner'],
          ['legacy_key'],
        ),
      ).resolves.toBeUndefined();
    });

    it('short-circuits on an empty key list without querying', async () => {
      await expect(
        service.assertKeysAllowed(ORG, SPACE, []),
      ).resolves.toBeUndefined();

      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('still rejects when the space has no assignments at all', async () => {
      withAssignments([]);

      await expect(
        service.assertKeysAllowed(ORG, SPACE, ['owner']),
      ).rejects.toThrow(/owner/);
    });

    it('uses the supplied label in the error message', async () => {
      withAssignments([]);

      await expect(
        service.assertKeysAllowed(ORG, SPACE, ['bad'], undefined, 'sort key'),
      ).rejects.toThrow(/sort key/);
    });

    it('surfaces a database error as a BadRequest', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'boom' } }),
      );

      await expect(
        service.assertKeysAllowed(ORG, SPACE, ['owner']),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
