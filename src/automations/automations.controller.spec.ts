import { BadRequestException } from '@nestjs/common';
import { AutomationsController } from './automations.controller';
import type {
  IAutomation,
  IAutomationVersion,
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

const mockVersion: IAutomationVersion = {
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

function createController() {
  const automationsService = {
    validateSpaceExists: jest.fn().mockResolvedValue(undefined),
    validateAutomationBelongsToSpace: jest.fn().mockResolvedValue(undefined),
    listForSpace: jest.fn().mockResolvedValue([mockAutomation]),
    getById: jest.fn().mockResolvedValue(mockAutomation),
    create: jest.fn().mockResolvedValue(mockAutomation),
    update: jest.fn().mockResolvedValue(mockAutomation),
    archive: jest.fn().mockResolvedValue(undefined),
    setStatus: jest
      .fn()
      .mockResolvedValue({ ...mockAutomation, status: 'paused' }),
    restore: jest.fn().mockResolvedValue({ id: 'auto-1' }),
    pause: jest.fn().mockResolvedValue({ ...mockAutomation, status: 'paused' }),
    resume: jest
      .fn()
      .mockResolvedValue({ ...mockAutomation, status: 'published' }),
    cloneAutomation: jest.fn().mockResolvedValue({
      ...mockAutomation,
      id: 'auto-2',
      name: 'Test (copy)',
    }),
  };
  const automationVersionsService = {
    publish: jest.fn().mockResolvedValue(mockAutomation),
    getDraft: jest.fn().mockResolvedValue(null),
    cloneDraft: jest.fn().mockResolvedValue(mockVersion),
  };
  const auditLogs = { logAction: jest.fn().mockResolvedValue(undefined) };
  return {
    controller: new AutomationsController(
      automationsService as never,
      automationVersionsService as never,
      { getCatalog: jest.fn().mockReturnValue([]) } as never,
      { getCatalog: jest.fn().mockReturnValue([]) } as never,
      auditLogs as never,
      { getClient: jest.fn().mockReturnValue({ from: jest.fn() }) } as never,
      {
        getTemplates: jest.fn().mockResolvedValue([]),
        getMarketplaceTemplates: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
      } as never,
    ),
    automationsService,
    automationVersionsService,
    auditLogs,
  };
}

describe('AutomationsController', () => {
  describe('listAutomations', () => {
    it('calls listForSpace with spaceId and archived=false by default', async () => {
      const { controller, automationsService } = createController();
      const result = await controller.listAutomations('space-1');
      expect(automationsService.listForSpace).toHaveBeenCalledWith(
        'space-1',
        false,
      );
      expect(result).toEqual({ data: [mockAutomation] });
    });

    it('passes archived=true when query param is "true"', async () => {
      const { controller, automationsService } = createController();
      await controller.listAutomations('space-1', 'true');
      expect(automationsService.listForSpace).toHaveBeenCalledWith(
        'space-1',
        true,
      );
    });

    it('throws BadRequestException when spaceId is missing', async () => {
      const { controller } = createController();
      await expect(controller.listAutomations('')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('createAutomation', () => {
    it('calls create with dto and user context', async () => {
      const { controller, automationsService } = createController();
      const dto = { space_id: 'space-1', name: 'New Auto' };
      const result = await controller.createAutomation(
        mockUser as never,
        dto as never,
      );
      expect(automationsService.create).toHaveBeenCalledWith(dto, {
        userId: 'user-1',
        organizationId: 'org-1',
      });
      expect(result).toEqual({ data: mockAutomation });
    });
  });

  describe('getAutomation', () => {
    it('calls getById scoped to the caller organization and returns data', async () => {
      const { controller, automationsService } = createController();
      const result = await controller.getAutomation(
        mockUser as never,
        'auto-1',
      );
      expect(automationsService.getById).toHaveBeenCalledWith(
        'auto-1',
        'org-1',
      );
      expect(result).toEqual({ data: mockAutomation });
    });

    it('throws BadRequestException when spaceId does not match the automation', async () => {
      const { controller } = createController();
      await expect(
        controller.getAutomation(mockUser as never, 'auto-1', 'space-2'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateAutomation', () => {
    it('calls update with id, dto, userId and organizationId', async () => {
      const { controller, automationsService } = createController();
      const dto = { name: 'Updated' };
      const result = await controller.updateAutomation(
        mockUser as never,
        'auto-1',
        dto as never,
      );
      expect(automationsService.update).toHaveBeenCalledWith(
        'auto-1',
        dto,
        'user-1',
        'org-1',
      );
      expect(result).toEqual({ data: mockAutomation });
    });
  });

  describe('archiveAutomation', () => {
    it('calls archive and returns undefined (204)', async () => {
      const { controller, automationsService } = createController();
      const result = await controller.archiveAutomation(
        mockUser as never,
        'auto-1',
      );
      expect(automationsService.archive).toHaveBeenCalledWith(
        'auto-1',
        'org-1',
      );
      expect(result).toBeUndefined();
    });
  });

  describe('publishAutomation', () => {
    it('calls getById then publish with spaceId from automation', async () => {
      const { controller, automationsService, automationVersionsService } =
        createController();
      const result = await controller.publishAutomation(
        mockUser as never,
        'auto-1',
      );
      expect(automationsService.getById).toHaveBeenCalledWith(
        'auto-1',
        'org-1',
      );
      expect(automationVersionsService.publish).toHaveBeenCalledWith('auto-1', {
        userId: 'user-1',
        spaceId: 'space-1',
      });
      expect(result).toEqual({ data: mockAutomation });
    });
  });

  describe('pauseAutomation', () => {
    it('calls setStatus with "paused"', async () => {
      const { controller, automationsService } = createController();
      const result = await controller.pauseAutomation(
        mockUser as never,
        'auto-1',
      );
      expect(automationsService.pause).toHaveBeenCalledWith('auto-1', 'org-1');
      expect(result.data.status).toBe('paused');
    });
  });

  describe('resumeAutomation', () => {
    it('throws BadRequestException when automation is not paused', async () => {
      const { controller, automationsService } = createController();
      automationsService.getById.mockResolvedValue({
        ...mockAutomation,
        status: 'published',
      });
      await expect(
        controller.resumeAutomation(mockUser as never, 'auto-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('calls setStatus with "published" when automation is paused', async () => {
      const { controller, automationsService } = createController();
      automationsService.getById.mockResolvedValue({
        ...mockAutomation,
        status: 'paused',
      });
      automationsService.setStatus.mockResolvedValue({
        ...mockAutomation,
        status: 'published',
      });
      const result = await controller.resumeAutomation(
        mockUser as never,
        'auto-1',
      );
      expect(automationsService.getById).toHaveBeenCalledWith(
        'auto-1',
        'org-1',
      );
      expect(automationsService.resume).toHaveBeenCalledWith('auto-1', 'org-1');
      expect(result.data.status).toBe('published');
    });
  });

  describe('cloneAutomation', () => {
    it('clones automation and skips draft clone when no source draft', async () => {
      const { controller, automationsService, automationVersionsService } =
        createController();
      automationVersionsService.getDraft.mockResolvedValue(null);
      const result = await controller.cloneAutomation(
        mockUser as never,
        'auto-1',
      );
      expect(automationsService.cloneAutomation).toHaveBeenCalledWith(
        'auto-1',
        { userId: 'user-1', organizationId: 'org-1' },
      );
      expect(automationVersionsService.cloneDraft).not.toHaveBeenCalled();
      expect(result.data.name).toBe('Test (copy)');
    });

    it('clones draft version when source has one', async () => {
      const { controller, automationVersionsService } = createController();
      automationVersionsService.getDraft.mockResolvedValue(mockVersion);
      await controller.cloneAutomation(mockUser as never, 'auto-1');
      expect(automationVersionsService.cloneDraft).toHaveBeenCalledWith(
        'ver-1',
        { userId: 'user-1' },
      );
    });
  });

  describe('restoreAutomation', () => {
    it('calls restore and returns { data: { id } }', async () => {
      const { controller, automationsService } = createController();
      const result = await controller.restoreAutomation(
        mockUser as never,
        'auto-1',
      );
      expect(automationsService.restore).toHaveBeenCalledWith(
        'auto-1',
        'org-1',
      );
      expect(result).toEqual({ data: { id: 'auto-1' } });
    });
  });
});
