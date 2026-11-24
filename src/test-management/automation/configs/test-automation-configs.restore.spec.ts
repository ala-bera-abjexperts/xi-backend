import { ForbiddenException, Logger } from '@nestjs/common';

import type { AuditLogsService } from '../../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../../access/test-management-access.service';
import { TestAutomationConfigsService } from '../test-automation-configs.service';
import type { TestAutomationGitService } from '../test-automation-git.service';

const SPACE = 'space-1';
const ORG = 'org-1';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;

interface Answer {
  data?: unknown;
  error?: { code?: string; message: string } | null;
}

type Chain = Record<string, jest.Mock> & {
  then: (done: (value: Answer) => unknown) => Promise<unknown>;
};

const job = (archived_at: string | null) => ({
  id: 'job-1',
  name: 'Nightly',
  kind: 'ci_job',
  ci_url: 'https://ci.example.com/job',
  ci_method: 'POST',
  ci_headers_enc: null,
  ci_body_template: null,
  archived_at,
});

describe('TestAutomationConfigsService.restore', () => {
  const assertAvailable = jest.fn();
  const log = jest.fn();
  const from = jest.fn();

  const service = new TestAutomationConfigsService(
    { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
    { assertAvailable } as unknown as TestManagementAccessService,
    { logActionForRequest: log } as unknown as AuditLogsService,
    {} as unknown as PermissionsService,
    {} as unknown as TestAutomationGitService,
  );

  const next = (answer: Answer): Chain => {
    const chain = {
      then: (done) => Promise.resolve({ error: null, ...answer }).then(done),
    } as Chain;

    for (const name of ['select', 'eq', 'not', 'update', 'maybeSingle']) {
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

  it('brings an archived job back, within this organization and space', async () => {
    next({ data: job('2026-11-05T00:00:00Z') });

    const updated = next({ data: job(null) });

    await expect(service.restore(user, SPACE, 'job-1')).resolves.toMatchObject({
      id: 'job-1',
      archived_at: null,
    });

    expect((updated.update.mock.calls as unknown[][])[0][0]).toEqual({
      archived_at: null,
      updated_by: 'user-1',
    });
    expect(updated.eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(updated.eq).toHaveBeenCalledWith('space_id', SPACE);
    expect(log).toHaveBeenCalledWith(
      user,
      'test_automation_config',
      'job-1',
      'restore',
      { name: 'Nightly' },
    );
  });

  it('changes nothing for a job that is not archived', async () => {
    next({ data: job(null) });

    await expect(service.restore(user, SPACE, 'job-1')).resolves.toMatchObject({
      archived_at: null,
    });

    expect(from).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses when an active job has taken the name', async () => {
    next({ data: job('2026-11-05T00:00:00Z') });
    next({ error: { code: '23505', message: 'duplicate key' } });

    await expect(service.restore(user, SPACE, 'job-1')).rejects.toMatchObject({
      status: 409,
      response: { code: 'DUPLICATE_NAME' },
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('returns the job when someone else restored it first', async () => {
    next({ data: job('2026-11-05T00:00:00Z') });
    next({ data: null });
    next({ data: job(null) });

    await expect(service.restore(user, SPACE, 'job-1')).resolves.toMatchObject({
      archived_at: null,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('answers 404 for a job outside this space', async () => {
    next({ data: null });

    await expect(service.restore(user, SPACE, 'job-1')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('changes nothing in a read-only space', async () => {
    assertAvailable.mockRejectedValue(new ForbiddenException('read only'));

    await expect(service.restore(user, SPACE, 'job-1')).rejects.toMatchObject({
      status: 403,
    });
    expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, { write: true });
    expect(from).not.toHaveBeenCalled();
  });
});
