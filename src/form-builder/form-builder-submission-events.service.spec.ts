import {
  FormBuilderSubmissionEventsService,
  FORM_SUBMISSION_FINALIZED_EVENT,
} from './form-builder-submission-events.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { FormBuilderApprovalsService } from './form-builder-approvals.service';
import { FormBuilderWebhookDispatcherService } from './form-builder-webhook-dispatcher.service';
import { FormBuilderIntegrationDispatcherService } from './form-builder-integration-dispatcher.service';
import { FormBuilderTaskCreatorService } from './form-builder-task-creator.service';

// A chainable + thenable Supabase query-builder stub (see webhooks spec for shape).
function buildChain(resolved: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;

  chain.select = jest.fn().mockImplementation(self);
  chain.insert = jest.fn().mockImplementation(self);
  chain.update = jest.fn().mockImplementation(self);
  chain.upsert = jest.fn().mockImplementation(self);
  chain.delete = jest.fn().mockImplementation(self);
  chain.eq = jest.fn().mockImplementation(self);
  chain.neq = jest.fn().mockImplementation(self);
  chain.in = jest.fn().mockImplementation(self);
  chain.contains = jest.fn().mockImplementation(self);
  chain.order = jest.fn().mockImplementation(self);
  chain.limit = jest.fn().mockImplementation(self);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.then = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => Promise.resolve(resolved).then(onFulfilled, onRejected);

  return chain;
}

describe('FormBuilderSubmissionEventsService', () => {
  let service: FormBuilderSubmissionEventsService;
  let mockFrom: jest.Mock;
  let approvals: { startApproval: jest.Mock };
  let webhooks: { enqueue: jest.Mock };
  let integrations: { enqueue: jest.Mock };
  let taskCreator: { maybeCreateTask: jest.Mock };

  const finalRow = {
    id: 'sub-1',
    form_id: 'form-1',
    space_id: 'space-1',
    organization_id: 'org-1',
    submitted_by: 'user-1',
    data: { name: 'Ada' },
    is_test: false,
  };

  beforeEach(() => {
    mockFrom = jest.fn();
    // startApproval returns "is a real pending approval now live" — the branch selector for
    // deferred vs immediate task creation. Default false = no approval configured.
    approvals = { startApproval: jest.fn().mockResolvedValue(false) };
    webhooks = { enqueue: jest.fn().mockResolvedValue(undefined) };
    integrations = { enqueue: jest.fn().mockResolvedValue(undefined) };
    taskCreator = { maybeCreateTask: jest.fn().mockResolvedValue(undefined) };

    const supabase = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    // All five required dependencies must be passed. Constructing with only three left
    // `integrations` and `taskCreator` undefined, so every call on them threw a TypeError that
    // dispatch()'s per-step try/catch swallowed — the integration enqueue, the task-creation
    // branch and the pending_approval stamp were all provably never exercised while the suite
    // still went green.
    service = new FormBuilderSubmissionEventsService(
      supabase,
      approvals as unknown as FormBuilderApprovalsService,
      webhooks as unknown as FormBuilderWebhookDispatcherService,
      integrations as unknown as FormBuilderIntegrationDispatcherService,
      taskCreator as unknown as FormBuilderTaskCreatorService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('dispatch', () => {
    it('starts approval and enqueues webhooks for a real (non-test) submission', async () => {
      await service.dispatch(finalRow);

      expect(approvals.startApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'sub-1',
          form_id: 'form-1',
          space_id: 'space-1',
          organization_id: 'org-1',
          submitted_by: 'user-1',
          data: { name: 'Ada' },
        }),
        { spaceId: 'space-1', orgId: 'org-1' },
      );
      expect(webhooks.enqueue).toHaveBeenCalledWith(
        { id: 'sub-1', form_id: 'form-1' },
        'submission.created',
        { spaceId: 'space-1', orgId: 'org-1' },
      );
    });

    it('skips a test submission', async () => {
      await service.dispatch({ ...finalRow, is_test: true });

      expect(approvals.startApproval).not.toHaveBeenCalled();
      expect(webhooks.enqueue).not.toHaveBeenCalled();
    });

    it('skips a submission missing required tenant scope', async () => {
      const { space_id, ...withoutSpace } = finalRow;

      void space_id;

      await service.dispatch(withoutSpace);

      expect(approvals.startApproval).not.toHaveBeenCalled();
      expect(webhooks.enqueue).not.toHaveBeenCalled();
    });

    it('never lets a dependency error bubble into the submit path', async () => {
      approvals.startApproval.mockRejectedValueOnce(new Error('approval boom'));

      await expect(service.dispatch(finalRow)).resolves.toBeUndefined();
    });

    it('enqueues native integrations alongside webhooks', async () => {
      await service.dispatch(finalRow);

      expect(integrations.enqueue).toHaveBeenCalledWith(
        { id: 'sub-1', form_id: 'form-1' },
        'submission.created',
        { spaceId: 'space-1', orgId: 'org-1' },
      );
    });

    // The two halves of the approval branch at :138-152. Neither was reachable before the
    // constructor fix, so both are asserted here explicitly.
    it('creates the task immediately when no approval is pending', async () => {
      approvals.startApproval.mockResolvedValueOnce(false);

      await service.dispatch(finalRow);

      expect(taskCreator.maybeCreateTask).toHaveBeenCalledWith(
        'form-1',
        'org-1',
        'user-1',
        { name: 'Ada' },
        'sub-1',
      );
      // no deferral marker written
      expect(mockFrom).not.toHaveBeenCalledWith('form_builder_submissions');
    });

    it('defers task creation and stamps pending_approval when an approval started', async () => {
      approvals.startApproval.mockResolvedValueOnce(true);

      const outcomeChain = buildChain({ data: null, error: null });

      mockFrom.mockImplementation((table: string) => {
        if (table === 'form_builder_submissions') return outcomeChain;
        throw new Error(`unexpected from('${table}')`);
      });

      await service.dispatch(finalRow);

      expect(taskCreator.maybeCreateTask).not.toHaveBeenCalled();
      expect(outcomeChain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          task_creation_status: 'pending_approval',
        }),
      );
    });

    // Anonymous submissions reach the task creator with a null submitter; the fallback author
    // chain lives there, not here, so dispatch must pass the null through rather than skip.
    it('passes a null submitter through to the task creator', async () => {
      await service.dispatch({ ...finalRow, submitted_by: null });

      expect(taskCreator.maybeCreateTask).toHaveBeenCalledWith(
        'form-1',
        'org-1',
        null,
        { name: 'Ada' },
        'sub-1',
      );
    });
  });

  describe('handleFinalized', () => {
    it('self-hydrates a submitted, non-test submission and dispatches it', async () => {
      const subChain = buildChain({
        data: { ...finalRow, status: 'submitted' },
        error: null,
      });

      mockFrom.mockReturnValue(subChain);

      await service.handleFinalized({ submissionId: 'sub-1' });

      expect(mockFrom).toHaveBeenCalledWith('form_builder_submissions');
      expect(approvals.startApproval).toHaveBeenCalledTimes(1);
      expect(webhooks.enqueue).toHaveBeenCalledTimes(1);
    });

    it('does not dispatch a submission that is not in submitted status', async () => {
      const subChain = buildChain({
        data: { ...finalRow, status: 'draft' },
        error: null,
      });

      mockFrom.mockReturnValue(subChain);

      await service.handleFinalized({ submissionId: 'sub-1' });

      expect(approvals.startApproval).not.toHaveBeenCalled();
      expect(webhooks.enqueue).not.toHaveBeenCalled();
    });

    it('returns early when there is no submission id in the payload', async () => {
      await service.handleFinalized(
        undefined as unknown as { submissionId: string },
      );

      expect(mockFrom).not.toHaveBeenCalled();
      expect(approvals.startApproval).not.toHaveBeenCalled();
    });

    it('exports the finalized event name', () => {
      expect(FORM_SUBMISSION_FINALIZED_EVENT).toBe(
        'form_builder.submission.finalized',
      );
    });
  });
});
