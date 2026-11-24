import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AutomationVersionsService } from './automation-versions.service';
import { AutomationsService } from './automations.service';
import { AutomationScheduleService } from './automation-schedule.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type {
  IAutomation,
  IAutomationVersion,
} from './interfaces/automation.interface';

jest.mock('cron-parser', () => ({
  CronExpressionParser: {
    parse: jest.fn().mockReturnValue({
      next: () => ({ toDate: () => new Date('2026-06-01T00:00:00Z') }),
    }),
  },
}));

const mockAutomation: IAutomation = {
  id: 'auto-1',
  organization_id: 'org-1',
  space_id: 'space-1',
  name: 'Test',
  description: null,
  icon: null,
  status: 'published',
  current_version_id: 'ver-1',
  published_version_id: 'ver-1',
  next_run_at: null,
  webhook_token: null,
  webhook_secret_encrypted: null,
  webhook_secret_iv: null,
  webhook_secret_tag: null,
  last_run_at: null,
  last_run_status: null,
  is_archived: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: 'user-1',
  updated_by: null,
};

const mockDraft: IAutomationVersion = {
  id: 'ver-1',
  automation_id: 'auto-1',
  space_id: 'space-1',
  version_number: 1,
  definition: {
    nodes: [
      {
        id: 'n-trigger',
        type: 'trigger',
        position: { x: 0, y: 0 },
        data: { kind: 'webhook.received' },
      },
      {
        id: 'n-action',
        type: 'action',
        position: { x: 0, y: 200 },
        data: { kind: 'app.notification.create' },
      },
    ],
    edges: [{ id: 'e-1', source: 'n-trigger', target: 'n-action' }],
  },
  trigger_kind: 'webhook.received',
  trigger_config: {},
  is_draft: true,
  is_published: false,
  published_at: null,
  created_at: '2026-01-01T00:00:00Z',
  created_by: 'user-1',
};

describe('AutomationVersionsService', () => {
  let service: AutomationVersionsService;
  let mockFrom: jest.Mock;
  let automationsService: jest.Mocked<Partial<AutomationsService>>;
  let scheduleService: jest.Mocked<Partial<AutomationScheduleService>>;

  function buildChain(resolved: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const c: Record<string, jest.Mock> = {};
    const self = () => c;
    ['select', 'eq', 'neq', 'order', 'limit', 'insert', 'update'].forEach(
      (m) => {
        c[m] = jest.fn().mockImplementation(self);
      },
    );
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

    automationsService = {
      setPublishedVersion: jest.fn().mockResolvedValue(mockAutomation),
      setStatus: jest.fn().mockResolvedValue(mockAutomation),
      ensureWebhookToken: jest.fn().mockResolvedValue(undefined),
      getById: jest.fn().mockResolvedValue(mockAutomation),
    };

    scheduleService = {
      upsert: jest.fn().mockResolvedValue({}),
      deactivate: jest.fn().mockResolvedValue(undefined),
    };

    const subscriptionService = {
      deactivateByAutomation: jest.fn().mockResolvedValue(undefined),
      upsert: jest.fn().mockResolvedValue(undefined),
    };

    service = new AutomationVersionsService(
      supabaseAdmin,
      automationsService as AutomationsService,
      scheduleService as AutomationScheduleService,
      subscriptionService as never,
    );
  });

  describe('listVersions', () => {
    it('returns version summaries ordered by version_number desc', async () => {
      const summary = {
        id: 'ver-1',
        version_number: 1,
        is_draft: true,
        is_published: false,
      };
      mockFrom.mockReturnValue(buildChain({ data: [summary], error: null }));
      const result = await service.listVersions('auto-1');
      expect(result).toEqual([summary]);
    });

    it('throws InternalServerErrorException on DB error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'error' } }),
      );
      await expect(service.listVersions('auto-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getVersionById', () => {
    it('returns full version', async () => {
      mockFrom.mockReturnValue(buildChain({ data: mockDraft, error: null }));
      const result = await service.getVersionById('ver-1');
      expect(result).toEqual(mockDraft);
    });

    it('throws NotFoundException when not found', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: null,
          error: { code: 'PGRST116', message: 'not found' },
        }),
      );
      await expect(service.getVersionById('ver-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getDraft', () => {
    it('returns draft version when found', async () => {
      mockFrom.mockReturnValue(buildChain({ data: mockDraft, error: null }));
      const result = await service.getDraft('auto-1');
      expect(result).toEqual(mockDraft);
    });

    it('returns null when no draft (PGRST116)', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: null,
          error: { code: 'PGRST116', message: 'not found' },
        }),
      );
      const result = await service.getDraft('auto-1');
      expect(result).toBeNull();
    });

    it('throws InternalServerErrorException on other errors', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { code: '500', message: 'error' } }),
      );
      await expect(service.getDraft('auto-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('createDraft', () => {
    it('inserts draft version with is_draft=true', async () => {
      const countChain = buildChain({ data: null, error: null, count: 0 });
      const insertChain = buildChain({ data: mockDraft, error: null });
      mockFrom.mockReturnValueOnce(countChain).mockReturnValueOnce(insertChain);
      const result = await service.createDraft(
        'auto-1',
        { nodes: [], edges: [] },
        '',
        {},
        { userId: 'user-1', spaceId: 'space-1' },
      );
      expect(result).toEqual(mockDraft);
      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({ is_draft: true, is_published: false }),
      );
    });
  });

  describe('getOrCreateDraft', () => {
    it('returns existing draft when found', async () => {
      mockFrom.mockReturnValue(buildChain({ data: mockDraft, error: null }));
      const result = await service.getOrCreateDraft('auto-1', {
        userId: 'user-1',
        spaceId: 'space-1',
      });
      expect(result).toEqual(mockDraft);
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });

    it('creates new draft when none exists', async () => {
      const getDraftChain = buildChain({
        data: null,
        error: { code: 'PGRST116', message: 'not found' },
      });
      // getOrCreateDraft now looks up the last published version to seed the new
      // draft; with no published version it falls back to an empty definition.
      const publishedChain = buildChain({
        data: null,
        error: { code: 'PGRST116', message: 'not found' },
      });
      const countChain = buildChain({ data: null, error: null, count: 0 });
      const insertChain = buildChain({ data: mockDraft, error: null });
      mockFrom
        .mockReturnValueOnce(getDraftChain)
        .mockReturnValueOnce(publishedChain)
        .mockReturnValueOnce(countChain)
        .mockReturnValueOnce(insertChain);
      const result = await service.getOrCreateDraft('auto-1', {
        userId: 'user-1',
        spaceId: 'space-1',
      });
      expect(result).toEqual(mockDraft);
    });
  });

  describe('saveDraft', () => {
    it('throws NotFoundException when no draft exists', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: null,
          error: { code: 'PGRST116', message: 'not found' },
        }),
      );
      await expect(service.saveDraft('auto-1', {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('updates draft with provided fields, falls back to existing for missing fields', async () => {
      const getDraftChain = buildChain({ data: mockDraft, error: null });
      const updateChain = buildChain({
        data: { ...mockDraft, trigger_kind: 'manual' },
        error: null,
      });
      mockFrom
        .mockReturnValueOnce(getDraftChain)
        .mockReturnValueOnce(updateChain);
      const result = await service.saveDraft('auto-1', {
        trigger_kind: 'manual',
      });
      expect(result.trigger_kind).toBe('manual');
      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ trigger_kind: 'manual' }),
      );
    });
  });

  describe('publish', () => {
    it('throws InternalServerErrorException when version numbering fails', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: null,
          error: { code: 'PGRST116', message: 'not found' },
        }),
      );
      await expect(
        service.publish('auto-1', { userId: 'user-1', spaceId: 'space-1' }),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('throws BadRequestException when nodes list is empty', async () => {
      const emptyDraft = { ...mockDraft, definition: { nodes: [], edges: [] } };
      mockFrom.mockReturnValue(buildChain({ data: emptyDraft, error: null }));
      await expect(
        service.publish('auto-1', { userId: 'user-1', spaceId: 'space-1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when no trigger node', async () => {
      const noTriggerDraft = {
        ...mockDraft,
        definition: {
          nodes: [
            {
              id: 'n-1',
              type: 'action',
              position: { x: 0, y: 0 },
              data: { kind: 'app.notification.create' },
            },
          ],
          edges: [],
        },
      };
      mockFrom.mockReturnValue(
        buildChain({ data: noTriggerDraft, error: null }),
      );
      await expect(
        service.publish('auto-1', { userId: 'user-1', spaceId: 'space-1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('publishes draft and calls setPublishedVersion + setStatus', async () => {
      const getDraftChain = buildChain({ data: mockDraft, error: null });
      // oldPublished query - returns PGRST116 (no old published version)
      const oldPublishedChain = buildChain({
        data: null,
        error: { code: 'PGRST116', message: 'not found' },
      });
      // markPublished update
      const publishUpdateChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(getDraftChain)
        .mockReturnValueOnce(oldPublishedChain)
        .mockReturnValueOnce(publishUpdateChain);
      await service.publish('auto-1', { userId: 'user-1', spaceId: 'space-1' });
      expect(automationsService.setPublishedVersion).toHaveBeenCalledWith(
        'auto-1',
        'ver-1',
      );
      expect(automationsService.setStatus).toHaveBeenCalledWith(
        'auto-1',
        'published',
      );
    });

    it('calls ensureWebhookToken for webhook.received trigger', async () => {
      const getDraftChain = buildChain({ data: mockDraft, error: null }); // webhook.received trigger
      const oldPublishedChain = buildChain({
        data: null,
        error: { code: 'PGRST116', message: 'not found' },
      });
      const publishUpdateChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(getDraftChain)
        .mockReturnValueOnce(oldPublishedChain)
        .mockReturnValueOnce(publishUpdateChain);
      await service.publish('auto-1', { userId: 'user-1', spaceId: 'space-1' });
      expect(automationsService.ensureWebhookToken).toHaveBeenCalledWith(
        'auto-1',
        'user-1',
      );
    });

    it('calls scheduleService.upsert for schedule.cron trigger', async () => {
      const cronDraft: IAutomationVersion = {
        ...mockDraft,
        trigger_kind: 'schedule.cron',
        trigger_config: { cron: '0 * * * *', timezone: 'UTC' },
        definition: {
          nodes: [
            {
              id: 'n-trigger',
              type: 'trigger',
              position: { x: 0, y: 0 },
              data: { kind: 'schedule.cron' },
            },
          ],
          edges: [],
        },
      };
      const getDraftChain = buildChain({ data: cronDraft, error: null });
      const oldPublishedChain = buildChain({
        data: null,
        error: { code: 'PGRST116', message: 'not found' },
      });
      const publishUpdateChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(getDraftChain)
        .mockReturnValueOnce(oldPublishedChain)
        .mockReturnValueOnce(publishUpdateChain);
      await service.publish('auto-1', { userId: 'user-1', spaceId: 'space-1' });
      expect(scheduleService.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          cron_expression: '0 * * * *',
          timezone: 'UTC',
          is_active: true,
        }),
      );
    });
  });

  describe('cloneDraft', () => {
    it('creates a copy of the version as a new draft', async () => {
      const getVersionChain = buildChain({ data: mockDraft, error: null });
      // nextVersionNumber reads the highest existing version_number (1) via
      // maybeSingle, so the clone is inserted as version 2.
      const countChain = buildChain({
        data: { version_number: 1 },
        error: null,
      });
      const insertChain = buildChain({
        data: { ...mockDraft, id: 'ver-2', version_number: 2 },
        error: null,
      });
      // cloneDraft then archives any pre-existing draft (guarding the row it
      // just inserted) and repoints the automation at the new draft.
      const archiveDraftsChain = buildChain({ data: null, error: null });
      const repointAutomationChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(getVersionChain)
        .mockReturnValueOnce(countChain)
        .mockReturnValueOnce(insertChain)
        .mockReturnValueOnce(archiveDraftsChain)
        .mockReturnValueOnce(repointAutomationChain);
      const result = await service.cloneDraft('ver-1', { userId: 'user-1' });
      expect(result.version_number).toBe(2);
      expect(insertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          is_draft: true,
          is_published: false,
          version_number: 2,
        }),
      );
      // Only one draft may exist at a time; the new draft must be excluded.
      expect(archiveDraftsChain.update).toHaveBeenCalledWith({
        is_draft: false,
      });
      expect(archiveDraftsChain.neq).toHaveBeenCalledWith('id', 'ver-2');
      // The editor opens the clone, so the automation points at it.
      expect(mockFrom).toHaveBeenNthCalledWith(5, 'automations');
      expect(repointAutomationChain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          current_version_id: 'ver-2',
          updated_by: 'user-1',
        }),
      );
    });
  });
});
