/**
 * @fileoverview Unit tests for BackupTargetsService — tenant scoping, the write-only secret
 * contract, shape validation against target_type, and the conflict mappings the UI depends on.
 * @module src/backup/services/backup-targets.service.spec
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { BackupTargetsService } from './backup-targets.service';
import { BackupSecretsService } from './backup-secrets.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { SftpTargetAdapter } from '../adapters/sftp/sftp.adapter';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const USER = 'user-1';

const targetRow = {
  id: 'tgt-1',
  organization_id: ORG,
  name: 'Nightly SFTP',
  target_type: 'sftp',
  auth_method: 'sftp_password',
  config: { host: 'sftp.example.com', port: 22, username: 'backup' },
  secret_encrypted: 'ciphertext-value',
  secret_iv: 'iv',
  secret_tag: 'tag',
  key_fingerprint: null,
  is_enabled: true,
  is_revoked: false,
  last_tested_at: '2026-07-01T00:00:00Z',
  last_test_ok: true,
  last_test_error: null,
  last_used_at: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

const sftpConfig = {
  host: 'sftp.example.com',
  port: 22,
  username: 'backup',
  remote_dir: '/backups',
  host_key_sha256: 'SHA256:' + 'A'.repeat(43),
};

describe('BackupTargetsService', () => {
  let service: BackupTargetsService;
  let mockFrom: jest.Mock;
  const originalKey = process.env.AI_ENCRYPTION_SECRET;

  /** Awaitable query-builder stand-in: every method returns itself. */
  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    // Used by the archive-count aggregate, which filters on upload_state and deleted_at.
    chain.in = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolved).then(resolve);

    return chain;
  }

  beforeEach(() => {
    process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
    mockFrom = jest.fn();

    const supabase = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    // These tests cover tenant scoping and shape validation, never a connection, so the adapter is
    // a stub that fails loudly if a test ever reaches it by accident.
    const sftpAdapter = {
      kind: 'sftp' as const,
      verify: jest.fn().mockRejectedValue(new Error('verify not stubbed')),
    } as unknown as SftpTargetAdapter;

    service = new BackupTargetsService(
      supabase,
      new BackupSecretsService(),
      sftpAdapter,
    );
  });

  afterAll(() => {
    process.env.AI_ENCRYPTION_SECRET = originalKey;
  });

  describe('tenant scoping', () => {
    it('filters the list by the caller organization', async () => {
      const chain = buildChain({ data: [targetRow], error: null });

      mockFrom.mockReturnValue(chain);

      await service.list(ORG);

      expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
    });

    it('refuses to query without an active organization', async () => {
      await expect(service.list('')).rejects.toThrow(BadRequestException);
    });

    it('reports another organization id as not found, never as forbidden', async () => {
      mockFrom.mockReturnValue(buildChain({ data: null, error: null }));

      await expect(service.get(OTHER_ORG, 'tgt-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('stores an encrypted trio and returns no plaintext', async () => {
      const chain = buildChain({ data: targetRow, error: null });

      mockFrom.mockReturnValue(chain);

      const result = await service.create(ORG, USER, {
        name: 'Nightly SFTP',
        target_type: 'sftp',
        auth_method: 'sftp_password',
        sftp: sftpConfig,
        secret: { password: 'hunter2' },
      } as never);

      const [inserted] = (chain.insert as jest.Mock).mock.calls[0] as [
        Record<string, unknown>,
      ];

      expect(inserted.organization_id).toBe(ORG);
      expect(inserted.secret_encrypted).toBeTruthy();
      expect(inserted.key_fingerprint).toBeTruthy();
      expect(JSON.stringify(inserted)).not.toContain('hunter2');

      expect(result.masked_secret).toBe('ciph••••••••ue');
      expect(JSON.stringify(result)).not.toContain('hunter2');
      expect(result).not.toHaveProperty('secret_encrypted');
    });

    it('rejects an auth method that does not belong to the target type', async () => {
      await expect(
        service.create(ORG, USER, {
          name: 'Wrong pair',
          target_type: 'sftp',
          auth_method: 'graph_client_secret',
          sftp: sftpConfig,
          secret: { client_secret: 'x' },
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an SFTP target with no sftp config block', async () => {
      await expect(
        service.create(ORG, USER, {
          name: 'No config',
          target_type: 'sftp',
          auth_method: 'sftp_password',
          secret: { password: 'hunter2' },
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('names the missing secret field rather than failing opaquely', async () => {
      await expect(
        service.create(ORG, USER, {
          name: 'No password',
          target_type: 'sftp',
          auth_method: 'sftp_password',
          sftp: sftpConfig,
          secret: {},
        } as never),
      ).rejects.toThrow(/secret\.password is required/);
    });

    it('maps a duplicate name to 409', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { code: '23505', message: 'dupe' } }),
      );

      await expect(
        service.create(ORG, USER, {
          name: 'Nightly SFTP',
          target_type: 'sftp',
          auth_method: 'sftp_password',
          sftp: sftpConfig,
          secret: { password: 'hunter2' },
        } as never),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('rotateSecret', () => {
    it('writes a new trio and clears the stale test result', async () => {
      const chain = buildChain({ data: targetRow, error: null });

      mockFrom.mockReturnValue(chain);

      await service.rotateSecret(ORG, 'tgt-1', USER, {
        secret: { password: 'new-password' },
      } as never);

      const [patch] = (chain.update as jest.Mock).mock.calls[0] as [
        Record<string, unknown>,
      ];

      expect(patch.secret_encrypted).toBeTruthy();
      expect(patch.last_tested_at).toBeNull();
      expect(patch.last_test_ok).toBeNull();
      expect(patch.last_test_error).toBeNull();
      expect(JSON.stringify(patch)).not.toContain('new-password');
    });
  });

  describe('remove', () => {
    it('maps a referencing scheme to 409 rather than a raw database error', async () => {
      const chain = buildChain({ data: targetRow, error: null });

      // getRow resolves, then the delete reports the FK violation.
      chain.delete = jest.fn().mockImplementation(() => ({
        eq: jest.fn().mockImplementation(function inner() {
          return {
            eq: jest
              .fn()
              .mockResolvedValue({ error: { code: '23503', message: 'fk' } }),
          };
        }),
      }));
      mockFrom.mockReturnValue(chain);

      await expect(service.remove(ORG, 'tgt-1', USER)).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
