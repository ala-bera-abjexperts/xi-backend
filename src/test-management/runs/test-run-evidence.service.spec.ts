import { NotFoundException } from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import type { TestExecutionsService } from '../executions/test-executions.service';
import { notFound } from '../test-management-errors';
import { TestRunEvidenceService } from './test-run-evidence.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const EXEC = 'exec-1';
const CASE = 'case-1';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;

interface Resolved {
  data: unknown;
  error: { code?: string; message: string } | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Resolved>;

function buildChain(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of ['select', 'eq', 'in', 'not', 'range']) {
    chain[name] = jest.fn(() => chain);
  }

  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  Object.assign(chain, {
    then: (onFulfilled: (value: Resolved) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled),
  });

  return chain;
}

const ok = (data: unknown) => buildChain({ data, error: null });

const runRow = (id: string, caseKey: string, execKey = 'P-TE1') => ({
  id,
  case_id: `case-${id}`,
  execution_id: EXEC,
  case: { task: { key: caseKey, summary: ` Title ${caseKey} ` } },
  execution: { task: { key: execKey } },
});

const fileRow = (
  id: string,
  attemptId: string,
  name: string,
  uploadedAt: string,
  version: object | null = {},
) => ({
  id,
  entity_id: attemptId,
  file_name: name,
  current_version: version && {
    version_number: 1,
    file_size: 10,
    mime_type: 'image/png',
    uploaded_at: uploadedAt,
    uploader: {
      id: 'u-1',
      first_name: 'Ann',
      last_name: 'Lee',
      email: null,
      avatar_url: null,
    },
    ...version,
  },
});

const RUNS = [runRow('r1', 'P-TC1'), runRow('r2', 'P-TC2')];
const ATTEMPTS = [
  { id: 'a1', run_id: 'r1', attempt_no: 1, status: 'FAIL' },
  { id: 'a2', run_id: 'r1', attempt_no: 2, status: 'PASS' },
  { id: 'a3', run_id: 'r2', attempt_no: 1, status: 'BLOCKED' },
];
const FILES = [
  fileRow('f1', 'a1', 'crash.png', '2026-11-01T10:00:00Z'),
  fileRow('f2', 'a2', 'after-fix.png', '2026-11-03T10:00:00Z'),
  fileRow('f3', 'a3', 'Blocked log.txt', '2026-11-02T10:00:00Z'),
];

describe('TestRunEvidenceService', () => {
  let service: TestRunEvidenceService;
  let from: jest.Mock;
  let load: jest.Mock;
  let assertAvailable: jest.Mock;

  // Runs, attempts and files answer in that order.
  function serve(runs = RUNS, attempts = ATTEMPTS, files: unknown[] = FILES) {
    const chains = [ok(runs), ok(attempts), ok(files)];

    from.mockImplementation(() => chains.shift() ?? ok([]));

    return chains.slice();
  }

  beforeEach(() => {
    from = jest.fn();
    load = jest.fn().mockResolvedValue({ id: EXEC });
    assertAvailable = jest.fn().mockResolvedValue(undefined);

    service = new TestRunEvidenceService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      { load } as unknown as TestExecutionsService,
    );
  });

  describe('forExecution', () => {
    it('maps every attempt file to its run, case and execution, scoped to org and space', async () => {
      const [runs, attempts, files] = serve();

      const page = await service.forExecution(user, SPACE, EXEC, {});

      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE);
      expect(load).toHaveBeenCalledWith(ORG, SPACE, EXEC);
      expect(from.mock.calls.map(([table]: [string]) => table)).toEqual([
        'test_runs',
        'test_run_attempts',
        'file_attachments',
      ]);
      expect(runs.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(runs.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(runs.eq).toHaveBeenCalledWith('execution_id', EXEC);
      expect(attempts.in).toHaveBeenCalledWith('run_id', ['r1', 'r2']);
      expect(attempts.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(attempts.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(files.eq).toHaveBeenCalledWith('entity_type', 'test_run_attempt');
      expect(files.in).toHaveBeenCalledWith('entity_id', ['a1', 'a2', 'a3']);
      expect(files.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(files.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(files.not).toHaveBeenCalledWith('current_version_id', 'is', null);

      expect(page.total).toBe(3);
      expect(page.pageSize).toBe(10);
      expect(page.items[0]).toEqual({
        id: 'f2',
        file_name: 'after-fix.png',
        file_size: 10,
        mime_type: 'image/png',
        version_number: 1,
        uploaded_at: '2026-11-03T10:00:00Z',
        uploader: { id: 'u-1', name: 'Ann Lee', avatar_url: null },
        attempt_id: 'a2',
        attempt_no: 2,
        attempt_status: 'PASS',
        run_id: 'r1',
        case_id: 'case-r1',
        case_key: 'P-TC1',
        case_title: 'Title P-TC1',
        execution_id: EXEC,
        execution_key: 'P-TE1',
      });
    });

    it('sorts newest first by default, then oldest and by name both ways', async () => {
      serve();
      expect(
        (await service.forExecution(user, SPACE, EXEC, {})).items.map(
          (i) => i.id,
        ),
      ).toEqual(['f2', 'f3', 'f1']);

      serve();
      expect(
        (
          await service.forExecution(user, SPACE, EXEC, { sort: 'oldest' })
        ).items.map((i) => i.id),
      ).toEqual(['f1', 'f3', 'f2']);

      serve();
      expect(
        (
          await service.forExecution(user, SPACE, EXEC, { sort: 'name' })
        ).items.map((i) => i.file_name),
      ).toEqual(['after-fix.png', 'Blocked log.txt', 'crash.png']);

      serve();
      expect(
        (
          await service.forExecution(user, SPACE, EXEC, { sort: 'name:desc' })
        ).items.map((i) => i.file_name),
      ).toEqual(['crash.png', 'Blocked log.txt', 'after-fix.png']);
    });

    it('filters by file name ignoring case and by attempt status', async () => {
      serve();
      expect(
        (await service.forExecution(user, SPACE, EXEC, { q: 'BLOCKED' })).items,
      ).toEqual([expect.objectContaining({ id: 'f3' })]);

      const [, , files] = serve();
      const page = await service.forExecution(user, SPACE, EXEC, {
        status: ['FAIL', 'BLOCKED'],
      });

      expect(page.items.map((i) => i.id)).toEqual(['f3', 'f1']);
      expect(files.in).toHaveBeenCalledWith('entity_id', ['a1', 'a3']);
    });

    it('pages the sorted list', async () => {
      serve();

      const page = await service.forExecution(user, SPACE, EXEC, {
        page: 2,
        pageSize: 2,
      });

      expect(page).toEqual(
        expect.objectContaining({ total: 3, page: 2, pageSize: 2 }),
      );
      expect(page.items.map((i) => i.id)).toEqual(['f1']);
    });

    it('skips a file whose current version did not come back', async () => {
      serve(RUNS, ATTEMPTS, [
        ...FILES,
        fileRow('f4', 'a1', 'ghost.png', '2026-11-04T10:00:00Z', null),
      ]);

      const page = await service.forExecution(user, SPACE, EXEC, {});

      expect(page.items.map((i) => i.id)).not.toContain('f4');
      expect(page.total).toBe(3);
    });

    it('chunks attempt ids into calls of at most 100', async () => {
      const manyAttempts = Array.from({ length: 150 }, (_, i) => ({
        id: `a${i}`,
        run_id: 'r1',
        attempt_no: i + 1,
        status: 'PASS',
      }));
      const fileChains = [ok([]), ok([])];

      from
        .mockReturnValueOnce(ok(RUNS))
        .mockReturnValueOnce(ok(manyAttempts))
        .mockReturnValueOnce(fileChains[0])
        .mockReturnValueOnce(fileChains[1]);

      await service.forExecution(user, SPACE, EXEC, {});

      expect(fileChains[0].in).toHaveBeenCalledWith(
        'entity_id',
        expect.arrayContaining(['a0', 'a99']),
      );
      expect(
        (fileChains[0].in.mock.calls[0] as [string, string[]])[1],
      ).toHaveLength(100);
      expect(
        (fileChains[1].in.mock.calls[0] as [string, string[]])[1],
      ).toHaveLength(50);
    });

    it('returns an empty page without reading attempts when there are no runs', async () => {
      from.mockReturnValueOnce(ok([]));

      const page = await service.forExecution(user, SPACE, EXEC, {});

      expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 10 });
      expect(from).toHaveBeenCalledTimes(1);
    });

    it('is a 404 for an execution of another space or organisation', async () => {
      load.mockRejectedValueOnce(notFound());

      await expect(
        service.forExecution(user, SPACE, 'foreign', {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('forCase', () => {
    it('loads the case in its space, then reads its runs from every execution', async () => {
      const caseChain = ok({ id: CASE });
      const runs = ok(RUNS);

      from
        .mockReturnValueOnce(caseChain)
        .mockReturnValueOnce(runs)
        .mockReturnValueOnce(ok(ATTEMPTS))
        .mockReturnValueOnce(ok(FILES));

      const page = await service.forCase(user, SPACE, CASE, {});

      expect(caseChain.eq).toHaveBeenCalledWith('id', CASE);
      expect(caseChain.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(caseChain.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(runs.eq).toHaveBeenCalledWith('case_id', CASE);
      expect(runs.eq).not.toHaveBeenCalledWith('execution_id', EXEC);
      expect(runs.eq).not.toHaveBeenCalledWith('execution.is_archived', false);
      expect(page.total).toBe(3);
    });

    it('narrows to one execution when asked', async () => {
      const runs = ok(RUNS);

      from
        .mockReturnValueOnce(ok({ id: CASE }))
        .mockReturnValueOnce(runs)
        .mockReturnValueOnce(ok(ATTEMPTS))
        .mockReturnValueOnce(ok(FILES));

      await service.forCase(user, SPACE, CASE, { executionId: EXEC });

      expect(runs.eq).toHaveBeenCalledWith('case_id', CASE);
      expect(runs.eq).toHaveBeenCalledWith('execution_id', EXEC);
    });

    it('is a 404 for a case of another space or organisation', async () => {
      from.mockReturnValueOnce(ok(null));

      await expect(
        service.forCase(user, SPACE, 'foreign', {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(from).toHaveBeenCalledTimes(1);
    });
  });
});
