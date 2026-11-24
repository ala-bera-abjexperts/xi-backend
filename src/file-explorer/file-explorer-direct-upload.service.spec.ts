/**
 * @fileoverview Unit tests for the direct-to-storage upload flow (`upload-init` / `upload-complete`).
 *
 * Follows the construction style already used by `file-explorer.service.spec.ts`: the service is
 * built with `new` and hand-rolled stubs rather than `Test.createTestingModule`, and the supabase
 * client is a bare `{ from, rpc }` whose builders are chainable jest mocks. Guards, pipes, and
 * interceptors are therefore NOT exercised here — controller-level permission metadata is asserted
 * separately in `file-explorer.controller.spec.ts`.
 */

import { ConflictException, PayloadTooLargeException } from '@nestjs/common';
import { FileExplorerService } from './file-explorer.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { IFeNode } from './interfaces/fe-node.interface';

describe('FileExplorerService direct upload', () => {
  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    email: 'user@example.com',
    organizationId: 'org-1',
    memberships: [],
  } satisfies RequestUser;

  const node: IFeNode = {
    id: 'node-1',
    organization_id: 'org-1',
    space_id: 'space-1',
    parent_id: null,
    ancestor_ids: [],
    node_type: 'file',
    name: 'big.zip',
    description: null,
    mime_type: 'application/zip',
    file_size: 0,
    current_version_id: null,
    delete_op_id: null,
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    created_by: 'user-1',
    updated_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  /** A chainable supabase query builder whose terminal call resolves to `result`. */
  function chain(result: unknown = { data: null, error: null }) {
    const c: Record<string, jest.Mock> = {};
    for (const m of ['select', 'update', 'delete', 'eq', 'in']) {
      c[m] = jest.fn().mockReturnValue(c);
    }
    c['insert'] = jest.fn().mockResolvedValue(result);
    c['maybeSingle'] = jest.fn().mockResolvedValue(result);
    // `.eq()` is both an intermediate and a terminal call depending on the statement, so it has to
    // be thenable as well as chainable.
    c['eq'] = jest
      .fn()
      .mockReturnValue(
        Object.assign(Promise.resolve(result), c) as unknown as Record<
          string,
          jest.Mock
        >,
      );

    return c;
  }

  let from: jest.Mock;
  let rpc: jest.Mock;
  let repo: {
    findNode: jest.Mock;
    insertFileNode: jest.Mock;
    enrichNodes: jest.Mock;
  };
  let storage: {
    buildKey: jest.Mock;
    createSignedUploadUrl: jest.Mock;
    statObject: jest.Mock;
    removePaths: jest.Mock;
  };
  let storageConfig: { checkUploadAllowed: jest.Mock };
  let service: FileExplorerService;

  beforeEach(() => {
    from = jest.fn().mockImplementation(() => chain());
    rpc = jest.fn().mockResolvedValue({ data: 1, error: null });

    repo = {
      findNode: jest.fn().mockResolvedValue(node),
      insertFileNode: jest.fn().mockResolvedValue(node),
      enrichNodes: jest.fn().mockResolvedValue([node]),
    };

    storage = {
      buildKey: jest.fn().mockReturnValue('org-1/file-explorer/s/n/v/big.zip'),
      createSignedUploadUrl: jest.fn().mockResolvedValue({
        signedUrl: 'https://storage.example/signed',
        token: 'tok-1',
        path: 'org-1/file-explorer/s/n/v/big.zip',
      }),
      statObject: jest.fn().mockResolvedValue({ size: 1024 }),
      removePaths: jest.fn().mockResolvedValue(undefined),
    };

    storageConfig = {
      checkUploadAllowed: jest.fn().mockResolvedValue({
        allowed: true,
        quota: 100,
        used: 0,
        remaining: 100,
      }),
    };

    service = new FileExplorerService(
      { getClient: () => ({ from, rpc }) } as never,
      repo as never,
      storage as never,
      { logAction: jest.fn().mockResolvedValue(undefined) } as never,
      {
        resolveEffectivePermission: jest.fn().mockResolvedValue({
          canView: true,
          canCreate: true,
          canDelete: true,
        }),
      } as never,
      storageConfig as never,
    );
  });

  describe('initDirectUpload', () => {
    it('reserves a pending version and returns a signed upload URL', async () => {
      const result = await service.initDirectUpload(user, 'space-1', {
        name: 'big.zip',
        size: 1024,
        mime_type: 'application/zip',
      });

      expect(result.signedUrl).toBe('https://storage.example/signed');
      expect(result.nodeId).toBe('node-1');
      expect(result.token).toBe('tok-1');
      expect(repo.insertFileNode).toHaveBeenCalled();

      // The version must land 'pending' — an 'active' row here would be counted against quota and
      // referenced by the node before any bytes exist.
      const inserted = from.mock.results
        .map((r) => r.value as Record<string, jest.Mock>)
        .find((c) => c['insert'].mock.calls.length > 0);
      expect(inserted?.['insert']).toHaveBeenCalledWith(
        expect.objectContaining({ upload_status: 'pending' }),
      );
    });

    it('rejects when the declared size exceeds the storage quota', async () => {
      storageConfig.checkUploadAllowed.mockResolvedValue({
        allowed: false,
        quota: 100,
        used: 100,
        remaining: 0,
      });

      await expect(
        service.initDirectUpload(user, 'space-1', {
          name: 'big.zip',
          size: 5000,
        }),
      ).rejects.toThrow(PayloadTooLargeException);

      // Quota is checked BEFORE anything is written.
      expect(repo.insertFileNode).not.toHaveBeenCalled();
      expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
    });

    it('maps a duplicate-name unique violation to 409', async () => {
      repo.insertFileNode.mockRejectedValue({ code: '23505' });

      await expect(
        service.initDirectUpload(user, 'space-1', {
          name: 'big.zip',
          size: 1024,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('completeDirectUpload', () => {
    function pendingVersion(overrides: Record<string, unknown> = {}) {
      return {
        data: {
          id: 'version-1',
          node_id: 'node-1',
          file_path: 'org-1/file-explorer/s/n/v/big.zip',
          mime_type: 'application/zip',
          version_number: 1,
          upload_status: 'pending',
          ...overrides,
        },
        error: null,
      };
    }

    it('activates the version using the REAL uploaded size, not the declared one', async () => {
      from.mockImplementation(() => chain(pendingVersion()));
      storage.statObject.mockResolvedValue({ size: 987 });

      await service.completeDirectUpload(user, 'node-1', 'version-1');

      // Quota is re-checked against what actually landed in storage.
      expect(storageConfig.checkUploadAllowed).toHaveBeenCalledWith(
        'org-1',
        'user-1',
        987,
      );

      const activated = from.mock.results
        .map((r) => r.value as Record<string, jest.Mock>)
        .find((c) => c['update'].mock.calls.length > 0);
      expect(activated?.['update']).toHaveBeenCalledWith(
        expect.objectContaining({ upload_status: 'active', file_size: 987 }),
      );
    });

    it('rejects and discards the object when no bytes were uploaded', async () => {
      from.mockImplementation(() => chain(pendingVersion()));
      storage.statObject.mockResolvedValue(null);

      await expect(
        service.completeDirectUpload(user, 'node-1', 'version-1'),
      ).rejects.toThrow(/PUT the file to the signed URL/);
    });

    it('discards the uploaded object when the real size blows the quota', async () => {
      from.mockImplementation(() => chain(pendingVersion()));
      storage.statObject.mockResolvedValue({ size: 999_999 });
      storageConfig.checkUploadAllowed.mockResolvedValue({
        allowed: false,
        quota: 100,
        used: 0,
        remaining: 100,
      });

      await expect(
        service.completeDirectUpload(user, 'node-1', 'version-1'),
      ).rejects.toThrow(PayloadTooLargeException);

      // The bytes are already on disk and uncounted, so they must not be left behind.
      expect(storage.removePaths).toHaveBeenCalledWith([
        'org-1/file-explorer/s/n/v/big.zip',
      ]);
    });

    it('is idempotent — re-confirming an active version returns the node', async () => {
      from.mockImplementation(() =>
        chain(pendingVersion({ upload_status: 'active' })),
      );

      await expect(
        service.completeDirectUpload(user, 'node-1', 'version-1'),
      ).resolves.toBeDefined();

      // No second stat / quota round-trip on a replay.
      expect(storage.statObject).not.toHaveBeenCalled();
    });
  });
});
