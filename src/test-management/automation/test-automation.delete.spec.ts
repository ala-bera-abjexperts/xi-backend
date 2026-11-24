import { ForbiddenException, Logger } from '@nestjs/common';

import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import type { TestAutomationCiWatcherService } from './test-automation-ci-watcher.service';
import { TestAutomationConfigsService } from './test-automation-configs.service';
import type { TestAutomationGitService } from './test-automation-git.service';
import { TestAutomationRunsService } from './test-automation-runs.service';

const SPACE = 'space-1';
const ORG = 'org-1';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;

interface Answer {
  data?: unknown;
  count?: number | null;
  error?: { code?: string; message: string } | null;
}

type Chain = Record<string, jest.Mock> & {
  then: (done: (value: Answer) => unknown) => Promise<unknown>;
};

describe('deleting automation records', () => {
  const assertAvailable = jest.fn();
  const log = jest.fn();
  const from = jest.fn();
  const client = { getClient: () => ({ from }) };

  const next = (answer: Answer): Chain => {
    const chain = {
      then: (done) => Promise.resolve({ error: null, ...answer }).then(done),
    } as Chain;

    for (const name of ['select', 'eq', 'or', 'delete', 'maybeSingle']) {
      chain[name] = jest.fn(() => chain);
    }

    from.mockReturnValueOnce(chain);

    return chain;
  };

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    from.mockReset();
    log.mockReset();
    assertAvailable.mockReset().mockResolvedValue(undefined);
  });

  describe('a CI job', () => {
    const service = new TestAutomationConfigsService(
      client as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      { logActionForRequest: log } as unknown as AuditLogsService,
      {} as unknown as PermissionsService,
      {} as unknown as TestAutomationGitService,
    );
    const job = { id: 'job-1', name: 'Nightly', kind: 'ci_job' };

    it('deletes it within this organization and space, and audits it', async () => {
      next({ data: job });
      next({ count: 0 });

      const removed = next({ data: { id: 'job-1' } });

      await service.remove(user, SPACE, 'job-1');

      expect(removed.delete).toHaveBeenCalledTimes(1);
      expect(removed.eq).toHaveBeenCalledWith('id', 'job-1');
      expect(removed.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(removed.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(removed.eq).toHaveBeenCalledWith('kind', 'ci_job');
      expect(log).toHaveBeenCalledWith(
        user,
        'test_automation_config',
        'job-1',
        'delete',
        { name: 'Nightly' },
      );
    });

    it('never deletes its runs itself', async () => {
      next({ data: job });
      next({ count: 0 });
      next({ data: { id: 'job-1' } });

      await service.remove(user, SPACE, 'job-1');

      expect(from.mock.calls.map(([table]) => table as string)).toEqual([
        'test_automation_configs',
        'test_automation_runs',
        'test_automation_configs',
      ]);
    });

    it('refuses while one of its runs is going', async () => {
      next({ data: job });

      const runs = next({ count: 1 });

      await expect(service.remove(user, SPACE, 'job-1')).rejects.toMatchObject({
        status: 409,
        response: { code: 'RUNS_IN_PROGRESS' },
      });
      expect(runs.eq).toHaveBeenCalledWith('config_id', 'job-1');
      expect(runs.or).toHaveBeenCalledWith(
        expect.stringContaining('send_pending'),
      );
      expect(from).toHaveBeenCalledTimes(2);
      expect(log).not.toHaveBeenCalled();
    });

    it('answers 404 for a job outside this space', async () => {
      next({ data: null });

      await expect(service.remove(user, SPACE, 'job-1')).rejects.toMatchObject({
        status: 404,
      });
      expect(from).toHaveBeenCalledTimes(1);
    });

    it('answers 404 when someone else deleted it first', async () => {
      next({ data: job });
      next({ count: 0 });
      next({ data: null });

      await expect(service.remove(user, SPACE, 'job-1')).rejects.toMatchObject({
        status: 404,
      });
      expect(log).not.toHaveBeenCalled();
    });

    it('deletes nothing when a read of its runs fails', async () => {
      next({ data: job });
      next({ error: { message: 'db down' } });

      await expect(service.remove(user, SPACE, 'job-1')).rejects.toBeDefined();
      expect(from).toHaveBeenCalledTimes(2);
    });

    it('deletes nothing in a read-only space', async () => {
      assertAvailable.mockRejectedValue(new ForbiddenException('read only'));

      await expect(service.remove(user, SPACE, 'job-1')).rejects.toMatchObject({
        status: 403,
      });
      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, { write: true });
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('a run', () => {
    const service = new TestAutomationRunsService(
      client as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      {} as unknown as PermissionsService,
      { logActionForRequest: log } as unknown as AuditLogsService,
      {} as unknown as TestAutomationCiWatcherService,
    );
    const run = (status: string, result_summary: object = {}) => ({
      id: 'run-1',
      status,
      result_summary,
      config_name: 'Nightly',
      error_code: null,
    });

    it.each([
      ['a failed start', run('ERROR')],
      ['a typed job the tool took', run('REQUESTED')],
      ['an untracked run', run('REQUESTED', { ci: { state: 'untracked' } })],
      ['a passed run', run('REQUESTED', { ci: { state: 'passed' } })],
      ['a lost run', run('REQUESTED', { ci: { state: 'lost' } })],
    ])('deletes %s and audits it', async (_name, row) => {
      next({ data: row });

      const removed = next({ data: { id: 'run-1' } });

      await service.remove(user, SPACE, 'run-1');

      expect(removed.delete).toHaveBeenCalledTimes(1);
      expect(removed.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(removed.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(removed.eq).toHaveBeenCalledWith('kind', 'ci_job');
      expect(log).toHaveBeenCalledWith(
        user,
        'test_automation_run',
        'run-1',
        'delete',
        expect.objectContaining({ config_name: 'Nightly' }),
      );
    });

    it.each([
      ['queued', { ci: { state: 'queued' } }],
      ['running', { ci: { state: 'running' } }],
      ['saving results', { ci: { state: 'importing' } }],
      ['still being sent', { send_pending: true }],
    ])('refuses a run that is %s', async (_name, summary) => {
      next({ data: run('REQUESTED', summary) });

      await expect(service.remove(user, SPACE, 'run-1')).rejects.toMatchObject({
        status: 409,
        response: { code: 'RUN_IN_PROGRESS' },
      });
      expect(from).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    });

    it('answers 404 for a run outside this space', async () => {
      next({ data: null });

      await expect(service.remove(user, SPACE, 'run-1')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('deletes nothing in a read-only space', async () => {
      assertAvailable.mockRejectedValue(new ForbiddenException('read only'));

      await expect(service.remove(user, SPACE, 'run-1')).rejects.toMatchObject({
        status: 403,
      });
      expect(from).not.toHaveBeenCalled();
    });
  });
});
