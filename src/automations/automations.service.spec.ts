import {
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AutomationsService } from './automations.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { IAutomation } from './interfaces/automation.interface';

const mockAutomation: IAutomation = {
  id: 'auto-1',
  organization_id: 'org-1',
  space_id: 'space-1',
  name: 'Test Automation',
  description: null,
  icon: null,
  status: 'draft',
  current_version_id: null,
  published_version_id: null,
  next_run_at: null,
  webhook_token: null,
  webhook_secret_encrypted: null,
  webhook_secret_iv: null,
  webhook_secret_tag: null,
  last_run_at: null,
  last_run_status: null,
  is_archived: false,
  trigger_kind: null,
  trigger_node_count: 0,
  action_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: 'user-1',
  updated_by: null,
};

describe('AutomationsService', () => {
  let service: AutomationsService;
  let mockFrom: jest.Mock;

  function buildChain(resolved: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const c: Record<string, jest.Mock> = {};
    const self = () => c;
    [
      'select',
      'eq',
      'in',
      'not',
      'lte',
      'order',
      'limit',
      'range',
      'insert',
      'update',
      'upsert',
      'delete',
    ].forEach((m) => {
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
    const subscriptionService = {
      deleteByAutomation: jest.fn().mockResolvedValue(undefined),
      deactivateByAutomation: jest.fn().mockResolvedValue(undefined),
      activateByAutomation: jest.fn().mockResolvedValue(undefined),
    };
    const scheduleService = {
      upsert: jest.fn().mockResolvedValue(undefined),
      deleteByAutomation: jest.fn().mockResolvedValue(undefined),
      deactivate: jest.fn().mockResolvedValue(undefined),
      activate: jest.fn().mockResolvedValue(undefined),
    };
    service = new AutomationsService(
      supabaseAdmin,
      subscriptionService as never,
      scheduleService as never,
    );
  });

  describe('listForSpace', () => {
    it('returns automations for a space', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: [mockAutomation], error: null }),
      );
      const result = await service.listForSpace('space-1');
      expect(result).toEqual([mockAutomation]);
      expect(mockFrom).toHaveBeenCalledWith('automations');
    });

    it('filters by archived=true when specified', async () => {
      const chain = buildChain({ data: [], error: null });
      mockFrom.mockReturnValue(chain);
      await service.listForSpace('space-1', true);
      expect(chain.eq).toHaveBeenCalledWith('is_archived', true);
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

  describe('getById', () => {
    it('returns automation when found', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: mockAutomation, error: null }),
      );
      const result = await service.getById('auto-1');
      expect(result).toEqual(mockAutomation);
    });

    it('throws NotFoundException on PGRST116', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: null,
          error: { code: 'PGRST116', message: 'not found' },
        }),
      );
      await expect(service.getById('auto-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException on other DB error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { code: '500', message: 'error' } }),
      );
      await expect(service.getById('auto-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('inserts automation and returns it', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: mockAutomation, error: null }),
      );
      const dto = { space_id: 'space-1', name: 'Test Automation' };
      const ctx = { userId: 'user-1', organizationId: 'org-1' };
      const result = await service.create(dto, ctx);
      expect(result).toEqual(mockAutomation);
      expect(mockFrom).toHaveBeenCalledWith('automations');
    });

    it('throws InternalServerErrorException on DB error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'insert error' } }),
      );
      await expect(
        service.create(
          { space_id: 'space-1', name: 'Test' },
          { userId: 'u', organizationId: 'o' },
        ),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('update', () => {
    it('updates and returns automation', async () => {
      const updated = { ...mockAutomation, name: 'Updated' };
      mockFrom.mockReturnValue(buildChain({ data: updated, error: null }));
      const result = await service.update(
        'auto-1',
        { name: 'Updated' },
        'user-1',
      );
      expect(result.name).toBe('Updated');
    });

    it('throws InternalServerErrorException on DB error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'update error' } }),
      );
      await expect(
        service.update('auto-1', { name: 'X' }, 'user-1'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('archive', () => {
    it('archives existing automation', async () => {
      const getChain = buildChain({ data: mockAutomation, error: null });
      const archiveChain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(getChain).mockReturnValueOnce(archiveChain);
      await expect(service.archive('auto-1')).resolves.toBeUndefined();
    });

    it('throws NotFoundException when automation not found', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: null,
          error: { code: 'PGRST116', message: 'not found' },
        }),
      );
      await expect(service.archive('auto-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('restore', () => {
    it('restores archived automation and returns { id }', async () => {
      const getChain = buildChain({ data: mockAutomation, error: null });
      const restoreChain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(getChain).mockReturnValueOnce(restoreChain);
      const result = await service.restore('auto-1');
      expect(result).toEqual({ id: 'auto-1' });
    });
  });

  describe('setStatus', () => {
    it('updates status and returns automation', async () => {
      const updated = { ...mockAutomation, status: 'published' as const };
      mockFrom.mockReturnValue(buildChain({ data: updated, error: null }));
      const result = await service.setStatus('auto-1', 'published');
      expect(result.status).toBe('published');
    });
  });

  describe('setPublishedVersion', () => {
    it('updates published_version_id and current_version_id', async () => {
      const updated = {
        ...mockAutomation,
        published_version_id: 'ver-1',
        current_version_id: 'ver-1',
      };
      mockFrom.mockReturnValue(buildChain({ data: updated, error: null }));
      const result = await service.setPublishedVersion('auto-1', 'ver-1');
      expect(result.published_version_id).toBe('ver-1');
    });
  });

  describe('ensureWebhookToken', () => {
    it('generates token when webhook_token is null', async () => {
      const getChain = buildChain({
        data: { ...mockAutomation, webhook_token: null },
        error: null,
      });
      const updateChain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(getChain).mockReturnValueOnce(updateChain);
      await expect(
        service.ensureWebhookToken('auto-1', 'user-1'),
      ).resolves.toBeUndefined();
      expect(mockFrom).toHaveBeenCalledTimes(2);
    });

    it('skips update when webhook_token is already set', async () => {
      const getChain = buildChain({
        data: { ...mockAutomation, webhook_token: 'existing-token' },
        error: null,
      });
      mockFrom.mockReturnValueOnce(getChain);
      await expect(
        service.ensureWebhookToken('auto-1', 'user-1'),
      ).resolves.toBeUndefined();
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });
  });

  describe('cloneAutomation', () => {
    it('creates automation with "(copy)" suffix', async () => {
      const getChain = buildChain({ data: mockAutomation, error: null });
      const cloned = {
        ...mockAutomation,
        id: 'auto-2',
        name: 'Test Automation (copy)',
      };
      const createChain = buildChain({ data: cloned, error: null });
      mockFrom.mockReturnValueOnce(getChain).mockReturnValueOnce(createChain);
      const result = await service.cloneAutomation('auto-1', {
        userId: 'user-1',
        organizationId: 'org-1',
      });
      expect(result.name).toBe('Test Automation (copy)');
    });
  });
});
