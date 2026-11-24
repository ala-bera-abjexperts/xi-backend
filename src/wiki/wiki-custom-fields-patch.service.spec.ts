/**
 * @fileoverview Unit tests for WikiService.patchCustomFieldValues — the
 * merge-semantics endpoint behind wiki page custom-field editing.
 *
 * Why this exists as its own path (and these tests as its contract):
 * - TWO surfaces edit these values (the right-rail properties panel and the
 *   in-body properties block). Full-map writes let a surface holding a stale
 *   baseline wipe the other's fields; merging only the supplied keys cannot.
 * - An explicit `null` is the delete sentinel, because omission already means
 *   "leave untouched" — without it, clearing a value would be inexpressible.
 * - It never touches page content, so it is deliberately exempt from the
 *   collab-active gate that made property autosaves 409 while someone was
 *   co-editing the body.
 *
 * @module src/wiki/wiki-custom-fields-patch.service.spec
 */

jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (v: string | null | undefined) => v ?? null,
}));

import { WikiService } from './wiki.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import { WikiFieldKeysService } from './wiki-field-keys.service';

const ORG = '11111111-1111-1111-1111-111111111111';
const SPACE = '22222222-2222-2222-2222-222222222222';
const PAGE = '33333333-3333-3333-3333-333333333333';
const USER = '44444444-4444-4444-4444-444444444444';

describe('WikiService.patchCustomFieldValues', () => {
  let service: WikiService;
  let mockFrom: jest.Mock;
  let updateSpy: jest.Mock;
  let fieldKeys: { assertKeysAllowed: jest.Mock };

  /** Captures the payload handed to .update() so we can assert the merge. */
  function buildUpdateChain(returned: unknown) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.update = updateSpy.mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue({ data: returned, error: null });
    chain.maybeSingle = jest
      .fn()
      .mockResolvedValue({ data: returned, error: null });
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve({ data: returned, error: null }).then(onFulfilled);

    return chain;
  }

  function givenStoredValues(stored: Record<string, unknown>) {
    jest.spyOn(service, 'getPageById').mockResolvedValue({
      id: PAGE,
      space_id: SPACE,
      organization_id: ORG,
      title: 'Page',
      custom_field_values: stored,
    });
  }

  /** The merged map actually written to the DB. */
  function writtenValues(): Record<string, unknown> {
    const payload = updateSpy.mock.calls[0][0] as Record<string, unknown>;

    return payload.custom_field_values as Record<string, unknown>;
  }

  beforeEach(() => {
    updateSpy = jest.fn();
    mockFrom = jest
      .fn()
      .mockImplementation(() => buildUpdateChain({ id: PAGE }));

    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    fieldKeys = { assertKeysAllowed: jest.fn().mockResolvedValue(undefined) };

    service = new WikiService(
      supa,
      { assertPageAccess: jest.fn() } as unknown as WikiPermissionsService,
      fieldKeys as unknown as WikiFieldKeysService,
    );
  });

  it('merges new keys without dropping existing ones', async () => {
    givenStoredValues({ owner: 'alice', priority: 'high' });

    await service.patchCustomFieldValues(
      PAGE,
      SPACE,
      { reviewer: 'bob' },
      USER,
    );

    expect(writtenValues()).toEqual({
      owner: 'alice',
      priority: 'high',
      reviewer: 'bob',
    });
  });

  it('overwrites only the supplied key', async () => {
    givenStoredValues({ owner: 'alice', priority: 'high' });

    await service.patchCustomFieldValues(PAGE, SPACE, { owner: 'carol' }, USER);

    expect(writtenValues()).toEqual({ owner: 'carol', priority: 'high' });
  });

  it('treats an explicit null as "delete this key"', async () => {
    givenStoredValues({ owner: 'alice', priority: 'high' });

    await service.patchCustomFieldValues(PAGE, SPACE, { owner: null }, USER);

    expect(writtenValues()).toEqual({ priority: 'high' });
    expect(writtenValues()).not.toHaveProperty('owner');
  });

  it('does not clobber a sibling key edited from the other surface', async () => {
    // The regression this endpoint exists to prevent: the body block saves
    // `owner` while the right rail's baseline still lacks `reviewer`. Because
    // each surface sends only its own key, `reviewer` survives.
    givenStoredValues({ owner: 'alice', reviewer: 'bob' });

    await service.patchCustomFieldValues(PAGE, SPACE, { owner: 'carol' }, USER);

    expect(writtenValues()).toEqual({ owner: 'carol', reviewer: 'bob' });
  });

  it('handles a page with no stored values yet', async () => {
    givenStoredValues({});

    await service.patchCustomFieldValues(PAGE, SPACE, { owner: 'alice' }, USER);

    expect(writtenValues()).toEqual({ owner: 'alice' });
  });

  it('tolerates a null custom_field_values column', async () => {
    jest.spyOn(service, 'getPageById').mockResolvedValue({
      id: PAGE,
      space_id: SPACE,
      organization_id: ORG,
      custom_field_values: null,
    });

    await service.patchCustomFieldValues(PAGE, SPACE, { owner: 'alice' }, USER);

    expect(writtenValues()).toEqual({ owner: 'alice' });
  });

  it('validates keys against the space allow-list, tolerating stored keys', async () => {
    givenStoredValues({ legacy_key: 'x' });

    await service.patchCustomFieldValues(PAGE, SPACE, { owner: 'alice' }, USER);

    expect(fieldKeys.assertKeysAllowed).toHaveBeenCalledWith(
      ORG,
      SPACE,
      ['owner'],
      ['legacy_key'],
    );
  });

  it('propagates a rejection from the allow-list gate', async () => {
    givenStoredValues({});
    fieldKeys.assertKeysAllowed.mockRejectedValue(new Error('not assigned'));

    await expect(
      service.patchCustomFieldValues(PAGE, SPACE, { nope: 1 }, USER),
    ).rejects.toThrow('not assigned');

    // Nothing must be written when the gate rejects.
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('never reads the collab snapshot table (no collab-active gate)', async () => {
    givenStoredValues({});

    await service.patchCustomFieldValues(PAGE, SPACE, { owner: 'a' }, USER);

    const tables = mockFrom.mock.calls.map((c) => c[0] as string);

    expect(tables).not.toContain('wiki_page_collab_snapshots');
  });

  it('does not write title or content (cannot trip the versioning trigger)', async () => {
    givenStoredValues({});

    await service.patchCustomFieldValues(PAGE, SPACE, { owner: 'a' }, USER);

    const payload = updateSpy.mock.calls[0][0] as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      'custom_field_values',
      'updated_at',
      'updated_by',
    ]);
  });
});
