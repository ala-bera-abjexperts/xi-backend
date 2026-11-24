import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import {
  RUN_COLUMNS,
  TestAutomationCiService,
  toRun,
} from './test-automation-ci.service';
import type { RunRow } from './test-automation-ci.service';
import type { TestAutomationConfigsService } from './test-automation-configs.service';

const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;

describe('TestAutomationCiService with runner settings', () => {
  const from = jest.fn();
  const findRow = jest.fn();
  const service = new TestAutomationCiService(
    { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
    {
      assertAvailable: jest.fn().mockResolvedValue(undefined),
    } as unknown as TestManagementAccessService,
    {
      hasSpacePermission: jest.fn().mockResolvedValue(true),
    } as unknown as PermissionsService,
    { findRow } as unknown as TestAutomationConfigsService,
    { logActionForRequest: jest.fn() } as unknown as AuditLogsService,
  );

  beforeEach(() => {
    from.mockReset();
    findRow.mockReset();
  });

  it('refuses to start a runner setting as a CI job, before anything is saved', async () => {
    const replay = { maybeSingle: jest.fn().mockResolvedValue({ data: null }) };

    Object.assign(replay, {
      select: jest.fn(() => replay),
      eq: jest.fn(() => replay),
    });
    from.mockReturnValueOnce(replay);
    findRow.mockResolvedValue({
      id: 'config-1',
      name: 'Browser tests',
      kind: 'docker',
      ci_url: 'https://ci.example.com/job/a',
      archived_at: null,
    });

    await expect(
      service.trigger(user, 'space-1', 'config-1', {
        target: 'execution',
        target_id: 'execution-1',
        request_id: 'request-1',
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'NOT_A_CI_JOB' },
    });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('reads and returns the outcome of a run', () => {
    expect(RUN_COLUMNS).toContain('outcome');
    expect(
      toRun({ id: 'run-1', outcome: 'failed_tests' } as RunRow).outcome,
    ).toBe('failed_tests');
  });
});
