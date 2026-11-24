import type { AttachmentsService } from '../../../attachments/attachments.service';
import type { AuditLogsService } from '../../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../../access/test-management-access.service';
import type { TestExecutionsService } from '../../executions/test-executions.service';
import type { TestRunsService } from '../../runs/test-runs.service';
import { CucumberResultsService } from './cucumber-results.service';

const SPACE = 'space-1';
const EXECUTION = 'execution-1';
const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;

interface Preview {
  matched: { case_id: string }[];
  to_add: { case_id: string }[];
  unmatched?: { name: string }[];
}

// The private steps the tests stand in for, and the one they call.
interface Internals {
  can: jest.Mock;
  execution: jest.Mock;
  runs: jest.Mock;
  casesByTestKey: jest.Mock;
  sortUnclaimed: jest.Mock;
  uploads: jest.Mock;
  assertCanCreate: jest.Mock;
  prepare(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    files: Express.Multer.File[],
    requested?: string,
    keepEvidence?: boolean,
    allowRerun?: boolean,
    onlyCaseId?: string,
  ): Promise<{ preview: Preview }>;
}

const run = (id: string, caseId: string, key: string, title: string) => ({
  id,
  case_id: caseId,
  current_attempt_no: 1,
  case: { key, title, automation_key: null },
  attempts: [
    {
      attempt_no: 1,
      status: 'TODO',
      status_overridden: false,
      comment: null,
      actual_minutes: null,
      step_results: null,
    },
  ],
});

const keyed = (key: string) =>
  `<testcase classname="c" name="${key}"><properties><property name="test_key" value="${key}"/></properties></testcase>`;

const report = (testcases: string) =>
  ({
    originalname: 'results.xml',
    buffer: Buffer.from(`<testsuite name="s">${testcases}</testsuite>`),
  }) as Express.Multer.File;

describe('CucumberResultsService, results of one test case', () => {
  let service: CucumberResultsService;
  let inside: Internals;

  beforeEach(() => {
    service = new CucumberResultsService(
      {} as unknown as SupabaseAdminService,
      {
        assertAvailable: jest.fn().mockResolvedValue(undefined),
      } as unknown as TestManagementAccessService,
      {} as unknown as PermissionsService,
      {} as unknown as AttachmentsService,
      {} as unknown as AuditLogsService,
      {} as unknown as TestRunsService,
      {} as unknown as TestExecutionsService,
    );
    inside = service as unknown as Internals;

    Object.assign(inside, {
      can: jest.fn().mockResolvedValue(true),
      execution: jest.fn().mockResolvedValue({
        id: EXECUTION,
        is_archived: false,
        import_sha256: null,
      }),
      runs: jest
        .fn()
        .mockResolvedValue([
          run('run-a', 'case-a', 'TST-1', 'login'),
          run('run-b', 'case-b', 'TST-2', 'logout'),
        ]),
      casesByTestKey: jest.fn().mockResolvedValue(
        new Map(
          [
            ['TST-1', 'case-a'],
            ['TST-2', 'case-b'],
            ['TST-3', 'case-c'],
          ].map(([key, id]) => [
            key,
            {
              id,
              key,
              title: key,
              is_archived: false,
              readiness: 'ready',
            },
          ]),
        ),
      ),
      sortUnclaimed: jest.fn((_org: string, _space: string, leftover: []) =>
        Promise.resolve({
          inSpace: [],
          unmatched: leftover,
          optIn: [],
          invalid: [],
        }),
      ),
      uploads: jest.fn().mockResolvedValue({
        thisAttachment: null,
        attachments: [],
        earlierUploads: [],
        duplicate: null,
      }),
      assertCanCreate: jest.fn().mockResolvedValue(undefined),
    });
  });

  const prepared = async (file: Express.Multer.File, onlyCaseId?: string) =>
    (
      await inside.prepare(
        user,
        SPACE,
        EXECUTION,
        [file],
        undefined,
        true,
        true,
        onlyCaseId,
      )
    ).preview;

  it('matches every run by title when no case is named, as before', async () => {
    const preview = await prepared(
      report(
        '<testcase classname="c" name="login"/><testcase classname="c" name="logout"/>',
      ),
    );

    expect(preview.matched.map((m) => m.case_id).sort()).toEqual([
      'case-a',
      'case-b',
    ]);
  });

  it('matches only the named case, leaving the other result unrecorded', async () => {
    const preview = await prepared(
      report(
        '<testcase classname="c" name="login"/><testcase classname="c" name="logout"/>',
      ),
      'case-a',
    );

    expect(preview.matched.map((m) => m.case_id)).toEqual(['case-a']);
    expect(preview.unmatched?.map((u) => u.name)).toEqual(['logout']);
  });

  it('drops a result whose test key names another case', async () => {
    const file = report(`${keyed('TST-1')}${keyed('TST-2')}${keyed('TST-3')}`);
    const all = await prepared(file);
    const one = await prepared(file, 'case-a');

    expect(all.matched.map((m) => m.case_id).sort()).toEqual([
      'case-a',
      'case-b',
    ]);
    expect(all.to_add.map((t) => t.case_id)).toEqual(['case-c']);
    expect(one.matched.map((m) => m.case_id)).toEqual(['case-a']);
    expect(one.to_add).toEqual([]);
  });

  it('never creates test cases for a run of one case', async () => {
    const file = report('<testcase classname="c" name="nobody"/>');
    const options = { format: 'junit' as const, create_unmatched: true };

    await expect(
      service.commit(user, SPACE, EXECUTION, file, options, {
        only_case_id: 'case-a',
      }),
    ).rejects.toBeDefined();
    expect(inside.assertCanCreate).not.toHaveBeenCalled();

    await expect(
      service.commit(user, SPACE, EXECUTION, file, options),
    ).rejects.toBeDefined();
    expect(inside.assertCanCreate).toHaveBeenCalledTimes(1);
  });
});
