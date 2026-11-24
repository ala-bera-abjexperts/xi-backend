import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AutomationConnectionsService } from './automation-connections.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { encryptApiKey } from '../lib/crypto/encryption';
import type { ConfigService } from '@nestjs/config';
import type { IAutomationConnection } from './interfaces/automation.interface';

const mockConnection: IAutomationConnection = {
  id: 'conn-1',
  organization_id: 'org-1',
  space_id: 'space-1',
  provider: 'slack',
  display_name: 'Slack Workspace',
  external_account_id: 'T123456',
  encrypted_secret: 'enc-secret-value-long',
  encryption_iv: 'iv-value',
  encryption_tag: 'tag-value',
  metadata: {},
  is_revoked: false,
  last_used_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: 'user-1',
};

describe('AutomationConnectionsService', () => {
  let service: AutomationConnectionsService;
  let mockFrom: jest.Mock;

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const c: Record<string, jest.Mock> = {};
    const self = () => c;
    ['select', 'eq', 'order', 'update'].forEach((m) => {
      c[m] = jest.fn().mockImplementation(self);
    });
    c.single = jest.fn().mockResolvedValue(resolved);
    c.maybeSingle = jest.fn().mockResolvedValue(resolved);
    (
      c as unknown as { then: (r: (v: unknown) => unknown) => Promise<unknown> }
    ).then = (r) => Promise.resolve(resolved).then(r);
    return c;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supabaseAdmin = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    const configService = {
      get: (key: string) =>
        key === 'allowedOrigins' ? ['http://lvh.me:3000'] : undefined,
    } as unknown as ConfigService;
    service = new AutomationConnectionsService(supabaseAdmin, configService);
  });

  describe('validateCredential', () => {
    it('returns unsupported for a provider without a validator (no persistence, no DB call)', async () => {
      const result = await service.validateCredential(
        'no-such-provider',
        'secret',
        {},
      );

      expect(result.status).toBe('unsupported');
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });

  describe('listForSpace', () => {
    it('returns non-revoked connections with masked secrets', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: [mockConnection], error: null }),
      );
      const result = await service.listForSpace('space-1');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('conn-1');
      expect(result[0].provider).toBe('slack');
    });

    it('does not expose encrypted_secret in response', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: [mockConnection], error: null }),
      );
      const result = await service.listForSpace('space-1');
      expect(result[0]).not.toHaveProperty('encrypted_secret');
      expect(result[0]).not.toHaveProperty('encryption_iv');
      expect(result[0]).not.toHaveProperty('encryption_tag');
    });

    it('includes masked_secret in response', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: [mockConnection], error: null }),
      );
      const result = await service.listForSpace('space-1');
      expect(result[0]).toHaveProperty('masked_secret');
      expect(typeof result[0].masked_secret).toBe('string');
    });

    it('returns empty array when no connections', async () => {
      mockFrom.mockReturnValue(buildChain({ data: [], error: null }));
      const result = await service.listForSpace('space-1');
      expect(result).toEqual([]);
    });

    it('throws InternalServerErrorException on DB error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'DB error' } }),
      );
      await expect(service.listForSpace('space-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getSpaceKey', () => {
    it('returns the space key when found', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: { key: 'DEFAULT' }, error: null }),
      );
      await expect(service.getSpaceKey('space-1')).resolves.toBe('DEFAULT');
    });

    it('returns null when the space is not found', async () => {
      mockFrom.mockReturnValue(buildChain({ data: null, error: null }));
      await expect(service.getSpaceKey('space-1')).resolves.toBeNull();
    });
  });

  describe('isKnownAppOrigin', () => {
    it('accepts an exact configured origin', () => {
      expect(service.isKnownAppOrigin('http://lvh.me:3000')).toBe(true);
    });

    it('accepts a tenant subdomain of a configured origin', () => {
      expect(service.isKnownAppOrigin('http://abj-experts.lvh.me:3000')).toBe(
        true,
      );
    });

    it('rejects an origin outside the configured allowlist', () => {
      expect(service.isKnownAppOrigin('http://evil.example.com')).toBe(false);
    });

    it('rejects an undefined origin', () => {
      expect(service.isKnownAppOrigin(undefined)).toBe(false);
    });
  });

  describe('revoke', () => {
    it('sets is_revoked=true after verifying space ownership', async () => {
      const lookupChain = buildChain({
        data: { id: 'conn-1', space_id: 'space-1' },
        error: null,
      });
      const updateChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(lookupChain)
        .mockReturnValueOnce(updateChain);
      await expect(
        service.revoke('conn-1', 'space-1'),
      ).resolves.toBeUndefined();
      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ is_revoked: true }),
      );
    });

    it('throws NotFoundException when connection not found', async () => {
      mockFrom.mockReturnValue(buildChain({ data: null, error: null }));
      await expect(service.revoke('conn-1', 'space-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when connection belongs to different space', async () => {
      const lookupChain = buildChain({
        data: { id: 'conn-1', space_id: 'space-other' },
        error: null,
      });
      mockFrom.mockReturnValueOnce(lookupChain);
      await expect(service.revoke('conn-1', 'space-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws InternalServerErrorException on DB update error', async () => {
      const lookupChain = buildChain({
        data: { id: 'conn-1', space_id: 'space-1' },
        error: null,
      });
      const updateChain = buildChain({
        data: null,
        error: { message: 'revoke failed' },
      });
      mockFrom
        .mockReturnValueOnce(lookupChain)
        .mockReturnValueOnce(updateChain);
      await expect(service.revoke('conn-1', 'space-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  // The edit form shows WHICH credential is stored, never the value.
  describe('credential previews', () => {
    const TENANT_ID = '11111111-2222-3333-4444-555555555555';
    const CLIENT_ID = '66666666-7777-8888-9999-000000000000';
    const CLIENT_SECRET = 'Abc8Q~realLookingAzureClientSecretValue123';

    function mailboxRow(): IAutomationConnection {
      process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);

      const enc = encryptApiKey(CLIENT_SECRET);

      return {
        ...mockConnection,
        encrypted_secret: enc.encrypted,
        encryption_iv: enc.iv,
        encryption_tag: enc.tag,
        metadata: {
          tenantId: TENANT_ID,
          clientId: CLIENT_ID,
          mailboxAddress: 'support@example.com',
        },
      };
    }

    it('previews the Azure identifiers without returning them in full', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: [mailboxRow()], error: null }),
      );

      const [conn] = await service.listForSpace('space-1');
      const wire = JSON.stringify(conn);

      expect(conn.masked_metadata.tenantId).toBeDefined();
      expect(conn.masked_metadata.clientId).toBeDefined();
      expect(wire).not.toContain(TENANT_ID);
      expect(wire).not.toContain(CLIENT_ID);
      expect(conn.metadata.tenantId).toBeUndefined();
      expect(conn.metadata.clientId).toBeUndefined();
      expect(conn.metadata.mailboxAddress).toBe('support@example.com');
    });

    it('masks the decrypted secret, not the ciphertext', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: [mailboxRow()], error: null }),
      );

      const [conn] = await service.listForSpace('space-1');

      expect(JSON.stringify(conn)).not.toContain(CLIENT_SECRET);
      expect(conn.masked_secret).toContain('••••••••');
      expect(conn.masked_secret.startsWith(CLIENT_SECRET.slice(0, 4))).toBe(
        true,
      );
    });

    it('drops a masked preview on update instead of writing it back', async () => {
      const stored = mailboxRow();
      const lookup = buildChain({ data: stored, error: null });
      const write = buildChain({ data: stored, error: null });

      mockFrom.mockReturnValueOnce(lookup).mockReturnValueOnce(write);

      await service.update({
        connectionId: 'conn-1',
        spaceId: 'space-1',
        organizationId: 'org-1',
        metadata: {
          tenantId: '6470••••••••65',
          clientId: '99999999-8888-7777-6666-555555555555',
        },
        secret: 'uh38••••••••E9',
      });

      const patch = write.update.mock.calls[0][0] as {
        metadata: Record<string, string>;
        encrypted_secret?: string;
      };

      // The untouched (masked) field keeps its stored value; the retyped one is written.
      expect(patch.metadata.tenantId).toBe(TENANT_ID);
      expect(patch.metadata.clientId).toBe(
        '99999999-8888-7777-6666-555555555555',
      );
      expect(patch.encrypted_secret).toBeUndefined();
    });

    it('never previews a true secret metadata key', async () => {
      const row = mailboxRow();

      row.metadata = { ...row.metadata, refresh_token: 'rt-super-secret' };
      mockFrom.mockReturnValue(buildChain({ data: [row], error: null }));

      const [conn] = await service.listForSpace('space-1');

      expect(JSON.stringify(conn)).not.toContain('rt-super-secret');
      expect(conn.masked_metadata.refresh_token).toBeUndefined();
    });
  });
});
