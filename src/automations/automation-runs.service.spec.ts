import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AutomationRunsService } from './automation-runs.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type {
  IAutomationRun,
  IAutomationRunStep,
} from './interfaces/automation.interface';

const mockRun: IAutomationRun = {
  id: 'run-1',
  automation_id: 'auto-1',
  automation_version_id: 'ver-1',
  space_id: 'space-1',
  organization_id: 'org-1',
  trigger_kind: 'manual',
  trigger_event_id: null,
  trigger_payload: { key: 'value' },
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
  node_id: 'node-1',
  node_kind: 'app.notification.create',
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

describe('AutomationRunsService', () => {
  let service: AutomationRunsService;
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
      'order',
      'limit',
      'range',
      'insert',
      'update',
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
    service = new AutomationRunsService(supabaseAdmin);
  });

  describe('listForAutomation', () => {
    it('returns runs ordered by created_at desc', async () => {
      const chain = buildChain({
        data: [{ ...mockRun, automation_run_steps: [{ count: 3 }] }],
        error: null,
      });
      mockFrom.mockReturnValue(chain);
      const result = await service.listForAutomation('auto-1', {
        limit: 20,
        offset: 0,
      });
      expect(chain.select).toHaveBeenCalledWith(
        '*, automation_run_steps(count)',
      );
      expect(result).toEqual([{ ...mockRun, steps_count: 3 }]);
      // raw embedded aggregate is stripped in favour of steps_count
      expect(result[0]).toHaveProperty('automation_run_steps', undefined);
      expect(chain.order).toHaveBeenCalledWith('created_at', {
        ascending: false,
      });
    });

    it('defaults steps_count to 0 when the count aggregate is absent', async () => {
      const chain = buildChain({ data: [mockRun], error: null });
      mockFrom.mockReturnValue(chain);
      const result = await service.listForAutomation('auto-1');
      expect(result).toEqual([{ ...mockRun, steps_count: 0 }]);
    });

    it('applies range when offset > 0', async () => {
      const chain = buildChain({ data: [], error: null });
      mockFrom.mockReturnValue(chain);
      await service.listForAutomation('auto-1', { limit: 10, offset: 10 });
      expect(chain.range).toHaveBeenCalledWith(10, 19);
    });

    it('throws InternalServerErrorException on DB error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'DB error' } }),
      );
      await expect(service.listForAutomation('auto-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getById', () => {
    it('returns run when found', async () => {
      mockFrom.mockReturnValue(buildChain({ data: mockRun, error: null }));
      const result = await service.getById('run-1');
      expect(result).toEqual(mockRun);
    });

    it('throws NotFoundException when not found', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: null,
          error: { code: 'PGRST116', message: 'not found' },
        }),
      );
      await expect(service.getById('run-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getSteps', () => {
    it('returns steps ordered by step_index asc', async () => {
      const chain = buildChain({ data: [mockStep], error: null });
      mockFrom.mockReturnValue(chain);
      const result = await service.getSteps('run-1');
      expect(result).toEqual([mockStep]);
      expect(chain.order).toHaveBeenCalledWith('step_index', {
        ascending: true,
      });
    });

    it('throws InternalServerErrorException on DB error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'error' } }),
      );
      await expect(service.getSteps('run-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getUserDisplayName', () => {
    it('returns trimmed first+last name', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: { first_name: 'John', last_name: 'Doe', email: 'j@d.com' },
          error: null,
        }),
      );
      const result = await service.getUserDisplayName('user-1');
      expect(result).toBe('John Doe');
    });

    it('falls back to email when name is empty', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: { first_name: '', last_name: '', email: 'j@d.com' },
          error: null,
        }),
      );
      const result = await service.getUserDisplayName('user-1');
      expect(result).toBe('j@d.com');
    });

    it('returns "user" when no row found', async () => {
      mockFrom.mockReturnValue(buildChain({ data: null, error: null }));
      const result = await service.getUserDisplayName('user-1');
      expect(result).toBe('user');
    });
  });

  describe('cancelRun', () => {
    it('cancels a running run and returns { runId }', async () => {
      // getUserDisplayName call
      const userChain = buildChain({
        data: { first_name: 'Jane', last_name: 'Doe', email: 'j@d.com' },
        error: null,
      });
      // fetch run call
      const runChain = buildChain({
        data: {
          id: 'run-1',
          status: 'running',
          started_at: '2026-01-01T00:00:00Z',
        },
        error: null,
      });
      // update steps call
      const stepsChain = buildChain({ data: null, error: null });
      // update run call
      const updateRunChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(userChain)
        .mockReturnValueOnce(runChain)
        .mockReturnValueOnce(stepsChain)
        .mockReturnValueOnce(updateRunChain);
      const result = await service.cancelRun('auto-1', 'run-1', 'user-1');
      expect(result).toEqual({ runId: 'run-1' });
    });

    it('throws NotFoundException when run not found', async () => {
      const userChain = buildChain({
        data: { first_name: 'J', last_name: 'D', email: 'j@d.com' },
        error: null,
      });
      const runChain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(userChain).mockReturnValueOnce(runChain);
      await expect(
        service.cancelRun('auto-1', 'run-1', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when run is already succeeded', async () => {
      const userChain = buildChain({
        data: { first_name: 'J', last_name: 'D', email: 'j@d.com' },
        error: null,
      });
      const runChain = buildChain({
        data: { id: 'run-1', status: 'succeeded', started_at: null },
        error: null,
      });
      mockFrom.mockReturnValueOnce(userChain).mockReturnValueOnce(runChain);
      await expect(
        service.cancelRun('auto-1', 'run-1', 'user-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when run is already failed', async () => {
      const userChain = buildChain({
        data: { first_name: 'J', last_name: 'D', email: 'j@d.com' },
        error: null,
      });
      const runChain = buildChain({
        data: { id: 'run-1', status: 'failed', started_at: null },
        error: null,
      });
      mockFrom.mockReturnValueOnce(userChain).mockReturnValueOnce(runChain);
      await expect(
        service.cancelRun('auto-1', 'run-1', 'user-1'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('retryRun', () => {
    it('creates new run with original payload and seeds first actionable steps', async () => {
      const originalRunChain = buildChain({
        data: {
          automation_id: 'auto-1',
          automation_version_id: 'ver-1',
          space_id: 'space-1',
          organization_id: 'org-1',
          trigger_kind: 'manual',
          trigger_payload: { key: 'val' },
        },
        error: null,
      });
      const newRunChain = buildChain({ data: { id: 'run-2' }, error: null });
      const versionChain = buildChain({
        data: {
          definition: {
            nodes: [
              { id: 'n-trigger', type: 'trigger', data: { kind: 'manual' } },
              {
                id: 'n-action',
                type: 'action',
                data: { kind: 'app.notification.create' },
              },
            ],
            edges: [{ source: 'n-trigger', target: 'n-action' }],
          },
        },
        error: null,
      });
      const stepInsertChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(originalRunChain)
        .mockReturnValueOnce(newRunChain)
        .mockReturnValueOnce(versionChain)
        .mockReturnValueOnce(stepInsertChain);
      const result = await service.retryRun('auto-1', 'run-1');
      expect(result).toEqual({ runId: 'run-2' });
    });

    it('throws NotFoundException when original run not found', async () => {
      mockFrom.mockReturnValue(buildChain({ data: null, error: null }));
      await expect(service.retryRun('auto-1', 'run-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws InternalServerErrorException when new run insert fails', async () => {
      const originalRunChain = buildChain({
        data: {
          automation_id: 'auto-1',
          automation_version_id: 'ver-1',
          space_id: 'space-1',
          organization_id: 'org-1',
          trigger_kind: 'manual',
          trigger_payload: {},
        },
        error: null,
      });
      const failedInsertChain = buildChain({
        data: null,
        error: { message: 'insert failed' },
      });
      mockFrom
        .mockReturnValueOnce(originalRunChain)
        .mockReturnValueOnce(failedInsertChain);
      await expect(service.retryRun('auto-1', 'run-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
