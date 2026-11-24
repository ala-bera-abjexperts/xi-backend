import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';

import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import { TestResultsService } from './test-results.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const ATTEMPT = 'att-1';
const STEP = 'step-1';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;

interface Resolved {
  data: unknown;
  error: { code?: string; message: string } | null;
}

type Chain = Record<string, jest.Mock>;

function buildChain(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of ['select', 'eq']) {
    chain[name] = jest.fn(() => chain);
  }

  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);

  return chain;
}

const stepBody = {
  status: 'PASS' as const,
  expected_status: 'TODO' as const,
  actual_result: 'ok',
  comment: null,
};

const saved = {
  changed: true,
  step_status: 'PASS',
  attempt_status: 'EXECUTING',
  run_status: 'EXECUTING',
  status_overridden: false,
};

describe('TestResultsService', () => {
  let service: TestResultsService;
  let from: jest.Mock;
  let rpc: jest.Mock;
  let log: jest.Mock;
  let hasSpacePermission: jest.Mock;
  let isAdminOrOwner: jest.Mock;
  let assertAvailable: jest.Mock;

  const settings = (assigneeOnly: boolean | null) =>
    from.mockReturnValueOnce(
      buildChain({
        data: assigneeOnly === null ? null : { assignee_only: assigneeOnly },
        error: null,
      }),
    );

  const enforceArg = () =>
    (rpc.mock.calls[0] as [string, Record<string, unknown>])[1]
      .p_enforce_assignee;

  beforeEach(() => {
    from = jest.fn();
    rpc = jest.fn();
    log = jest.fn().mockResolvedValue(undefined);
    hasSpacePermission = jest.fn().mockResolvedValue(false);
    isAdminOrOwner = jest.fn().mockResolvedValue(false);

    assertAvailable = jest.fn().mockResolvedValue(undefined);

    service = new TestResultsService(
      { getClient: () => ({ from, rpc }) } as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      { hasSpacePermission, isAdminOrOwner } as unknown as PermissionsService,
      { logActionForRequest: log } as unknown as AuditLogsService,
    );
  });

  describe('assignee-only', () => {
    it.each([
      ['no settings row (default off)', null, false, false, false],
      ['setting off', false, false, false, false],
      ['on, plain tester', true, false, false, true],
      ['on, test run manager', true, true, false, false],
      ['on, org owner or admin', true, false, true, false],
    ])(
      '%s -> enforce %s',
      async (_label, assigneeOnly, manage, admin, expected) => {
        settings(assigneeOnly);
        hasSpacePermission.mockResolvedValue(manage);
        isAdminOrOwner.mockResolvedValue(admin);
        rpc.mockResolvedValueOnce({ data: saved, error: null });

        await service.submitStepResult(user, SPACE, ATTEMPT, STEP, stepBody);

        expect(enforceArg()).toBe(expected);
      },
    );
  });

  describe('submitStepResult', () => {
    it('passes the full result and returns the saved state', async () => {
      settings(false);
      rpc.mockResolvedValueOnce({ data: saved, error: null });

      const result = await service.submitStepResult(
        user,
        SPACE,
        ATTEMPT,
        STEP,
        stepBody,
      );

      expect(rpc).toHaveBeenCalledWith('tm_submit_step_result', {
        p_organization_id: ORG,
        p_space_id: SPACE,
        p_actor_id: 'user-1',
        p_attempt_id: ATTEMPT,
        p_snapshot_step_id: STEP,
        p_status: 'PASS',
        p_actual_result: 'ok',
        p_comment: null,
        p_expected_status: 'TODO',
        p_enforce_assignee: false,
      });
      expect(result).toEqual({
        changed: true,
        step_status: 'PASS',
        attempt_status: 'EXECUTING',
        status_overridden: false,
      });
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('does not audit a no-op resend', async () => {
      settings(false);
      rpc.mockResolvedValueOnce({
        data: { ...saved, changed: false },
        error: null,
      });

      await service.submitStepResult(user, SPACE, ATTEMPT, STEP, stepBody);

      expect(log).not.toHaveBeenCalled();
    });

    it('passes the texts the caller last read only when sent', async () => {
      settings(false);
      settings(false);
      rpc.mockResolvedValue({ data: saved, error: null });

      await service.submitStepResult(user, SPACE, ATTEMPT, STEP, {
        ...stepBody,
        expected_actual_result: null,
        expected_comment: 'seen',
      });
      await service.submitStepResult(user, SPACE, ATTEMPT, STEP, {
        ...stepBody,
        expected_comment: null,
      });

      expect(rpc).toHaveBeenNthCalledWith(
        1,
        'tm_submit_step_result',
        expect.objectContaining({
          p_expected_text: { actual_result: null, comment: 'seen' },
        }),
      );
      expect(rpc).toHaveBeenNthCalledWith(
        2,
        'tm_submit_step_result',
        expect.objectContaining({ p_expected_text: { comment: null } }),
      );
    });

    it.each([
      ['TM002', ConflictException, 'RESULT_CONFLICT'],
      ['TM003', ConflictException, 'ATTEMPT_NOT_CURRENT'],
      ['TM004', ConflictException, 'ARCHIVED'],
      ['TM011', ForbiddenException, 'NOT_ASSIGNEE'],
      ['TM012', ConflictException, 'ATTEMPT_ABORTED'],
      ['22001', BadRequestException, 'VALIDATION_FAILED'],
      ['P0002', NotFoundException, 'NOT_FOUND'],
      ['55P03', ConflictException, 'BUSY'],
    ])('maps %s', async (code, type, apiCode) => {
      settings(false);
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code, message: 'tm: x', details: '{"current_status":"FAIL"}' },
      });

      const failure = service.submitStepResult(
        user,
        SPACE,
        ATTEMPT,
        STEP,
        stepBody,
      );

      await expect(failure).rejects.toBeInstanceOf(type);
      await failure.catch((e: { getResponse: () => { code: string } }) =>
        expect(e.getResponse().code).toBe(apiCode),
      );
    });

    it('returns the current value with RESULT_CONFLICT and 422 for a foreign step', async () => {
      settings(false);
      rpc.mockResolvedValueOnce({
        data: null,
        error: {
          code: 'TM002',
          message: 'tm: step result changed',
          details:
            '{"current_status":"FAIL","actual_result":"x","comment":null}',
        },
      });

      await expect(
        service.submitStepResult(user, SPACE, ATTEMPT, STEP, stepBody),
      ).rejects.toMatchObject({
        response: {
          code: 'RESULT_CONFLICT',
          data: { current_status: 'FAIL', actual_result: 'x', comment: null },
        },
      });

      settings(false);
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'TM010', message: 'tm: step is not in this attempt' },
      });

      const foreign = service.submitStepResult(
        user,
        SPACE,
        ATTEMPT,
        STEP,
        stepBody,
      );

      await expect(foreign).rejects.toBeInstanceOf(HttpException);
      await foreign.catch((e: HttpException) =>
        expect(e.getStatus()).toBe(422),
      );
    });
  });

  describe('updateAttempt', () => {
    it('checks availability before the body', async () => {
      assertAvailable.mockRejectedValueOnce(new ForbiddenException());

      await expect(
        service.updateAttempt(user, SPACE, ATTEMPT, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an empty change and sends only the keys given', async () => {
      await expect(
        service.updateAttempt(user, SPACE, ATTEMPT, {}),
      ).rejects.toBeInstanceOf(BadRequestException);

      settings(false);
      rpc.mockResolvedValueOnce({
        data: { changed: true, status: 'TODO', status_overridden: false },
        error: null,
      });

      await service.updateAttempt(user, SPACE, ATTEMPT, { actual_minutes: 15 });

      expect(
        (rpc.mock.calls[0] as [string, Record<string, unknown>])[1].p_patch,
      ).toEqual({
        actual_minutes: 15,
      });
    });
  });

  describe('setStatus', () => {
    it('lets only managers override or abort, without calling the database otherwise', async () => {
      await expect(
        service.setStatus(user, SPACE, ATTEMPT, {
          status_mode: 'override',
          status: 'PASS',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.setStatus(user, SPACE, ATTEMPT, { status_mode: 'abort' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('lets a manager override without the assignee check and keeps the reason out of the patch', async () => {
      hasSpacePermission.mockResolvedValue(true);
      rpc.mockResolvedValueOnce({
        data: { changed: true, status: 'PASS', status_overridden: true },
        error: null,
      });

      await service.setStatus(user, SPACE, ATTEMPT, {
        status_mode: 'override',
        status: 'PASS',
        expected_status: 'FAIL',
        reason: 'retested by hand',
      });

      const args = (rpc.mock.calls[0] as [string, Record<string, unknown>])[1];

      expect(args.p_patch).toEqual({
        status_mode: 'override',
        status: 'PASS',
        expected_status: 'FAIL',
      });
      expect(args.p_enforce_assignee).toBe(false);
      expect(log).toHaveBeenCalledWith(
        user,
        'test_run_attempt',
        ATTEMPT,
        'update',
        expect.objectContaining({
          action: 'status_override',
          reason: 'retested by hand',
        }),
      );
    });

    it('lets a tester set a manual status (assignee-only applies) and refuses someone who can do neither', async () => {
      hasSpacePermission.mockImplementation((_u, _o, _s, key: string) =>
        Promise.resolve(key === 'execute_tests'),
      );
      settings(true);
      rpc.mockResolvedValueOnce({
        data: { changed: true, status: 'PASS', status_overridden: false },
        error: null,
      });

      await service.setStatus(user, SPACE, ATTEMPT, {
        status_mode: 'manual',
        status: 'PASS',
      });

      expect(enforceArg()).toBe(true);

      hasSpacePermission.mockResolvedValue(false);
      await expect(
        service.setStatus(user, SPACE, ATTEMPT, {
          status_mode: 'manual',
          status: 'PASS',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('startAttempt', () => {
    it('refuses Reset/Merge on an archived case and a missing run', async () => {
      from.mockReturnValueOnce(
        buildChain({
          data: { id: 'r1', case: { is_archived: true } },
          error: null,
        }),
      );
      await expect(
        service.startAttempt(user, SPACE, 'r1', {
          mode: 'reset',
          expected_attempt_no: 1,
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      from.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.startAttempt(user, SPACE, 'r1', {
          mode: 'reset',
          expected_attempt_no: 1,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('names the archived case so it is not taken for an archived execution', async () => {
      from.mockReturnValueOnce(
        buildChain({
          data: { id: 'r1', case_id: 'c1', case: { is_archived: true } },
          error: null,
        }),
      );

      await expect(
        service.startAttempt(user, SPACE, 'r1', {
          mode: 'merge',
          expected_attempt_no: 1,
        }),
      ).rejects.toMatchObject({
        response: { code: 'ARCHIVED', data: { case_id: 'c1' } },
      });
      expect(rpc).not.toHaveBeenCalled();
    });

    it('starts a merge with the expected attempt number', async () => {
      from.mockReturnValueOnce(
        buildChain({
          data: { id: 'r1', case: { is_archived: false } },
          error: null,
        }),
      );
      rpc.mockResolvedValueOnce({
        data: {
          changed: true,
          attempt_id: 'a3',
          attempt_no: 3,
          status: 'EXECUTING',
          carried_steps: 1,
        },
        error: null,
      });

      const result = await service.startAttempt(user, SPACE, 'r1', {
        mode: 'merge',
        expected_attempt_no: 2,
      });

      expect(rpc).toHaveBeenCalledWith('tm_start_attempt', {
        p_organization_id: ORG,
        p_space_id: SPACE,
        p_actor_id: 'user-1',
        p_run_id: 'r1',
        p_kind: 'merge',
        p_expected_attempt_no: 2,
      });
      expect(result).toEqual({
        attempt_id: 'a3',
        attempt_no: 3,
        status: 'EXECUTING',
        carried_steps: 1,
      });
    });
  });
});
