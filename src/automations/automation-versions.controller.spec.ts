import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AutomationVersionsController } from './automation-versions.controller';
import type {
  IAutomation,
  IAutomationVersion,
  IAutomationVersionSummary,
} from './interfaces/automation.interface';

const mockUser = {
  userId: 'user-1',
  authUserId: 'auth-1',
  email: 'test@example.com',
  organizationId: 'org-1',
};

const mockAutomation: IAutomation = {
  id: 'auto-1',
  organization_id: 'org-1',
  space_id: 'space-1',
  name: 'Test',
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
  definition: { nodes: [], edges: [] },
  trigger_kind: '',
  trigger_config: {},
  is_draft: true,
  is_published: false,
  published_at: null,
  created_at: '2026-01-01T00:00:00Z',
  created_by: 'user-1',
};

const mockSummary: IAutomationVersionSummary = {
  id: 'ver-1',
  automation_id: 'auto-1',
  space_id: 'space-1',
  version_number: 1,
  trigger_kind: '',
  is_draft: true,
  is_published: false,
  published_at: null,
  created_at: '2026-01-01T00:00:00Z',
  created_by: 'user-1',
};

function createController() {
  const automationsService = {
    getById: jest.fn().mockResolvedValue(mockAutomation),
  };
  const automationVersionsService = {
    getOrCreateDraft: jest.fn().mockResolvedValue(mockDraft),
    saveDraft: jest.fn().mockResolvedValue(mockDraft),
    listVersions: jest.fn().mockResolvedValue([mockSummary]),
    getVersionById: jest.fn().mockResolvedValue(mockDraft),
    cloneDraft: jest
      .fn()
      .mockResolvedValue({ ...mockDraft, id: 'ver-2', version_number: 2 }),
  };
  return {
    controller: new AutomationVersionsController(
      automationsService as never,
      automationVersionsService as never,
    ),
    automationsService,
    automationVersionsService,
  };
}

describe('AutomationVersionsController', () => {
  describe('getDraft', () => {
    it('returns draft for non-archived automation', async () => {
      const { controller, automationsService, automationVersionsService } =
        createController();
      const result = await controller.getDraft(mockUser as never, 'auto-1');
      expect(automationsService.getById).toHaveBeenCalledWith(
        'auto-1',
        'org-1',
      );
      expect(automationVersionsService.getOrCreateDraft).toHaveBeenCalledWith(
        'auto-1',
        { userId: 'user-1', spaceId: 'space-1' },
      );
      expect(result).toEqual({ data: mockDraft });
    });

    it('throws ForbiddenException when automation is archived', async () => {
      const { controller, automationsService } = createController();
      automationsService.getById.mockResolvedValue({
        ...mockAutomation,
        is_archived: true,
      });
      await expect(
        controller.getDraft(mockUser as never, 'auto-1'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('saveDraft', () => {
    it('saves draft and returns updated version', async () => {
      const { controller, automationsService, automationVersionsService } =
        createController();
      const dto = { trigger_kind: 'manual' };
      const result = await controller.saveDraft(
        mockUser as never,
        'auto-1',
        dto as never,
      );
      expect(automationsService.getById).toHaveBeenCalledWith(
        'auto-1',
        'org-1',
      );
      expect(automationVersionsService.saveDraft).toHaveBeenCalledWith(
        'auto-1',
        dto,
      );
      expect(result).toEqual({ data: mockDraft });
    });

    it('throws ForbiddenException when automation is archived', async () => {
      const { controller, automationsService, automationVersionsService } =
        createController();
      automationsService.getById.mockResolvedValue({
        ...mockAutomation,
        is_archived: true,
      });
      await expect(
        controller.saveDraft(mockUser as never, 'auto-1', {}),
      ).rejects.toThrow(ForbiddenException);
      expect(automationVersionsService.saveDraft).not.toHaveBeenCalled();
    });

    it('propagates the ownership guard failure without saving', async () => {
      const { controller, automationsService, automationVersionsService } =
        createController();
      automationsService.getById.mockRejectedValue(
        new NotFoundException('Automation not found'),
      );
      await expect(
        controller.saveDraft(mockUser as never, 'auto-1', {}),
      ).rejects.toThrow(NotFoundException);
      expect(automationsService.getById).toHaveBeenCalledWith(
        'auto-1',
        'org-1',
      );
      expect(automationVersionsService.saveDraft).not.toHaveBeenCalled();
    });
  });

  describe('listVersions', () => {
    it('returns version summaries', async () => {
      const { controller, automationsService, automationVersionsService } =
        createController();
      const result = await controller.listVersions(mockUser as never, 'auto-1');
      expect(automationsService.getById).toHaveBeenCalledWith(
        'auto-1',
        'org-1',
      );
      expect(automationVersionsService.listVersions).toHaveBeenCalledWith(
        'auto-1',
      );
      expect(result).toEqual({ data: [mockSummary] });
    });

    it('propagates the ownership guard failure without listing', async () => {
      const { controller, automationsService, automationVersionsService } =
        createController();
      automationsService.getById.mockRejectedValue(
        new NotFoundException('Automation not found'),
      );
      await expect(
        controller.listVersions(mockUser as never, 'auto-1'),
      ).rejects.toThrow(NotFoundException);
      expect(automationVersionsService.listVersions).not.toHaveBeenCalled();
    });
  });

  describe('getVersion', () => {
    it('returns full version by ID', async () => {
      const { controller, automationsService, automationVersionsService } =
        createController();
      const result = await controller.getVersion(
        mockUser as never,
        'auto-1',
        'ver-1',
      );
      expect(automationsService.getById).toHaveBeenCalledWith(
        'auto-1',
        'org-1',
      );
      expect(automationVersionsService.getVersionById).toHaveBeenCalledWith(
        'ver-1',
        'auto-1',
      );
      expect(result).toEqual({ data: mockDraft });
    });

    it('propagates the ownership guard failure without fetching the version', async () => {
      const { controller, automationsService, automationVersionsService } =
        createController();
      automationsService.getById.mockRejectedValue(
        new NotFoundException('Automation not found'),
      );
      await expect(
        controller.getVersion(mockUser as never, 'auto-1', 'ver-1'),
      ).rejects.toThrow(NotFoundException);
      expect(automationVersionsService.getVersionById).not.toHaveBeenCalled();
    });
  });

  describe('restoreVersion', () => {
    it('clones version as new draft and returns 201', async () => {
      const { controller, automationVersionsService } = createController();
      const result = await controller.restoreVersion(
        mockUser as never,
        'auto-1',
        'ver-1',
      );
      expect(automationVersionsService.cloneDraft).toHaveBeenCalledWith(
        'ver-1',
        { userId: 'user-1' },
        'auto-1',
      );
      expect(result.data.version_number).toBe(2);
    });
  });
});
