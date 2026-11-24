import { BadRequestException } from '@nestjs/common';
import { AutomationRunsController } from './automation-runs.controller';
import type {
  IAutomationRun,
  IAutomationRunStep,
} from './interfaces/automation.interface';

const mockUser = {
  userId: 'user-1',
  authUserId: 'auth-1',
  email: 'test@example.com',
  organizationId: 'org-1',
};

const mockRun: IAutomationRun = {
  id: 'run-1',
  automation_id: 'auto-1',
  automation_version_id: 'ver-1',
  space_id: 'space-1',
  organization_id: 'org-1',
  trigger_kind: 'manual',
  trigger_event_id: null,
  trigger_payload: null,
  status: 'running',
  correlation_id: null,
  started_at: '2026-01-01T00:00:00Z',
  finished_at: null,
  duration_ms: null,
  error_message: null,
  error_step_id: null,
  created_at: '2026-01-01T00:00:00Z',
};

const mockStep: IAutomationRunStep = {
  id: 'step-1',
  run_id: 'run-1',
  space_id: 'space-1',
  node_id: 'n-1',
  node_kind: 'action',
  step_index: 0,
  status: 'succeeded',
  input: null,
  output: null,
  error_message: null,
  retry_count: 0,
  wakeup_at: null,
  lease_until: null,
  worker_id: null,
  next_step_at: null,
  started_at: null,
  finished_at: null,
  duration_ms: null,
  created_at: '2026-01-01T00:00:00Z',
};

function createController() {
  const automationsService = {
    getById: jest.fn().mockResolvedValue({ id: 'auto-1', space_id: 'space-1' }),
  };
  const automationRunsService = {
    listForAutomation: jest.fn().mockResolvedValue([mockRun]),
    getById: jest.fn().mockResolvedValue(mockRun),
    getSteps: jest.fn().mockResolvedValue([mockStep]),
    cancelRun: jest.fn().mockResolvedValue({ runId: 'run-1' }),
    retryRun: jest.fn().mockResolvedValue({ runId: 'run-2' }),
  };
  const auditLogs = { logAction: jest.fn().mockResolvedValue(undefined) };
  return {
    controller: new AutomationRunsController(
      automationsService as never,
      automationRunsService as never,
      auditLogs as never,
      { getClient: jest.fn().mockReturnValue({ from: jest.fn() }) } as never,
    ),
    automationsService,
    automationRunsService,
    auditLogs,
  };
}

describe('AutomationRunsController', () => {
  describe('listRuns', () => {
    it('lists runs with default pagination (page=1, limit=20)', async () => {
      const { controller, automationRunsService, automationsService } =
        createController();
      const result = await controller.listRuns(mockUser as never, 'auto-1');
      expect(automationsService.getById).toHaveBeenCalledWith(
        'auto-1',
        'org-1',
      );
      expect(automationRunsService.listForAutomation).toHaveBeenCalledWith(
        'auto-1',
        { limit: 20, offset: 0 },
      );
      expect(result).toEqual({ data: [mockRun] });
    });

    it('computes correct offset from page and limit', async () => {
      const { controller, automationRunsService } = createController();
      await controller.listRuns(
        mockUser as never,
        'auto-1',
        undefined,
        '3',
        '10',
      );
      expect(automationRunsService.listForAutomation).toHaveBeenCalledWith(
        'auto-1',
        { limit: 10, offset: 20 },
      );
    });

    it('caps limit at 100', async () => {
      const { controller, automationRunsService } = createController();
      await controller.listRuns(
        mockUser as never,
        'auto-1',
        undefined,
        '1',
        '999',
      );
      expect(automationRunsService.listForAutomation).toHaveBeenCalledWith(
        'auto-1',
        { limit: 100, offset: 0 },
      );
    });
  });

  describe('getRun', () => {
    it('returns run and steps in parallel', async () => {
      const { controller, automationRunsService } = createController();
      const result = await controller.getRun(
        mockUser as never,
        'auto-1',
        'run-1',
      );
      expect(automationRunsService.getById).toHaveBeenCalledWith(
        'run-1',
        'auto-1',
      );
      expect(automationRunsService.getSteps).toHaveBeenCalledWith('run-1');
      expect(result).toEqual({ data: { run: mockRun, steps: [mockStep] } });
    });
  });

  describe('cancelRun', () => {
    it('throws BadRequestException when spaceId is missing from body', async () => {
      const { controller } = createController();
      await expect(
        controller.cancelRun(mockUser as never, 'auto-1', 'run-1', {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('calls cancelRun with automationId, runId, userId', async () => {
      const { controller, automationRunsService } = createController();
      const result = await controller.cancelRun(
        mockUser as never,
        'auto-1',
        'run-1',
        { spaceId: 'space-1' },
      );
      expect(automationRunsService.cancelRun).toHaveBeenCalledWith(
        'auto-1',
        'run-1',
        'user-1',
      );
      expect(result).toEqual({ data: { runId: 'run-1' } });
    });
  });

  describe('retryRun', () => {
    it('throws BadRequestException when spaceId is missing from body', async () => {
      const { controller } = createController();
      await expect(
        controller.retryRun(mockUser as never, 'auto-1', 'run-1', {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('calls retryRun and returns new runId', async () => {
      const { controller, automationRunsService } = createController();
      const result = await controller.retryRun(
        mockUser as never,
        'auto-1',
        'run-1',
        { spaceId: 'space-1' },
      );
      expect(automationRunsService.retryRun).toHaveBeenCalledWith(
        'auto-1',
        'run-1',
      );
      expect(result).toEqual({ data: { runId: 'run-2' } });
    });
  });
});
