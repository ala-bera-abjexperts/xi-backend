/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- test doubles are typed as `any`; the type-checked unsafe rules add no value in mock assertions */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';

import {
  FORM_APPROVAL_COMPLETED_EVENT,
  FormBuilderApprovalsService,
} from './form-builder-approvals.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import type { MailService } from '../mail/mail.service';
import type { DecideApprovalDto } from './dto/decide-approval.dto';

// A chainable + thenable Supabase query-builder stub. Every builder method returns
// the same object (so `.select().eq().eq()...` keeps chaining), terminal awaits
// resolve to `resolved`, and `.single()/.maybeSingle()` resolve to it too.
function buildChain(resolved: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;

  chain.select = jest.fn().mockImplementation(self);
  chain.eq = jest.fn().mockImplementation(self);
  chain.neq = jest.fn().mockImplementation(self);
  chain.filter = jest.fn().mockImplementation(self);
  chain.in = jest.fn().mockImplementation(self);
  chain.order = jest.fn().mockImplementation(self);
  chain.limit = jest.fn().mockImplementation(self);
  chain.insert = jest.fn().mockImplementation(self);
  chain.update = jest.fn().mockImplementation(self);
  chain.delete = jest.fn().mockImplementation(self);
  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled);

  return chain;
}

const CTX = { spaceId: 'space-1', orgId: 'org-1' };

describe('FormBuilderApprovalsService', () => {
  let service: FormBuilderApprovalsService;
  let mockFrom: jest.Mock;
  let broadcast: { broadcastNotification: jest.Mock };
  let mail: { sendNotificationEmail: jest.Mock };
  let events: { emit: jest.Mock };

  function wire(tableQueues: Record<string, ReturnType<typeof buildChain>[]>) {
    mockFrom.mockImplementation((table: string) => {
      const queue = tableQueues[table];

      if (!queue || !queue.length)
        throw new Error(`unexpected from('${table}') call`);

      return queue.shift();
    });
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    broadcast = {
      broadcastNotification: jest.fn().mockResolvedValue(undefined),
    };
    mail = { sendNotificationEmail: jest.fn().mockResolvedValue(undefined) };
    events = { emit: jest.fn() };

    const supabase = {
      getClient: () => ({ from: mockFrom, rpc: jest.fn() }),
    } as unknown as SupabaseAdminService;

    service = new FormBuilderApprovalsService(
      supabase,
      broadcast as unknown as NotificationsBroadcastService,
      mail as unknown as MailService,
      events as unknown as EventEmitter2,
    );
  });

  const submission = {
    id: 'sub-1',
    form_id: 'form-1',
    space_id: 'space-1',
    organization_id: 'org-1',
    submitted_by: 'user-2',
    data: {} as Record<string, unknown>,
    is_test: false,
  };

  describe('startApproval', () => {
    it('inserts one approval + step rows and notifies only the first approver in sequential mode', async () => {
      const configChain = buildChain({
        data: {
          settings: {
            approval: {
              enabled: true,
              mode: 'sequential',
              approverUserIds: ['u1', 'u2'],
              condition: null,
            },
          },
        },
        error: null,
      });
      const membersChain = buildChain({
        data: [{ user_id: 'u1' }, { user_id: 'u2' }],
        error: null,
      });
      const approvalInsertChain = buildChain({
        data: { id: 'appr-1' },
        error: null,
      });
      const stepsInsertChain = buildChain({
        data: [
          { id: 'step-u1', approver_user_id: 'u1', step_order: 0 },
          { id: 'step-u2', approver_user_id: 'u2', step_order: 1 },
        ],
        error: null,
      });
      const notifNameChain = buildChain({
        data: { name: 'My Form' },
        error: null,
      });
      const spacesChain = buildChain({ data: { key: 'SPC' }, error: null });
      const notifInsertChain = buildChain({
        data: [{ id: 'n1' }],
        error: null,
      });
      const usersChain = buildChain({
        data: [{ id: 'u1', email: 'u1@example.com' }],
        error: null,
      });

      // startApproval closes by re-reading the approval + its steps to decide its boolean
      // return (the finalize/task gate). A pending approval with >=1 step => returns true.
      const gateChain = buildChain({
        data: { id: 'appr-1', steps: [{ id: 'step-u1' }, { id: 'step-u2' }] },
        error: null,
      });

      wire({
        form_builder: [configChain, notifNameChain],
        space_members: [membersChain],
        form_builder_approvals: [approvalInsertChain, gateChain],
        form_builder_approval_steps: [stepsInsertChain],
        notifications: [notifInsertChain],
        spaces: [spacesChain],
        users: [usersChain],
      });

      await expect(service.startApproval(submission, CTX)).resolves.toBe(true);

      expect(approvalInsertChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: 'org-1',
          space_id: 'space-1',
          form_id: 'form-1',
          submission_id: 'sub-1',
          status: 'pending',
          mode: 'sequential',
        }),
      );
      // two approvers => two step rows, ordered
      const stepRows = (stepsInsertChain.insert as jest.Mock).mock.calls[0][0];

      expect(stepRows).toHaveLength(2);
      expect(stepRows[0]).toEqual(
        expect.objectContaining({ approver_user_id: 'u1', step_order: 0 }),
      );
      expect(stepRows[1]).toEqual(
        expect.objectContaining({ approver_user_id: 'u2', step_order: 1 }),
      );
      // sequential => only the first approver is notified (one notification row). It's a
      // generic FYI notification (action_status 'none') — decisions are made via the
      // dedicated approvals inbox (decide()/listPendingForApprover), not inline on the
      // notification itself.
      const notifRows = (notifInsertChain.insert as jest.Mock).mock.calls[0][0];

      expect(notifRows).toHaveLength(1);
      expect(notifRows[0]).toEqual(
        expect.objectContaining({
          user_id: 'u1',
          type: 'form_approval_request',
          // actionable notification (the bell renders inline Approve/Reject for a pending step)
          action_status: 'pending',
          metadata: expect.objectContaining({
            form_id: 'form-1',
            submission_id: 'sub-1',
          }),
        }),
      );
      expect(broadcast.broadcastNotification).toHaveBeenCalledTimes(1);
      expect(mail.sendNotificationEmail).toHaveBeenCalledWith(
        'u1@example.com',
        expect.any(String),
        expect.any(String),
      );
    });

    it('does nothing when approval config is disabled', async () => {
      const configChain = buildChain({
        data: { settings: { approval: { enabled: false } } },
        error: null,
      });

      wire({ form_builder: [configChain] });

      await expect(service.startApproval(submission, CTX)).resolves.toBe(false);
      expect(mockFrom).toHaveBeenCalledTimes(1);
      expect(mockFrom).not.toHaveBeenCalledWith('form_builder_approvals');
    });

    it('creates no approval when the condition evaluates to false', async () => {
      const configChain = buildChain({
        data: {
          settings: {
            approval: {
              enabled: true,
              approverUserIds: ['u1'],
              // amount > 100 is required, but the submission answer is 5 => false
              condition: {
                combinator: 'and',
                rules: [{ field: 'amount', operator: 'gt', value: 100 }],
              },
            },
          },
        },
        error: null,
      });

      wire({ form_builder: [configChain] });

      await expect(
        service.startApproval({ ...submission, data: { amount: 5 } }, CTX),
      ).resolves.toBe(false);
      expect(mockFrom).toHaveBeenCalledTimes(1);
      expect(mockFrom).not.toHaveBeenCalledWith('form_builder_approvals');
      expect(mockFrom).not.toHaveBeenCalledWith('space_members');
    });

    it('is idempotent — a 23505 on the approval insert stops before creating steps', async () => {
      const configChain = buildChain({
        data: {
          settings: {
            approval: {
              enabled: true,
              mode: 'sequential',
              approverUserIds: ['u1'],
              condition: null,
            },
          },
        },
        error: null,
      });
      const membersChain = buildChain({
        data: [{ user_id: 'u1' }],
        error: null,
      });
      const approvalInsertChain = buildChain({
        data: null,
        error: { code: '23505', message: 'duplicate key' },
      });

      // On a duplicate submit and stops before creating steps; the closing
      // gate read then finds the ALREADY-existing pending approval + its step, so startApproval
      // returns true (the submission is genuinely under approval — task stays deferred).
      const gateChain = buildChain({
        data: { id: 'appr-existing', steps: [{ id: 'step-existing' }] },
        error: null,
      });

      wire({
        form_builder: [configChain],
        space_members: [membersChain],
        form_builder_approvals: [approvalInsertChain, gateChain],
      });

      await expect(service.startApproval(submission, CTX)).resolves.toBe(true);
      expect(mockFrom).not.toHaveBeenCalledWith('form_builder_approval_steps');
      expect(mockFrom).not.toHaveBeenCalledWith('notifications');
    });
  });

  describe('decide', () => {
    const pendingStep = {
      id: 'step-1',
      approval_id: 'appr-1',
      approver_user_id: 'user-1',
      step_order: 0,
      decision: 'pending',
    };
    const pendingApproval = {
      id: 'appr-1',
      form_id: 'form-1',
      space_id: 'space-1',
      organization_id: 'org-1',
      submission_id: 'sub-1',
      status: 'pending',
      mode: 'sequential',
    };

    it('throws NotFoundException when the caller is not the pending approver', async () => {
      const stepChain = buildChain({ data: null, error: null });

      wire({ form_builder_approval_steps: [stepChain] });

      await expect(
        service.decide(
          'step-1',
          'not-the-approver',
          { decision: 'approved' } as DecideApprovalDto,
          CTX,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // authorization is row-level: id + space + org + approver + decision=pending
      expect(stepChain.eq).toHaveBeenCalledWith(
        'approver_user_id',
        'not-the-approver',
      );
      expect(stepChain.eq).toHaveBeenCalledWith('decision', 'pending');
    });

    it('finalizes the approval as approved when it was the last pending step', async () => {
      const stepChain = buildChain({ data: pendingStep, error: null });
      // decide()'s cross-layer gating read on the steps table
      const pendingLayerChain = buildChain({
        data: [{ layer_index: 0 }],
        error: null,
      });
      const approvalChain = buildChain({ data: pendingApproval, error: null });
      const configChain = buildChain({ data: { settings: {} }, error: null });
      // the guarded UPDATE now .select('id')s the row it changed
      const stepUpdateChain = buildChain({
        data: [{ id: 'step-1' }],
        error: null,
      });
      const resolveNotifChain = buildChain({ data: [], error: null });
      const pendingSelectChain = buildChain({ data: [], error: null });
      const finalizeUpdateChain = buildChain({
        data: [{ id: 'appr-1' }],
        error: null,
      });
      // finalize dismisses still-pending siblings' notifications — none pending here
      const dismissStepsChain = buildChain({ data: [], error: null });
      const submitterChain = buildChain({
        data: { submitted_by: 'user-2' },
        error: null,
      });
      const notifNameChain = buildChain({
        data: { name: 'My Form' },
        error: null,
      });
      const spacesChain = buildChain({ data: { key: 'SPC' }, error: null });
      const notifInsertChain = buildChain({
        data: [{ id: 'n1' }],
        error: null,
      });
      const usersChain = buildChain({
        data: [{ id: 'user-2', email: 'user2@example.com' }],
        error: null,
      });

      wire({
        form_builder_approval_steps: [
          stepChain,
          pendingLayerChain,
          stepUpdateChain,
          pendingSelectChain,
          dismissStepsChain,
        ],
        form_builder_approvals: [approvalChain, finalizeUpdateChain],
        form_builder: [configChain, notifNameChain],
        form_builder_submissions: [submitterChain],
        spaces: [spacesChain],
        // decide() resolves the approver's own notification first, then the submitter insert
        notifications: [resolveNotifChain, notifInsertChain],
        users: [usersChain],
      });

      await expect(
        service.decide(
          'step-1',
          'user-1',
          { decision: 'approved' } as DecideApprovalDto,
          CTX,
        ),
      ).resolves.toEqual({ status: 'approved' });

      expect(stepUpdateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approved' }),
      );
      expect(finalizeUpdateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'approved' }),
      );
      // finalize is guarded to only touch a still-pending approval
      expect(finalizeUpdateChain.eq).toHaveBeenCalledWith('status', 'pending');
    });

    it('finalizes the approval as rejected on a reject decision', async () => {
      const stepChain = buildChain({ data: pendingStep, error: null });
      // decide()'s cross-layer gating read on the steps table
      const pendingLayerChain = buildChain({
        data: [{ layer_index: 0 }],
        error: null,
      });
      const approvalChain = buildChain({ data: pendingApproval, error: null });
      const configChain = buildChain({ data: { settings: {} }, error: null });
      // the guarded UPDATE now .select('id')s the row it changed
      const stepUpdateChain = buildChain({
        data: [{ id: 'step-1' }],
        error: null,
      });
      const resolveNotifChain = buildChain({ data: [], error: null });
      const finalizeUpdateChain = buildChain({
        data: [{ id: 'appr-1' }],
        error: null,
      });
      // finalize dismisses still-pending siblings' notifications — none pending here
      const dismissStepsChain = buildChain({ data: [], error: null });
      const submitterChain = buildChain({
        data: { submitted_by: null },
        error: null,
      });

      wire({
        form_builder_approval_steps: [
          stepChain,
          pendingLayerChain,
          stepUpdateChain,
          dismissStepsChain,
        ],
        form_builder_approvals: [approvalChain, finalizeUpdateChain],
        form_builder: [configChain],
        form_builder_submissions: [submitterChain],
        // decide() flips the approver's own notification to resolved (best-effort)
        notifications: [resolveNotifChain],
      });

      await expect(
        service.decide(
          'step-1',
          'user-1',
          { decision: 'rejected', comment: 'nope' } as DecideApprovalDto,
          CTX,
        ),
      ).resolves.toEqual({ status: 'rejected' });

      expect(finalizeUpdateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'rejected' }),
      );
    });

    it('finalizes a parallel approval immediately on a single rejection, mode-agnostically', async () => {
      const parallelApproval = { ...pendingApproval, mode: 'parallel' };
      const stepChain = buildChain({ data: pendingStep, error: null });
      const pendingLayerChain = buildChain({
        data: [{ layer_index: 0 }],
        error: null,
      });
      const approvalChain = buildChain({ data: parallelApproval, error: null });
      const configChain = buildChain({ data: { settings: {} }, error: null });
      const stepUpdateChain = buildChain({
        data: [{ id: 'step-1' }],
        error: null,
      });
      const finalizeUpdateChain = buildChain({
        data: [{ id: 'appr-1' }],
        error: null,
      });
      // finalize reads the approval's steps to dismiss stale notifications — none here
      const dismissStepsChain = buildChain({ data: [], error: null });
      // decide() resolves the rejecter's own bell notification (best-effort)
      const resolveNotifChain = buildChain({ data: [], error: null });
      const submitterChain = buildChain({
        data: { submitted_by: null },
        error: null,
      });

      wire({
        form_builder_approval_steps: [
          stepChain,
          pendingLayerChain,
          stepUpdateChain,
          dismissStepsChain,
        ],
        form_builder_approvals: [approvalChain, finalizeUpdateChain],
        form_builder: [configChain],
        form_builder_submissions: [submitterChain],
        notifications: [resolveNotifChain],
      });

      await expect(
        service.decide(
          'step-1',
          'user-1',
          { decision: 'rejected', comment: 'nope' } as DecideApprovalDto,
          CTX,
        ),
      ).resolves.toEqual({ status: 'rejected' });

      // a single reject finalizes the whole approval immediately regardless of mode — the
      // still-pending sibling step (e.g. 'step-2') is left as-is.
      expect(finalizeUpdateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'rejected' }),
      );
    });

    it('rejects a reject-without-comment (always required)', async () => {
      const stepChain = buildChain({ data: pendingStep, error: null });
      // decide() runs a cross-layer gating read on the steps table before resolving
      const pendingLayerChain = buildChain({
        data: [{ layer_index: 0 }],
        error: null,
      });
      const approvalChain = buildChain({ data: pendingApproval, error: null });
      const configChain = buildChain({
        data: { settings: {} },
        error: null,
      });

      wire({
        form_builder_approval_steps: [stepChain, pendingLayerChain],
        form_builder_approvals: [approvalChain],
        form_builder: [configChain],
      });

      await expect(
        service.decide(
          'step-1',
          'user-1',
          { decision: 'rejected', comment: '  ' } as DecideApprovalDto,
          CTX,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockFrom).not.toHaveBeenCalledWith('form_builder_submissions');
    });
  });

  // finalizeApproval's UPDATE is guarded by .eq('status','pending'), so a concurrent second
  // finalize matches ZERO rows. Every side effect must hang off that result: the listener's
  // "does a task already exist" check is a read-then-write with no lock and
  // idx_form_builder_submissions_task_id is NOT unique, so a double emit can create duplicate
  // tasks for one submission.
  describe('finalizeApproval — concurrent decide guard', () => {
    const pendingStep = {
      id: 'step-1',
      approval_id: 'appr-1',
      approver_user_id: 'user-1',
      decision: 'pending',
      layer_index: 0,
      layer_require_all: true,
      layer_min_approvals: null,
      step_order: 0,
    };

    const pendingApproval = {
      id: 'appr-1',
      form_id: 'form-1',
      submission_id: 'sub-1',
      status: 'pending',
      mode: 'sequential',
    };

    /** Wires a decide() whose finalize UPDATE loses the race (0 rows changed). */
    function wireLostRace(decision: 'approved' | 'rejected') {
      wire({
        form_builder_approval_steps: [
          buildChain({ data: pendingStep, error: null }),
          buildChain({ data: [{ layer_index: 0 }], error: null }),
          buildChain({ data: [{ id: 'step-1' }], error: null }),
          buildChain({ data: [], error: null }),
          buildChain({ data: [], error: null }),
        ],
        form_builder_approvals: [
          buildChain({ data: pendingApproval, error: null }),
          // the guarded UPDATE changed nothing — another caller already finalized
          buildChain({ data: [], error: null }),
        ],
        form_builder: [buildChain({ data: { settings: {} }, error: null })],
        notifications: [buildChain({ data: [], error: null })],
      });

      return service.decide(
        'step-1',
        'user-1',
        { decision, comment: 'because' } as DecideApprovalDto,
        CTX,
      );
    }

    // Positive control for the three negative cases below: with an identical wiring except that
    // the guarded UPDATE reports a row changed, the same code path DOES emit. Without this pair
    // the negative assertions would still pass if the emit were removed entirely.
    it('DOES emit the completed event when it won the race', async () => {
      wire({
        form_builder_approval_steps: [
          buildChain({ data: pendingStep, error: null }),
          buildChain({ data: [{ layer_index: 0 }], error: null }),
          buildChain({ data: [{ id: 'step-1' }], error: null }),
          buildChain({ data: [], error: null }),
          buildChain({ data: [], error: null }),
        ],
        form_builder_approvals: [
          buildChain({ data: pendingApproval, error: null }),
          // this caller flipped pending -> approved
          buildChain({ data: [{ id: 'appr-1' }], error: null }),
        ],
        form_builder: [
          buildChain({ data: { settings: {} }, error: null }),
          buildChain({ data: { name: 'My Form' }, error: null }),
        ],
        form_builder_submissions: [
          buildChain({ data: { submitted_by: 'user-2' }, error: null }),
        ],
        spaces: [buildChain({ data: { key: 'SPC' }, error: null })],
        notifications: [
          buildChain({ data: [], error: null }),
          buildChain({ data: [{ id: 'n1' }], error: null }),
        ],
        users: [
          buildChain({
            data: [{ id: 'user-2', email: 'user2@example.com' }],
            error: null,
          }),
        ],
      });

      await expect(
        service.decide(
          'step-1',
          'user-1',
          { decision: 'approved' } as DecideApprovalDto,
          CTX,
        ),
      ).resolves.toEqual({ status: 'approved' });

      expect(events.emit).toHaveBeenCalledWith(FORM_APPROVAL_COMPLETED_EVENT, {
        submissionId: 'sub-1',
      });
    });

    it('does NOT emit the completed event when it lost the race (no duplicate tasks)', async () => {
      await expect(wireLostRace('approved')).resolves.toEqual({
        status: 'approved',
      });

      expect(events.emit).not.toHaveBeenCalled();
    });

    it('does NOT stamp the rejected outcome when it lost the race', async () => {
      // An approve and a reject can race: one meets quorum, the other rejects into an
      // unreachable layer. If the losing rejecter still wrote its outcome it would mark a
      // submission "rejected — no task created" that was in fact approved and already has a task.
      await expect(wireLostRace('rejected')).resolves.toEqual({
        status: 'rejected',
      });

      expect(mockFrom).not.toHaveBeenCalledWith('form_builder_submissions');
    });

    it('does NOT notify the submitter twice when it lost the race', async () => {
      await expect(wireLostRace('approved')).resolves.toEqual({
        status: 'approved',
      });

      // notifySubmitter reads the submission, then inserts a notification and emails.
      expect(mockFrom).not.toHaveBeenCalledWith('form_builder_submissions');
      expect(broadcast.broadcastNotification).not.toHaveBeenCalled();
      expect(mail.sendNotificationEmail).not.toHaveBeenCalled();
    });
  });

  describe('listForForm', () => {
    it('asserts the form then returns its approvals with steps', async () => {
      const assertFormChain = buildChain({
        data: { id: 'form-1' },
        error: null,
      });
      const rows = [{ id: 'appr-1', steps: [] }];
      const listChain = buildChain({ data: rows, error: null });

      wire({
        form_builder: [assertFormChain],
        form_builder_approvals: [listChain],
      });

      await expect(service.listForForm('form-1', CTX)).resolves.toEqual(rows);
      expect(listChain.eq).toHaveBeenCalledWith('form_id', 'form-1');
    });
  });

  describe('listPendingForApprover', () => {
    it('drops steps whose parent approval is no longer pending', async () => {
      const rows = [
        { id: 's1', approval: { status: 'pending' } },
        { id: 's2', approval: { status: 'rejected' } },
        { id: 's3', approval: null },
      ];
      const stepsChain = buildChain({ data: rows, error: null });

      wire({ form_builder_approval_steps: [stepsChain] });

      const result = await service.listPendingForApprover(
        'space-1',
        'org-1',
        'user-1',
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('s1');
    });
  });

  describe('listPendingForApproverOrgWide', () => {
    it('returns the caller pending steps across spaces, dropping non-pending approvals', async () => {
      const rows = [
        { id: 's1', space_id: 'space-1', approval: { status: 'pending' } },
        { id: 's2', space_id: 'space-2', approval: { status: 'pending' } },
        { id: 's3', space_id: 'space-3', approval: { status: 'rejected' } },
        { id: 's4', space_id: 'space-4', approval: null },
      ];
      const stepsChain = buildChain({ data: rows, error: null });

      wire({ form_builder_approval_steps: [stepsChain] });

      const result = await service.listPendingForApproverOrgWide(
        'org-1',
        'user-1',
      );

      // only the two pending-approval steps survive; each keeps its own space_id so the
      // org-wide inbox can decide the step in the space it belongs to.
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.id)).toEqual(['s1', 's2']);
      expect(result.map((r) => r.space_id)).toEqual(['space-1', 'space-2']);
    });
  });
});
