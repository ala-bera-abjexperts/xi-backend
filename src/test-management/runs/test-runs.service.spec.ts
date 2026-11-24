import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import type { TesterEligibilityService } from '../common/tester-eligibility.service';
import type { TestCasesService } from '../cases/test-cases.service';
import type { TestExecutionsService } from '../executions/test-executions.service';
import { TestRunsService } from './test-runs.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const EXEC = 'exec-1';
const ME = 'user-1';
const user = { userId: ME, organizationId: ORG } as RequestUser;

interface Resolved {
  data: unknown;
  error: { code?: string; message: string } | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Resolved>;

function buildChain(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of [
    'select',
    'eq',
    'in',
    'is',
    'range',
    'order',
    'update',
    'delete',
    'or',
  ]) {
    chain[name] = jest.fn(() => chain);
  }

  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  Object.assign(chain, {
    then: (onFulfilled: (value: Resolved) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled),
  });

  return chain;
}

// Removing a run first looks for files and File Explorer links on its attempts.
const noFiles = () => buildChain({ data: [], error: null });

function run(
  id: string,
  keyNumber: number,
  status: string,
  assignee: { id: string; first_name: string } | null,
  title = `Case ${keyNumber}`,
) {
  return {
    id,
    case_id: `case-${id}`,
    assignee_id: assignee?.id ?? null,
    current_attempt_no: 2,
    case: {
      readiness: 'ready',
      task: { key: `P-TC${keyNumber}`, summary: title },
    },
    assignee: assignee
      ? { ...assignee, last_name: null, email: null, avatar_url: null }
      : null,
    attempts: [
      {
        attempt_no: 1,
        status: 'FAIL',
        status_overridden: false,
        status_changed_at: 't1',
      },
      {
        attempt_no: 2,
        status,
        status_overridden: false,
        status_changed_at: 't2',
      },
    ],
  };
}

describe('TestRunsService', () => {
  let service: TestRunsService;
  let from: jest.Mock;
  let log: jest.Mock;
  let load: jest.Mock;
  let eligibleUserIds: jest.Mock;
  let assertEligible: jest.Mock;

  beforeEach(() => {
    from = jest.fn();
    log = jest.fn().mockResolvedValue(undefined);
    load = jest.fn().mockResolvedValue({ id: EXEC, is_archived: false });
    eligibleUserIds = jest.fn().mockResolvedValue(new Set([ME]));
    assertEligible = jest.fn().mockResolvedValue(undefined);

    service = new TestRunsService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {
        assertAvailable: jest.fn().mockResolvedValue(undefined),
      } as unknown as TestManagementAccessService,
      {
        eligibleUserIds,
        assertEligible,
      } as unknown as TesterEligibilityService,
      { load } as unknown as TestExecutionsService,
      { logActionForRequest: log } as unknown as AuditLogsService,
    );
  });

  describe('list', () => {
    const rows = [
      run('r1', 1, 'PASS', { id: ME, first_name: 'Ann' }),
      run('r2', 2, 'TODO', null, 'Login works'),
      run('r3', 3, 'FAIL', { id: 'gone', first_name: 'Bob' }),
    ];

    it('uses the current attempt, flags ineligible assignees and scopes the query', async () => {
      const chain = buildChain({ data: rows, error: null });

      from.mockReturnValueOnce(chain);

      const page = await service.list(user, SPACE, EXEC, {});

      expect(
        page.items.map((i) => [i.id, i.status, i.assignee_eligible]),
      ).toEqual([
        ['r1', 'PASS', true],
        ['r2', 'TODO', true],
        ['r3', 'FAIL', false],
      ]);
      expect(chain.eq.mock.calls).toEqual(
        expect.arrayContaining([
          ['execution_id', EXEC],
          ['space_id', SPACE],
          ['organization_id', ORG],
        ]),
      );
      expect(load).toHaveBeenCalledWith(ORG, SPACE, EXEC);
    });

    it('filters by status, assignee and search, then pages', async () => {
      from.mockReturnValue(buildChain({ data: rows, error: null }));

      expect(
        (await service.list(user, SPACE, EXEC, { status: ['PASS', 'FAIL'] }))
          .total,
      ).toBe(2);
      expect(
        (await service.list(user, SPACE, EXEC, { assignee: 'me' })).items[0].id,
      ).toBe('r1');
      expect(
        (await service.list(user, SPACE, EXEC, { assignee: 'unassigned' }))
          .items[0].id,
      ).toBe('r2');
      expect(
        (await service.list(user, SPACE, EXEC, { q: 'login' })).items[0].id,
      ).toBe('r2');

      const second = await service.list(user, SPACE, EXEC, {
        page: 2,
        pageSize: 2,
      });

      expect(second).toEqual(
        expect.objectContaining({ total: 3, page: 2, pageSize: 2 }),
      );
      expect(second.items.map((i) => i.id)).toEqual(['r3']);
    });

    it('takes the key and title of each case from its ticket and sorts by the ticket number', async () => {
      const withTicket = run('r1', 1, 'PASS', null);
      const chain = buildChain({
        data: [
          {
            ...withTicket,
            case: {
              ...withTicket.case,
              task: { key: 'PROJ-12', summary: ' Spaced ' },
            },
          },
          run('r2', 2, 'TODO', null),
        ],
        error: null,
      });

      from.mockReturnValueOnce(chain);

      const page = await service.list(user, SPACE, EXEC, {});

      expect(
        page.items.map((i) => [
          i.id,
          i.case_key,
          i.case_task_key,
          i.case_title,
        ]),
      ).toEqual([
        ['r2', 'P-TC2', 'P-TC2', 'Case 2'],
        ['r1', 'PROJ-12', 'PROJ-12', 'Spaced'],
      ]);
      expect(chain.select).toHaveBeenCalledWith(
        expect.stringContaining(
          'task:tasks!test_cases_task_id_fkey(key, summary)',
        ),
      );
    });

    it('finds a run by the ticket key of its case', async () => {
      const withTicket = run('r1', 1, 'PASS', null);

      from.mockReturnValueOnce(
        buildChain({
          data: [
            {
              ...withTicket,
              case: {
                ...withTicket.case,
                task: { key: 'PROJ-12', summary: 'Case 1' },
              },
            },
            run('r2', 2, 'TODO', null),
          ],
          error: null,
        }),
      );

      const page = await service.list(user, SPACE, EXEC, { q: 'proj-12' });

      expect(page.items.map((i) => i.id)).toEqual(['r1']);
    });

    it('adds step counts of the current attempt for the page only when asked', async () => {
      const attempts = buildChain({
        data: [
          {
            run_id: 'r1',
            attempt_no: 1,
            steps: [{ id: 's1' }],
            step_results: { s1: { status: 'FAIL' } },
          },
          {
            run_id: 'r1',
            attempt_no: 2,
            steps: [
              { id: 's1', position: 1, action: 'Open' },
              { id: 's2', position: 2, action: 'Fill' },
              { id: 's3', position: 3, action: 'Save' },
            ],
            step_results: { s1: { status: 'PASS' }, s2: { status: 'BLOCKED' } },
          },
          { run_id: 'r2', attempt_no: 2, steps: [], step_results: {} },
        ],
        error: null,
      });

      from
        .mockReturnValueOnce(buildChain({ data: rows, error: null }))
        .mockReturnValueOnce(attempts);

      const page = await service.list(user, SPACE, EXEC, {
        include: 'steps',
        pageSize: 2,
      });

      expect(
        page.items.map((i) => [i.id, i.step_total, i.step_counts]),
      ).toEqual([
        ['r1', 3, { TODO: 1, PASS: 1, FAIL: 0, BLOCKED: 1, NOT_APPLICABLE: 0 }],
        ['r2', 0, { TODO: 0, PASS: 0, FAIL: 0, BLOCKED: 0, NOT_APPLICABLE: 0 }],
      ]);
      expect(page.items[0].steps).toEqual([
        { position: 1, action: 'Open', status: 'PASS' },
        { position: 2, action: 'Fill', status: 'BLOCKED' },
        { position: 3, action: 'Save', status: 'TODO' },
      ]);
      expect(page.items[1].steps).toEqual([]);
      expect(attempts.in).toHaveBeenCalledWith('run_id', ['r1', 'r2']);
      expect(attempts.eq.mock.calls).toEqual(
        expect.arrayContaining([
          ['space_id', SPACE],
          ['organization_id', ORG],
        ]),
      );

      from.mockReturnValueOnce(buildChain({ data: rows, error: null }));

      const plain = await service.list(user, SPACE, EXEC, {});

      expect(plain.items[0]).not.toHaveProperty('step_total');
      expect(from).toHaveBeenCalledTimes(3);
    });

    it('sorts by status and keeps unassigned runs last when sorting by assignee', async () => {
      from.mockReturnValue(buildChain({ data: rows, error: null }));

      const byStatus = await service.list(user, SPACE, EXEC, {
        sort: 'status',
      });
      const byAssigneeDesc = await service.list(user, SPACE, EXEC, {
        sort: 'assignee:desc',
      });

      expect(byStatus.items.map((i) => i.status)).toEqual([
        'TODO',
        'PASS',
        'FAIL',
      ]);
      expect(byAssigneeDesc.items.map((i) => i.id)).toEqual(['r3', 'r1', 'r2']);
    });

    it('sorts by last update newest first with updated:desc', async () => {
      const changed = (id: string, keyNumber: number, at: string) => {
        const row = run(id, keyNumber, 'PASS', null);

        row.attempts[1].status_changed_at = at;

        return row;
      };

      from.mockReturnValue(
        buildChain({
          data: [
            changed('r1', 1, '2026-10-01T10:00:00.000Z'),
            changed('r2', 2, '2026-10-03T10:00:00.000Z'),
            changed('r3', 3, '2026-10-02T10:00:00.000Z'),
          ],
          error: null,
        }),
      );

      const page = await service.list(user, SPACE, EXEC, {
        sort: 'updated:desc',
      });

      expect(page.items.map((i) => i.id)).toEqual(['r2', 'r3', 'r1']);
    });

    it('keeps runs without a status change last when sorting by update', async () => {
      const noAttempt = { ...run('r0', 0, 'TODO', null), attempts: [] };
      const later = run('r5', 5, 'PASS', null);
      const earlier = run('r4', 4, 'PASS', null);

      later.attempts[1].status_changed_at = '2026-10-02T10:00:00.000Z';
      earlier.attempts[1].status_changed_at = '2026-10-01T10:00:00.000Z';
      from.mockReturnValue(
        buildChain({ data: [noAttempt, later, earlier], error: null }),
      );

      const desc = await service.list(user, SPACE, EXEC, {
        sort: 'updated:desc',
      });
      const asc = await service.list(user, SPACE, EXEC, {
        sort: 'updated:asc',
      });

      expect(desc.items.map((i) => i.id)).toEqual(['r5', 'r4', 'r0']);
      expect(asc.items.map((i) => i.id)).toEqual(['r4', 'r5', 'r0']);
    });

    it('keeps To do runs last when sorting by update, even with the newest time', async () => {
      const todo = run('r1', 1, 'TODO', null);
      const newer = run('r2', 2, 'PASS', null);
      const older = run('r3', 3, 'FAIL', null);

      todo.attempts[1].status_changed_at = '2026-10-09T10:00:00.000Z';
      newer.attempts[1].status_changed_at = '2026-10-02T10:00:00.000Z';
      older.attempts[1].status_changed_at = '2026-10-01T10:00:00.000Z';
      from.mockReturnValue(
        buildChain({ data: [todo, newer, older], error: null }),
      );

      const desc = await service.list(user, SPACE, EXEC, {
        sort: 'updated:desc',
      });
      const asc = await service.list(user, SPACE, EXEC, {
        sort: 'updated:asc',
      });

      expect(desc.items.map((i) => i.id)).toEqual(['r2', 'r3', 'r1']);
      expect(asc.items.map((i) => i.id)).toEqual(['r3', 'r2', 'r1']);
    });

    it('sorts by duration with typed minutes first and runs without one last', async () => {
      const timed = (
        id: string,
        keyNumber: number,
        times: {
          actual_minutes?: number | null;
          started_at?: string | null;
          finished_at?: string | null;
        },
      ) => {
        const row = run(id, keyNumber, 'PASS', null);

        Object.assign(row.attempts[1], times);

        return row;
      };

      from.mockReturnValue(
        buildChain({
          data: [
            // Typed minutes win over the times.
            timed('r1', 1, {
              actual_minutes: 30,
              started_at: '2026-10-01T10:00:00.000Z',
              finished_at: '2026-10-01T10:05:00.000Z',
            }),
            timed('r2', 2, { actual_minutes: 0 }),
            timed('r3', 3, {
              started_at: '2026-10-01T10:00:00.000Z',
              finished_at: '2026-10-01T10:10:00.000Z',
            }),
            // Still running: no duration yet.
            timed('r4', 4, { started_at: '2026-10-01T10:00:00.000Z' }),
            // A finish before the start counts as 0 minutes.
            timed('r5', 5, {
              started_at: '2026-10-01T10:10:00.000Z',
              finished_at: '2026-10-01T10:00:00.000Z',
            }),
          ],
          error: null,
        }),
      );

      const asc = await service.list(user, SPACE, EXEC, { sort: 'duration' });
      const desc = await service.list(user, SPACE, EXEC, {
        sort: 'duration:desc',
      });

      expect(asc.items.map((i) => i.id)).toEqual([
        'r2',
        'r5',
        'r3',
        'r1',
        'r4',
      ]);
      expect(desc.items.map((i) => i.id)).toEqual([
        'r1',
        'r3',
        'r2',
        'r5',
        'r4',
      ]);
    });

    it('orders runs with the same key number by id so pages never overlap', async () => {
      from.mockReturnValue(
        buildChain({
          data: [run('rb', 7, 'PASS', null), run('ra', 7, 'PASS', null)],
          error: null,
        }),
      );

      const page = await service.list(user, SPACE, EXEC, {});

      expect(page.items.map((i) => i.id)).toEqual(['ra', 'rb']);
    });
  });

  describe('assign', () => {
    it('refuses foreign ids and writes nothing', async () => {
      from.mockReturnValueOnce(
        buildChain({ data: [{ id: 'r1', assignee_id: null }], error: null }),
      );

      await expect(
        service.assign(user, SPACE, EXEC, ['r1', 'foreign'], ME),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(from).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    });

    it('refuses an archived execution and an ineligible assignee before any read', async () => {
      load.mockResolvedValueOnce({ id: EXEC, is_archived: true });
      await expect(
        service.assign(user, SPACE, EXEC, ['r1'], ME),
      ).rejects.toBeInstanceOf(ConflictException);

      assertEligible.mockRejectedValueOnce(new BadRequestException());
      await expect(
        service.assign(user, SPACE, EXEC, ['r1'], 'other'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(from).not.toHaveBeenCalled();
    });

    it('skips runs that already have the assignee and writes the rest in chunks of 100', async () => {
      const ids = Array.from(
        { length: 150 },
        (_, i) => `r${String(i).padStart(3, '0')}`,
      );

      from
        .mockReturnValueOnce(
          buildChain({
            data: ids
              .slice(0, 100)
              .map((id, i) => ({ id, assignee_id: i === 0 ? ME : null })),
            error: null,
          }),
        )
        .mockReturnValueOnce(
          buildChain({
            data: ids.slice(100).map((id) => ({ id, assignee_id: null })),
            error: null,
          }),
        );

      const firstWrite = buildChain({
        data: ids.slice(1, 101).map((id) => ({ id })),
        error: null,
      });
      const secondWrite = buildChain({
        data: ids.slice(101).map((id) => ({ id })),
        error: null,
      });

      from.mockReturnValueOnce(firstWrite).mockReturnValueOnce(secondWrite);

      const result = await service.assign(user, SPACE, EXEC, ids, ME);

      expect(result).toEqual({ assigned: 149, unchanged: ['r000'] });
      expect((firstWrite.in.mock.calls[0] as unknown[])[1]).toHaveLength(100);
      expect((secondWrite.in.mock.calls[0] as unknown[])[1]).toHaveLength(49);
      expect(firstWrite.eq.mock.calls).toEqual(
        expect.arrayContaining([
          ['execution_id', EXEC],
          ['space_id', SPACE],
          ['organization_id', ORG],
        ]),
      );
      expect(log).toHaveBeenCalledTimes(1);
    });
  });

  describe('claim', () => {
    const before = (assignee: string | null, archived = false) =>
      buildChain({
        data: { assignee_id: assignee, execution: { is_archived: archived } },
        error: null,
      });

    it('takes a free run with a conditional update', async () => {
      const write = buildChain({
        data: { id: 'r1', execution_id: EXEC },
        error: null,
      });

      from.mockReturnValueOnce(before(null)).mockReturnValueOnce(write);

      expect(await service.claim(user, SPACE, 'r1')).toEqual({
        run_id: 'r1',
        assignee_id: ME,
        already_yours: false,
      });
      expect(write.is).toHaveBeenCalledWith('assignee_id', null);
    });

    it('answers a retried claim as success', async () => {
      from
        .mockReturnValueOnce(before(ME))
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(before(ME));

      expect((await service.claim(user, SPACE, 'r1')).already_yours).toBe(true);
    });

    it('refuses a run someone else holds (ALREADY_ASSIGNED)', async () => {
      from
        .mockReturnValueOnce(before(null))
        .mockReturnValueOnce(buildChain({ data: null, error: null }))
        .mockReturnValueOnce(before('other'));

      const failure = service.claim(user, SPACE, 'r1');

      await expect(failure).rejects.toBeInstanceOf(ConflictException);
      await failure.catch((e: { getResponse: () => { code: string } }) =>
        expect(e.getResponse().code).toBe('ALREADY_ASSIGNED'),
      );
    });

    it('answers 404 for a missing run and 409 for an archived execution', async () => {
      from.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.claim(user, SPACE, 'r1')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      from.mockReturnValueOnce(before(null, true));
      await expect(service.claim(user, SPACE, 'r1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('remove', () => {
    const clean = {
      id: 'a1',
      status: 'TODO',
      step_results: {},
      comment: null,
      actual_minutes: null,
    };

    const loaded = (
      attempts: Record<string, unknown>[] = [clean],
      archived = false,
    ) =>
      buildChain({
        data: {
          id: 'r1',
          execution_id: EXEC,
          case_id: 'c1',
          execution: { is_archived: archived },
          attempts,
          defects: [],
        },
        error: null,
      });

    it('removes a run without results, scoped to space and org, and audits it', async () => {
      const write = buildChain({ data: [{ id: 'r1' }], error: null });

      from
        .mockReturnValueOnce(loaded())
        .mockReturnValueOnce(noFiles())
        .mockReturnValueOnce(noFiles())
        .mockReturnValueOnce(write);

      expect(await service.remove(user, SPACE, 'r1')).toEqual({
        run_id: 'r1',
        execution_id: EXEC,
      });
      expect(write.delete).toHaveBeenCalled();
      expect(write.eq).toHaveBeenCalledWith('id', 'r1');
      expect(write.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(write.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(log).toHaveBeenCalledWith(
        user,
        'test_execution',
        EXEC,
        'update',
        expect.objectContaining({ action: 'remove_run', run_id: 'r1' }),
      );
    });

    it.each([
      ['a final status', { ...clean, status: 'PASS' }],
      ['an executing attempt', { ...clean, status: 'EXECUTING' }],
      ['a step result', { ...clean, step_results: { s1: { status: 'FAIL' } } }],
      ['an attempt note', { ...clean, comment: 'checked' }],
      ['recorded time', { ...clean, actual_minutes: 0 }],
    ])('refuses a run with %s (HAS_RESULTS)', async (_, attempt) => {
      from.mockReturnValueOnce(loaded([clean, attempt]));

      const failure = service.remove(user, SPACE, 'r1');

      await expect(failure).rejects.toBeInstanceOf(ConflictException);
      await failure.catch((e: { getResponse: () => { code: string } }) =>
        expect(e.getResponse().code).toBe('HAS_RESULTS'),
      );
      expect(from).toHaveBeenCalledTimes(1);
    });

    it('removes a run whose only attempt was aborted before anything was recorded', async () => {
      const write = buildChain({ data: [{ id: 'r1' }], error: null });

      from
        .mockReturnValueOnce(loaded([{ ...clean, status: 'ABORTED' }]))
        .mockReturnValueOnce(noFiles())
        .mockReturnValueOnce(noFiles())
        .mockReturnValueOnce(write);

      expect(await service.remove(user, SPACE, 'r1')).toEqual({
        run_id: 'r1',
        execution_id: EXEC,
      });
      expect(write.delete).toHaveBeenCalled();
    });

    it.each([
      [
        'a step result',
        { status: 'ABORTED', step_results: { s1: { status: 'FAIL' } } },
      ],
      ['an attempt note', { status: 'ABORTED', comment: 'stopped' }],
      ['recorded time', { status: 'ABORTED', actual_minutes: 5 }],
    ])('refuses an aborted run with %s (HAS_RESULTS)', async (_, patch) => {
      from.mockReturnValueOnce(loaded([{ ...clean, ...patch }]));

      await expect(service.remove(user, SPACE, 'r1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('answers 409 for an archived execution and 404 for a missing or vanished run', async () => {
      from.mockReturnValueOnce(loaded([clean], true));
      await expect(service.remove(user, SPACE, 'r1')).rejects.toBeInstanceOf(
        ConflictException,
      );

      from.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(service.remove(user, SPACE, 'r1')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      from
        .mockReturnValueOnce(loaded())
        .mockReturnValueOnce(noFiles())
        .mockReturnValueOnce(noFiles())
        .mockReturnValueOnce(buildChain({ data: [], error: null }));
      await expect(service.remove(user, SPACE, 'r1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('removeMany', () => {
    const clean = {
      status: 'TODO',
      step_results: {},
      comment: null,
      actual_minutes: null,
    };
    const evidence = (id: string, status = 'TODO') => ({
      id,
      attempts: [{ ...clean, id: `a-${id}`, status }],
      defects: [],
    });

    it('removes runs without results, skips the rest and audits once', async () => {
      const check = buildChain({
        data: [evidence('r1'), evidence('r2', 'FAIL'), evidence('r3')],
        error: null,
      });
      const write = buildChain({
        data: [{ id: 'r1' }, { id: 'r3' }],
        error: null,
      });

      from
        .mockReturnValueOnce(check)
        .mockReturnValueOnce(noFiles())
        .mockReturnValueOnce(noFiles())
        .mockReturnValueOnce(write);

      expect(
        await service.removeMany(user, SPACE, EXEC, ['r3', 'r1', 'r2']),
      ).toEqual({
        removed: 2,
        skipped: ['r2'],
      });
      expect(write.in).toHaveBeenCalledWith('id', ['r1', 'r3']);
      expect(write.eq).toHaveBeenCalledWith('execution_id', EXEC);
      expect(write.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(log).toHaveBeenCalledWith(
        user,
        'test_execution',
        EXEC,
        'update',
        expect.objectContaining({ action: 'remove_runs', runs: 2 }),
      );
    });

    it('removes an aborted run with nothing recorded and keeps an aborted run with results', async () => {
      const check = buildChain({
        data: [
          evidence('r1', 'ABORTED'),
          {
            id: 'r2',
            attempts: [
              { ...clean, id: 'a-r2', status: 'ABORTED', actual_minutes: 3 },
            ],
            defects: [],
          },
        ],
        error: null,
      });
      const write = buildChain({ data: [{ id: 'r1' }], error: null });

      from
        .mockReturnValueOnce(check)
        .mockReturnValueOnce(noFiles())
        .mockReturnValueOnce(noFiles())
        .mockReturnValueOnce(write);

      expect(await service.removeMany(user, SPACE, EXEC, ['r1', 'r2'])).toEqual(
        { removed: 1, skipped: ['r2'] },
      );
      expect(write.in).toHaveBeenCalledWith('id', ['r1']);
    });

    it('deletes nothing when every run has results', async () => {
      from.mockReturnValueOnce(
        buildChain({ data: [evidence('r1', 'PASS')], error: null }),
      );

      expect(await service.removeMany(user, SPACE, EXEC, ['r1'])).toEqual({
        removed: 0,
        skipped: ['r1'],
      });
      expect(from).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    });

    it('answers 404 for a foreign id and 409 for an archived execution, writing nothing', async () => {
      from.mockReturnValueOnce(
        buildChain({ data: [evidence('r1')], error: null }),
      );
      await expect(
        service.removeMany(user, SPACE, EXEC, ['r1', 'other']),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(from).toHaveBeenCalledTimes(1);

      load.mockResolvedValueOnce({ id: EXEC, is_archived: true });
      await expect(
        service.removeMany(user, SPACE, EXEC, ['r1']),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(from).toHaveBeenCalledTimes(1);
    });
  });

  describe('addRuns', () => {
    let rpc: jest.Mock;
    let adder: TestRunsService;

    beforeEach(() => {
      rpc = jest.fn();
      adder = new TestRunsService(
        { getClient: () => ({ from, rpc }) } as unknown as SupabaseAdminService,
        {
          assertAvailable: jest.fn().mockResolvedValue(undefined),
        } as unknown as TestManagementAccessService,
        {} as unknown as TesterEligibilityService,
        { load } as unknown as TestExecutionsService,
        { logActionForRequest: log } as unknown as AuditLogsService,
      );
    });

    it('adds the cases through the database function and audits the count', async () => {
      const skipped = [
        { case_id: 'c2', key: 'P-TC2', reason: 'already_added' },
      ];

      rpc.mockResolvedValueOnce({ data: { added: 1, skipped }, error: null });

      expect(await adder.addRuns(user, SPACE, EXEC, ['c1', 'c2'])).toEqual({
        added: 1,
        skipped,
      });
      expect(rpc).toHaveBeenCalledWith('tm_add_execution_runs', {
        p_organization_id: ORG,
        p_space_id: SPACE,
        p_actor_id: ME,
        p_execution_id: EXEC,
        p_case_ids: ['c1', 'c2'],
      });
      expect(log).toHaveBeenCalledWith(
        user,
        'test_execution',
        EXEC,
        'update',
        expect.objectContaining({ action: 'add_runs', runs: 1 }),
      );
    });

    it('does not audit when nothing was added', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          added: 0,
          skipped: [{ case_id: 'c1', key: 'P-TC1', reason: 'archived' }],
        },
        error: null,
      });

      expect((await adder.addRuns(user, SPACE, EXEC, ['c1'])).added).toBe(0);
      expect(log).not.toHaveBeenCalled();
    });

    it('answers 409 for an archived execution and 404 for an unknown execution or case', async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'TM004', message: 'tm: execution is archived' },
      });
      await expect(
        adder.addRuns(user, SPACE, EXEC, ['c1']),
      ).rejects.toBeInstanceOf(ConflictException);

      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'P0002', message: 'tm: cases not found' },
      });
      await expect(
        adder.addRuns(user, SPACE, EXEC, ['c1']),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(log).not.toHaveBeenCalled();
    });

    it('lists the missing case ids in the 404', async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: {
          code: 'P0002',
          message: 'tm: cases not found',
          details: '{"missing":["c9"]}',
        },
      });

      await expect(
        adder.addRuns(user, SPACE, EXEC, ['c1', 'c9']),
      ).rejects.toMatchObject({ response: { data: { not_found: ['c9'] } } });
    });
  });

  describe('addableCases', () => {
    const casesChain = (resolved: Resolved & { count?: number }) => {
      const chain = buildChain(resolved);

      for (const name of ['neq', 'or', 'order']) {
        chain[name] = jest.fn(() => chain);
      }

      Object.assign(chain, {
        then: (
          onFulfilled: (value: Resolved & { count?: number }) => unknown,
        ) => Promise.resolve(resolved).then(onFulfilled),
      });

      return chain;
    };

    it('lists active cases without a run in this execution, scoped and paged', async () => {
      const chain = casesChain({
        data: [
          {
            id: 'c2',
            readiness: 'ready',
            task: { key: 'P-T9', summary: ' Login ' },
            runs: [],
          },
        ],
        error: null,
        count: 1,
      });

      from.mockReturnValueOnce(chain);

      expect(
        await service.addableCases(user, SPACE, EXEC, {
          page: 2,
          pageSize: 10,
        }),
      ).toEqual({
        items: [
          {
            id: 'c2',
            key: 'P-T9',
            task_key: 'P-T9',
            title: 'Login',
            readiness: 'ready',
          },
        ],
        total: 1,
        page: 2,
        pageSize: 10,
      });
      expect(load).toHaveBeenCalledWith(ORG, SPACE, EXEC);
      expect(from).toHaveBeenCalledWith('test_cases');
      expect(chain.eq.mock.calls).toEqual(
        expect.arrayContaining([
          ['space_id', SPACE],
          ['organization_id', ORG],
          ['is_archived', false],
          ['runs.execution_id', EXEC],
        ]),
      );
      expect(chain.neq).toHaveBeenCalledWith('readiness', 'deprecated');
      expect(chain.is).toHaveBeenCalledWith('runs', null);
      expect(chain.range).toHaveBeenCalledWith(10, 19);
      expect(chain.order.mock.calls).toEqual([
        ['created_at', { ascending: true }],
        ['id', { ascending: true }],
      ]);
      expect(chain.or).not.toHaveBeenCalled();
    });

    it('searches the key or title with an escaped pattern', async () => {
      const chain = casesChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(chain);
      await service.addableCases(user, SPACE, EXEC, { q: '50%_off' });

      expect(chain.or).toHaveBeenCalledWith(
        'key.ilike."%50\\\\%\\\\_off%",summary.ilike."%50\\\\%\\\\_off%"',
        { referencedTable: 'task' },
      );
    });

    it('answers 404 for an execution of another space before querying cases', async () => {
      load.mockRejectedValueOnce(new NotFoundException());

      await expect(
        service.addableCases(user, SPACE, EXEC, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(from).not.toHaveBeenCalled();
    });
  });

  it('lists every run of a case in active executions, newest execution first', async () => {
    const chain = buildChain({
      data: [
        {
          ...run('r1', 1, 'PASS', { id: ME, first_name: 'Ann' }),
          execution: {
            id: 'e1',
            environment: null,
            task: { key: 'P-TE9', summary: 'A' },
          },
        },
        {
          ...run('r2', 1, 'EXECUTING', null),
          execution: {
            id: 'e2',
            environment: 'QA',
            task: { key: 'P-TE10', summary: ' B ' },
          },
        },
      ],
      error: null,
    });

    from.mockReturnValueOnce(chain);

    const page = await service.caseRuns(user, SPACE, 'c1', {});

    expect(page.items.map((i) => [i.id, i.execution.key])).toEqual([
      ['r2', 'P-TE10'],
      ['r1', 'P-TE9'],
    ]);
    expect(page.items[0].execution).toEqual({
      id: 'e2',
      key: 'P-TE10',
      name: 'B',
      environment: 'QA',
    });
    expect(page.total).toBe(2);
    expect(chain.eq.mock.calls).toEqual(
      expect.arrayContaining([
        ['case_id', 'c1'],
        ['space_id', SPACE],
        ['organization_id', ORG],
        ['execution.is_archived', false],
      ]),
    );
  });

  it('returns the run detail with names and a deleted author', async () => {
    from.mockReturnValue(buildChain({ data: [], error: null }));
    from
      .mockReturnValueOnce(
        buildChain({
          data: {
            id: 'r1',
            current_attempt_no: 2,
            assignee_id: ME,
            execution: {
              id: EXEC,
              environment: null,
              is_archived: false,
              task: { key: 'P-TE1', summary: 'A' },
              plan: null,
            },
            case: {
              id: 'c1',
              revision: 3,
              is_archived: false,
              task: { key: 'P-TC1' },
            },
            assignee: {
              id: ME,
              first_name: 'Ann',
              last_name: null,
              email: null,
              avatar_url: null,
            },
            attempts: [
              {
                id: 'a1',
                attempt_no: 1,
                kind: 'initial',
                status: 'ABORTED',
                created_at: 't1',
              },
              {
                id: 'a2',
                attempt_no: 2,
                kind: 'reset',
                status: 'EXECUTING',
                created_at: 't2',
              },
            ],
          },
          error: null,
        }),
      )
      .mockReturnValueOnce(
        buildChain({
          data: {
            id: 'a2',
            attempt_no: 2,
            kind: 'reset',
            case_revision: 2,
            snapshot: {
              case_key: 'P-TC1',
              title: 'T',
              objective: null,
              preconditions: null,
              steps: [],
            },
            status: 'EXECUTING',
            status_overridden: false,
            status_changed_at: 't',
            step_results: {
              s1: {
                status: 'PASS',
                actual_result: 'ok',
                comment: null,
                executed_by: ME,
                executed_at: 't',
              },
              s2: {
                status: 'FAIL',
                actual_result: null,
                comment: null,
                executed_by: 'deleted',
                executed_at: 't',
              },
            },
            comment: null,
            actual_minutes: null,
            started_at: 't',
            finished_at: null,
          },
          error: null,
        }),
      )
      .mockReturnValueOnce(
        buildChain({
          data: [
            {
              id: ME,
              first_name: 'Ann',
              last_name: 'Lee',
              email: null,
              avatar_url: null,
            },
          ],
          error: null,
        }),
      );

    const detail = await service.get(user, SPACE, 'r1');

    expect(detail.current_attempt.step_results.s1.executed_by?.name).toBe(
      'Ann Lee',
    );
    expect(detail.current_attempt.step_results.s2.executed_by).toEqual({
      id: 'deleted',
      name: null,
      avatar_url: null,
    });
    expect(detail.attempts.map((a) => a.attempt_no)).toEqual([2, 1]);
    expect(detail.case.revision).toBe(3);
    expect(detail.current_attempt.case_revision).toBe(2);
    expect(detail.case.key).toBe('P-TC1');
    expect(detail.case.task_key).toBe('P-TC1');
    expect(detail.execution).toEqual({
      id: EXEC,
      key: 'P-TE1',
      name: 'A',
      environment: null,
      is_archived: false,
      plan: null,
    });
  });

  it('maps the plan of the run detail from its ticket', async () => {
    from.mockReturnValue(buildChain({ data: [], error: null }));
    from
      .mockReturnValueOnce(
        buildChain({
          data: {
            id: 'r1',
            current_attempt_no: 1,
            assignee_id: null,
            execution: {
              id: EXEC,
              environment: 'QA',
              is_archived: false,
              task: { key: 'P-TE1', summary: ' Sprint ' },
              plan: {
                id: 'plan-1',
                task: { key: 'P-TP1', summary: ' Release ' },
              },
            },
            case: {
              id: 'c1',
              revision: 1,
              is_archived: false,
              task: { key: 'P-TC1' },
            },
            assignee: null,
            attempts: [],
          },
          error: null,
        }),
      )
      .mockReturnValueOnce(
        buildChain({ data: { id: 'a1', step_results: {} }, error: null }),
      );

    const detail = await service.get(user, SPACE, 'r1');

    expect(detail.execution.name).toBe('Sprint');
    expect(detail.execution.plan).toEqual({
      id: 'plan-1',
      key: 'P-TP1',
      name: 'Release',
    });
  });

  it("returns the case's test type and charter, or null when the case has none", async () => {
    // The database sends both columns, as null when empty.
    const detail = (caseRow: Record<string, unknown>) => {
      const run = buildChain({
        data: {
          id: 'r1',
          current_attempt_no: 1,
          assignee_id: null,
          execution: {
            id: EXEC,
            environment: null,
            is_archived: false,
            task: { key: 'P-TE1', summary: 'A' },
            plan: null,
          },
          case: {
            id: 'c1',
            revision: 1,
            is_archived: false,
            task: { key: 'P-TC1' },
            ...caseRow,
          },
          assignee: null,
          attempts: [],
        },
        error: null,
      });

      from
        .mockReturnValueOnce(run)
        .mockReturnValueOnce(
          buildChain({ data: { id: 'a1', step_results: {} }, error: null }),
        )
        .mockReturnValue(buildChain({ data: [], error: null }));

      return { run, result: service.get(user, SPACE, 'r1') };
    };

    const exploratory = detail({
      test_type: 'exploratory',
      definition: 'Explore refunds',
      estimate_minutes: 30,
      task_id: 'ticket-1',
    });

    expect((await exploratory.result).case).toMatchObject({
      test_type: 'exploratory',
      definition: 'Explore refunds',
      estimate_minutes: 30,
      task_id: 'ticket-1',
    });
    expect(exploratory.run.select).toHaveBeenCalledWith(
      expect.stringContaining(
        'is_archived, test_type, definition, estimate_minutes, task:',
      ),
    );
    expect(exploratory.run.select).toHaveBeenCalledWith(
      expect.stringContaining('(id, task_id, revision,'),
    );

    const plain = await detail({ test_type: null, definition: null }).result;

    expect(plain.case.test_type).toBeNull();
    expect(plain.case.definition).toBeNull();
    expect(plain.case.task_id).toBeUndefined();
  });
});

describe('TestRunsService plan sync', () => {
  const PLAN = 'plan-1';
  const withPlan = { id: EXEC, is_archived: false, plan: { id: PLAN } };
  let service: TestRunsService;
  let from: jest.Mock;
  let rpc: jest.Mock;
  let load: jest.Mock;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    from = jest.fn();
    rpc = jest.fn();
    load = jest.fn().mockResolvedValue(withPlan);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    service = new TestRunsService(
      { getClient: () => ({ from, rpc }) } as unknown as SupabaseAdminService,
      {
        assertAvailable: jest.fn().mockResolvedValue(undefined),
      } as unknown as TestManagementAccessService,
      {
        assertEligible: jest.fn().mockResolvedValue(undefined),
      } as unknown as TesterEligibilityService,
      { load } as unknown as TestExecutionsService,
      {
        logActionForRequest: jest.fn().mockResolvedValue(undefined),
      } as unknown as AuditLogsService,
    );
  });

  afterEach(() => warn.mockRestore());

  const runsRead = () =>
    buildChain({
      data: [{ id: 'r1', assignee_id: null, case_id: 'c1' }],
      error: null,
    });
  const runsWrite = () => buildChain({ data: [{ id: 'r1' }], error: null });
  const planRead = (archived: boolean) =>
    buildChain({ data: { is_archived: archived }, error: null });

  it('assign sets the planned tester of the plan rows for those cases', async () => {
    const planWrite = buildChain({ data: null, error: null });

    from
      .mockReturnValueOnce(runsRead())
      .mockReturnValueOnce(runsWrite())
      .mockReturnValueOnce(planRead(false))
      .mockReturnValueOnce(planWrite);

    const result = await service.assign(user, SPACE, EXEC, ['r1'], ME);

    expect(result).toEqual({ assigned: 1, unchanged: [], plan_sync: 'ok' });
    expect(from).toHaveBeenNthCalledWith(4, 'test_plan_tests');
    expect(planWrite.update).toHaveBeenCalledWith({ planned_tester_id: ME });
    expect(planWrite.in).toHaveBeenCalledWith('case_id', ['c1']);
    expect(planWrite.eq.mock.calls).toEqual(
      expect.arrayContaining([
        ['plan_id', PLAN],
        ['space_id', SPACE],
        ['organization_id', ORG],
      ]),
    );
  });

  it('unassign leaves the plan unchanged', async () => {
    from
      .mockReturnValueOnce(
        buildChain({
          data: [{ id: 'r1', assignee_id: ME, case_id: 'c1' }],
          error: null,
        }),
      )
      .mockReturnValueOnce(runsWrite());

    const result = await service.assign(user, SPACE, EXEC, ['r1'], null);

    expect(result).toEqual({ assigned: 1, unchanged: [] });
    expect(from).toHaveBeenCalledTimes(2);
  });

  it('assign skips an archived plan with a warning and still assigns', async () => {
    from
      .mockReturnValueOnce(runsRead())
      .mockReturnValueOnce(runsWrite())
      .mockReturnValueOnce(planRead(true));

    const result = await service.assign(user, SPACE, EXEC, ['r1'], ME);

    expect(result).toEqual({
      assigned: 1,
      unchanged: [],
      plan_sync: 'skipped_archived',
    });
    expect(from).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalled();
  });

  it('assign reports a failed plan write without failing the assignment', async () => {
    from
      .mockReturnValueOnce(runsRead())
      .mockReturnValueOnce(runsWrite())
      .mockReturnValueOnce(planRead(false))
      .mockReturnValueOnce(
        buildChain({ data: null, error: { message: 'boom' } }),
      );

    const result = await service.assign(user, SPACE, EXEC, ['r1'], ME);

    expect(result.assigned).toBe(1);
    expect(result.plan_sync).toBe('failed');
    expect(warn).toHaveBeenCalled();
  });

  it('claim sets the planned tester of that case', async () => {
    const before = buildChain({
      data: {
        assignee_id: null,
        case_id: 'c1',
        execution: { is_archived: false, plan_id: PLAN },
      },
      error: null,
    });
    const planWrite = buildChain({ data: null, error: null });

    from
      .mockReturnValueOnce(before)
      .mockReturnValueOnce(
        buildChain({ data: { id: 'r1', execution_id: EXEC }, error: null }),
      )
      .mockReturnValueOnce(planRead(false))
      .mockReturnValueOnce(planWrite);

    expect(await service.claim(user, SPACE, 'r1')).toEqual({
      run_id: 'r1',
      assignee_id: ME,
      already_yours: false,
      plan_sync: 'ok',
    });
    expect(planWrite.update).toHaveBeenCalledWith({ planned_tester_id: ME });
    expect(planWrite.in).toHaveBeenCalledWith('case_id', ['c1']);
  });

  it('addRuns adds only the newly added cases to the plan', async () => {
    rpc
      .mockResolvedValueOnce({
        data: {
          added: 1,
          skipped: [{ case_id: 'c2', key: 'P-TC2', reason: 'already_added' }],
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: {}, error: null });

    const result = await service.addRuns(user, SPACE, EXEC, ['c1', 'c2']);

    expect(result.plan_sync).toBe('ok');
    expect(rpc).toHaveBeenNthCalledWith(2, 'tm_add_plan_tests', {
      p_organization_id: ORG,
      p_space_id: SPACE,
      p_actor_id: ME,
      p_plan_id: PLAN,
      p_case_ids: ['c1'],
      p_set_id: null,
      p_folder_id: null,
      p_include_subfolders: true,
    });
  });

  it('addRuns skips an archived plan with a warning and keeps the added runs', async () => {
    rpc
      .mockResolvedValueOnce({ data: { added: 1, skipped: [] }, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { code: 'TM004', message: 'tm: plan is archived' },
      });

    const result = await service.addRuns(user, SPACE, EXEC, ['c1']);

    expect(result).toEqual({
      added: 1,
      skipped: [],
      plan_sync: 'skipped_archived',
    });
    expect(warn).toHaveBeenCalled();
  });

  it('makes no plan calls when the execution has no plan', async () => {
    load.mockResolvedValue({ id: EXEC, is_archived: false, plan: null });
    from.mockReturnValueOnce(runsRead()).mockReturnValueOnce(runsWrite());

    expect(await service.assign(user, SPACE, EXEC, ['r1'], ME)).toEqual({
      assigned: 1,
      unchanged: [],
    });
    expect(from).toHaveBeenCalledTimes(2);

    rpc.mockResolvedValueOnce({ data: { added: 1, skipped: [] }, error: null });
    expect(await service.addRuns(user, SPACE, EXEC, ['c1'])).toEqual({
      added: 1,
      skipped: [],
    });
    expect(rpc).toHaveBeenCalledTimes(1);

    from
      .mockReturnValueOnce(
        buildChain({
          data: {
            assignee_id: null,
            case_id: 'c1',
            execution: { is_archived: false, plan_id: null },
          },
          error: null,
        }),
      )
      .mockReturnValueOnce(
        buildChain({ data: { id: 'r1', execution_id: EXEC }, error: null }),
      );
    expect((await service.claim(user, SPACE, 'r1')).plan_sync).toBeUndefined();
    expect(from).toHaveBeenCalledTimes(4);
  });
});

describe('TestRunsService assign follows the test case', () => {
  let service: TestRunsService;
  let from: jest.Mock;
  let setAssignee: jest.Mock;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    from = jest.fn();
    setAssignee = jest.fn().mockResolvedValue({ ticket_warning: false });
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    service = new TestRunsService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {
        assertAvailable: jest.fn().mockResolvedValue(undefined),
      } as unknown as TestManagementAccessService,
      {
        assertEligible: jest.fn().mockResolvedValue(undefined),
      } as unknown as TesterEligibilityService,
      {
        load: jest.fn().mockResolvedValue({ id: EXEC, is_archived: false }),
      } as unknown as TestExecutionsService,
      {
        logActionForRequest: jest.fn().mockResolvedValue(undefined),
      } as unknown as AuditLogsService,
      { setAssignee } as unknown as TestCasesService,
    );
  });

  afterEach(() => warn.mockRestore());

  const twoCases = (assigneeId: string | null) => {
    from
      .mockReturnValueOnce(
        buildChain({
          data: [
            { id: 'r1', assignee_id: assigneeId, case_id: 'c1' },
            { id: 'r2', assignee_id: assigneeId, case_id: 'c2' },
          ],
          error: null,
        }),
      )
      .mockReturnValueOnce(
        buildChain({ data: [{ id: 'r1' }, { id: 'r2' }], error: null }),
      );
  };

  it('passes the new assignee to each test case', async () => {
    twoCases(null);

    const result = await service.assign(user, SPACE, EXEC, ['r1', 'r2'], ME);

    expect(result).toEqual({ assigned: 2, unchanged: [] });
    expect(setAssignee.mock.calls).toEqual([
      [user, SPACE, 'c1', ME],
      [user, SPACE, 'c2', ME],
    ]);
  });

  it('counts tests that could not follow and keeps the runs', async () => {
    twoCases(null);
    setAssignee
      .mockRejectedValueOnce(new Error('archived'))
      .mockResolvedValueOnce({ ticket_warning: true });

    const result = await service.assign(user, SPACE, EXEC, ['r1', 'r2'], ME);

    expect(result).toEqual({
      assigned: 2,
      unchanged: [],
      case_sync_failed: 2,
    });
    expect(warn).toHaveBeenCalled();
  });

  it('leaves the test case alone when unassigning', async () => {
    twoCases(ME);

    await service.assign(user, SPACE, EXEC, ['r1', 'r2'], null);

    expect(setAssignee).not.toHaveBeenCalled();
  });
});
