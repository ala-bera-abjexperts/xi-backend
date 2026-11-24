/**
 * @fileoverview Safety tests for the short-TTL effective-permissions cache in
 * PermissionsService.
 *
 * These are deliberately separate from permissions.service.spec.ts because they
 * test a SECURITY property, not a data-shape one. RLS is bypassed everywhere in
 * this codebase (all queries run as service_role), so the application-level
 * permission check is the only tenant boundary — which makes "can this cache
 * ever serve a stale allow?" the question that actually matters.
 *
 * The contract under test:
 *   1. Repeat reads inside the TTL are served from cache (the perf win).
 *   2. bustOrg forces a re-resolve (invalidation actually works).
 *   3. bustUser is scoped — it must not silently clear other users.
 *   4. Concurrent callers share one in-flight resolve (no stampede).
 *   5. A rejected resolve is evicted, not cached for the whole TTL.
 * @module src/permissions/permissions-cache-invalidation.spec
 */

import { PermissionsService } from './permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('PermissionsService — effective-permissions cache', () => {
  let service: PermissionsService;
  let mockFrom: jest.Mock;

  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';
  const USER = 'user-1';
  const OTHER_USER = 'user-2';

  /** Minimal thenable chain matching the supabase-js builder surface. */
  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);

    return chain;
  }

  /**
   * One full resolve issues 4 `from()` calls: organization_members, then the
   * parallel batch of user_role_assignments + user_group_members +
   * base_role_permission_overrides. Counting `from` is therefore a direct
   * proxy for "did we hit the database again".
   */
  const CALLS_PER_RESOLVE = 4;

  function primeSuccessfulResolve() {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'organization_members') {
        return buildChain({ data: { role: 'admin' }, error: null });
      }

      return buildChain({ data: [], error: null });
    });
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    service = new PermissionsService(supa);
  });

  it('serves a repeat read from cache instead of re-querying', async () => {
    primeSuccessfulResolve();

    const first = await service.getUserEffectivePermissions(USER, ORG);
    const callsAfterFirst = mockFrom.mock.calls.length;

    const second = await service.getUserEffectivePermissions(USER, ORG);

    expect(callsAfterFirst).toBe(CALLS_PER_RESOLVE);
    // No additional database work for the second read.
    expect(mockFrom.mock.calls.length).toBe(callsAfterFirst);
    expect(second).toEqual(first);
  });

  it('re-resolves after bustOrg — a revoked permission cannot be served stale', async () => {
    primeSuccessfulResolve();

    await service.getUserEffectivePermissions(USER, ORG);
    expect(mockFrom.mock.calls.length).toBe(CALLS_PER_RESOLVE);

    service.bustOrg(ORG);

    await service.getUserEffectivePermissions(USER, ORG);
    expect(mockFrom.mock.calls.length).toBe(CALLS_PER_RESOLVE * 2);
  });

  it('bustOrg clears every user in that org, and leaves other orgs alone', async () => {
    primeSuccessfulResolve();

    await service.getUserEffectivePermissions(USER, ORG);
    await service.getUserEffectivePermissions(OTHER_USER, ORG);
    await service.getUserEffectivePermissions(USER, OTHER_ORG);
    const primed = mockFrom.mock.calls.length;

    service.bustOrg(ORG);

    // Both ORG users must re-resolve...
    await service.getUserEffectivePermissions(USER, ORG);
    await service.getUserEffectivePermissions(OTHER_USER, ORG);
    expect(mockFrom.mock.calls.length).toBe(primed + CALLS_PER_RESOLVE * 2);

    // ...while the untouched org stays cached.
    const afterOrgRefresh = mockFrom.mock.calls.length;
    await service.getUserEffectivePermissions(USER, OTHER_ORG);
    expect(mockFrom.mock.calls.length).toBe(afterOrgRefresh);
  });

  it('bustUser is scoped to that one user', async () => {
    primeSuccessfulResolve();

    await service.getUserEffectivePermissions(USER, ORG);
    await service.getUserEffectivePermissions(OTHER_USER, ORG);
    const primed = mockFrom.mock.calls.length;

    service.bustUser(USER, ORG);

    await service.getUserEffectivePermissions(USER, ORG);
    expect(mockFrom.mock.calls.length).toBe(primed + CALLS_PER_RESOLVE);

    const afterUserRefresh = mockFrom.mock.calls.length;
    await service.getUserEffectivePermissions(OTHER_USER, ORG);
    expect(mockFrom.mock.calls.length).toBe(afterUserRefresh);
  });

  it('collapses concurrent callers into a single in-flight resolve', async () => {
    primeSuccessfulResolve();

    const [a, b, c] = await Promise.all([
      service.getUserEffectivePermissions(USER, ORG),
      service.getUserEffectivePermissions(USER, ORG),
      service.getUserEffectivePermissions(USER, ORG),
    ]);

    // One resolve, not three — this is what stops a cold cache from
    // stampeding the database under concurrent load.
    expect(mockFrom.mock.calls.length).toBe(CALLS_PER_RESOLVE);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('does not cache a failed resolve for the whole TTL', async () => {
    // `.single()` rejecting models a transport/PostgREST failure, which is the
    // case that must NOT be replayed to every caller until the TTL expires.
    mockFrom.mockImplementation(() => {
      const chain = buildChain({ data: null, error: null });
      chain.single = jest.fn().mockRejectedValue(new Error('boom'));
      return chain;
    });

    await expect(
      service.getUserEffectivePermissions(USER, ORG),
    ).rejects.toThrow('boom');

    // Next caller must get a fresh attempt, not the cached rejection.
    primeSuccessfulResolve();
    const callsBeforeRetry = mockFrom.mock.calls.length;

    const result = await service.getUserEffectivePermissions(USER, ORG);

    expect(mockFrom.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    expect(result.base_role).toBe('admin');
  });

  // ── Per-space cache ──────────────────────────────────────────────────────
  //
  // getUserSpacePermissions has 41 call sites and ~9 round trips per resolve.
  // These tests use the "space not found" early-return path, which costs exactly
  // one query, so `from` call counts map 1:1 onto resolves.

  describe('per-space permissions cache', () => {
    const SPACE = 'space-1';
    const OTHER_SPACE = 'space-2';

    function primeMissingSpace() {
      // `spaces` lookup returns null -> resolver early-returns a non-member result.
      mockFrom.mockImplementation(() =>
        buildChain({ data: null, error: null }),
      );
    }

    it('caches a repeat lookup for the same space', async () => {
      primeMissingSpace();

      await service.getUserSpacePermissions(USER, ORG, SPACE);
      expect(mockFrom.mock.calls.length).toBe(1);

      await service.getUserSpacePermissions(USER, ORG, SPACE);
      expect(mockFrom.mock.calls.length).toBe(1);
    });

    it('caches each space independently', async () => {
      primeMissingSpace();

      await service.getUserSpacePermissions(USER, ORG, SPACE);
      await service.getUserSpacePermissions(USER, ORG, OTHER_SPACE);

      expect(mockFrom.mock.calls.length).toBe(2);
    });

    it('bustOrg clears space entries — matching the org SEGMENT, not a suffix', async () => {
      primeMissingSpace();

      await service.getUserSpacePermissions(USER, ORG, SPACE);
      expect(mockFrom.mock.calls.length).toBe(1);

      // Keys are `user:org:space`, so a naive endsWith(':org') test would miss
      // these entirely and silently leave stale authorization cached.
      service.bustOrg(ORG);

      await service.getUserSpacePermissions(USER, ORG, SPACE);
      expect(mockFrom.mock.calls.length).toBe(2);
    });

    it('bustUser clears only that user, leaving other users cached', async () => {
      primeMissingSpace();

      await service.getUserSpacePermissions(USER, ORG, SPACE);
      await service.getUserSpacePermissions(OTHER_USER, ORG, SPACE);
      expect(mockFrom.mock.calls.length).toBe(2);

      service.bustUser(USER, ORG);

      await service.getUserSpacePermissions(USER, ORG, SPACE);
      expect(mockFrom.mock.calls.length).toBe(3);

      await service.getUserSpacePermissions(OTHER_USER, ORG, SPACE);
      expect(mockFrom.mock.calls.length).toBe(3);
    });

    it('collapses concurrent lookups for the same space into one resolve', async () => {
      primeMissingSpace();

      await Promise.all([
        service.getUserSpacePermissions(USER, ORG, SPACE),
        service.getUserSpacePermissions(USER, ORG, SPACE),
        service.getUserSpacePermissions(USER, ORG, SPACE),
      ]);

      expect(mockFrom.mock.calls.length).toBe(1);
    });
  });
});
