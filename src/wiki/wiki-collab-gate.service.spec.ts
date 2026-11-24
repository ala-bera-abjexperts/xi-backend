/**
 * @fileoverview Unit tests for the collab-active gate in WikiService.updatePage.
 *
 * The gate exists to stop a blind write clobbering the ydoc while someone is
 * co-editing the page body. It is deliberately scoped to writes that actually
 * carry `content`.
 *
 * Why that scoping is the contract and not an optimisation (XE-T458): the page
 * width toggle PUTs `{ metadata: { narrowWidth } }` and has no way to supply a
 * collabSessionId — `useUpdateWikiPage` is typed `Omit<IUpdateWikiPageInput,'id'>`,
 * which has no such field. While the gate fired on every write, that toggle 409'd
 * for the whole 120s session TTL and surfaced to the user as "save failed", which
 * also made it look intermittent (it kept failing after leaving edit mode).
 *
 * Both directions matter here, so both are asserted: property writes must pass,
 * and a content write from a non-owning session must still be rejected.
 *
 * @module src/wiki/wiki-collab-gate.service.spec
 */

jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (v: string | null | undefined) => v ?? null,
}));

import { ConflictException } from '@nestjs/common';

import { WikiService } from './wiki.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import { WikiFieldKeysService } from './wiki-field-keys.service';

const SPACE = '22222222-2222-2222-2222-222222222222';
const PAGE = '33333333-3333-3333-3333-333333333333';
const USER = '44444444-4444-4444-4444-444444444444';
const OWNING_SESSION = 'session-owned-by-someone-else';

const COLLAB_SNAPSHOTS = 'wiki_page_collab_snapshots';

describe('WikiService.updatePage — collab-active gate', () => {
  let service: WikiService;

  /**
   * `from()` branches on table: the snapshot read returns a LIVE session owned by
   * another client (heartbeat now), everything else behaves as a normal update chain.
   */
  function buildClient(snapshot: unknown) {
    return {
      from: jest.fn().mockImplementation((table: string) => {
        const chain: Record<string, unknown> = {};
        const self = () => chain;

        chain.select = jest.fn().mockImplementation(self);
        chain.update = jest.fn().mockImplementation(self);
        chain.insert = jest.fn().mockImplementation(self);
        chain.eq = jest.fn().mockImplementation(self);
        chain.order = jest.fn().mockImplementation(self);
        chain.limit = jest.fn().mockImplementation(self);

        const payload =
          table === COLLAB_SNAPSHOTS ? snapshot : { id: PAGE, space_id: SPACE };

        chain.maybeSingle = jest
          .fn()
          .mockResolvedValue({ data: payload, error: null });
        chain.single = jest
          .fn()
          .mockResolvedValue({ data: payload, error: null });
        chain.then = (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve({ data: payload, error: null }).then(onFulfilled);

        return chain;
      }),
    };
  }

  function givenLiveForeignSession() {
    const supa = {
      getClient: () =>
        buildClient({
          active_session_id: OWNING_SESSION,
          session_heartbeat_at: new Date().toISOString(),
        }),
    } as unknown as SupabaseAdminService;

    service = new WikiService(
      supa,
      { assertPageAccess: jest.fn() } as unknown as WikiPermissionsService,
      {
        assertKeysAllowed: jest.fn().mockResolvedValue(undefined),
      } as unknown as WikiFieldKeysService,
    );

    jest.spyOn(service, 'getPageById').mockResolvedValue({
      id: PAGE,
      space_id: SPACE,
      title: 'Page',
      is_published: false,
      is_archived: false,
      metadata: {},
    });
  }

  it('lets a metadata-only write through while another session is live (XE-T458)', async () => {
    givenLiveForeignSession();

    // Exactly what the width toggle sends: metadata, no collabSessionId.
    await expect(
      service.updatePage(
        PAGE,
        SPACE,
        { metadata: { narrowWidth: true } },
        USER,
      ),
    ).resolves.toBeDefined();
  });

  it('still rejects a CONTENT write from a non-owning session', async () => {
    givenLiveForeignSession();

    // The regression that matters: the ydoc must stay protected.
    await expect(
      service.updatePage(PAGE, SPACE, { content: '<p>clobber</p>' }, USER),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows a content write that carries the owning session id', async () => {
    givenLiveForeignSession();

    await expect(
      service.updatePage(
        PAGE,
        SPACE,
        { content: '<p>legit</p>', collabSessionId: OWNING_SESSION },
        USER,
      ),
    ).resolves.toBeDefined();
  });
});
