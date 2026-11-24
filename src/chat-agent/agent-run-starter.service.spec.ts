import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { ChatConversationRow } from '../chat/chat-access.service';
import type { ChatRealtimeService } from '../chat/chat-realtime.service';
import type { AgentGatesService } from './agent-gates.service';
import { AgentRunStarterService } from './agent-run-starter.service';
import type { AgentRunViewService } from './agent-run-view.service';
import type { AgentRunWorkerService } from './agent-run-worker.service';
import type {
  AgentRunsRepository,
  AgentStartResult,
} from './agent-runs.repository';
import type { AgentSettingsService } from './agent-settings.service';

describe('AgentRunStarterService', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;
  const conversation = {
    id: 'conv-1',
    organization_id: 'org-1',
    kind: 'group',
    dm_key: null,
  } as ChatConversationRow;

  const result = (over: Partial<AgentStartResult> = {}): AgentStartResult => ({
    run_id: 'run-1',
    agent_message_id: 'a1',
    seq: 8,
    thread_root_id: null,
    status: 'running',
    lease_token: 'lease-1',
    created: true,
    refusal: null,
    alert100: false,
    first: false,
    ...over,
  });

  let refusal: jest.Mock;
  let startRun: jest.Mock;
  let notifyBudgetAlert: jest.Mock;
  let messageCreated: jest.Mock;
  let announce: jest.Mock;
  let runLeased: jest.Mock;
  let service: AgentRunStarterService;

  beforeEach(() => {
    refusal = jest.fn().mockResolvedValue(null);
    startRun = jest.fn().mockResolvedValue(result());
    notifyBudgetAlert = jest.fn().mockResolvedValue(undefined);
    messageCreated = jest.fn().mockResolvedValue(undefined);
    announce = jest.fn().mockResolvedValue(undefined);
    runLeased = jest.fn();
    service = new AgentRunStarterService(
      { refusal } as unknown as AgentGatesService,
      { startRun } as unknown as AgentRunsRepository,
      { notifyBudgetAlert } as unknown as AgentSettingsService,
      { messageCreated } as unknown as ChatRealtimeService,
      { announce } as unknown as AgentRunViewService,
      { runLeased } as unknown as AgentRunWorkerService,
    );
  });

  it('starts a run, announces Robert message and run, and hands the lease to the worker', async () => {
    await expect(
      service.start(user, conversation, 'msg-1', {
        timezone: 'Europe/Vienna',
      }),
    ).resolves.toEqual({ id: 'run-1', messageId: 'a1' });

    expect(refusal).toHaveBeenCalledWith(user, conversation);
    expect(startRun).toHaveBeenCalledWith({
      organizationId: 'org-1',
      triggerMessageId: 'msg-1',
      invokerId: 'user-1',
      timezone: 'Europe/Vienna',
      rerunOf: null,
      refusal: null,
    });
    expect(messageCreated).toHaveBeenCalledWith(conversation, {
      messageId: 'a1',
      seq: 8,
      threadRootId: null,
    });
    expect(announce).toHaveBeenCalledWith('run-1');
    expect(runLeased).toHaveBeenCalledWith('run-1', 'lease-1');
    expect(notifyBudgetAlert).not.toHaveBeenCalled();
  });

  it('stores a failed gate as a refusal through the start function (no message, no worker)', async () => {
    refusal.mockResolvedValue('disabled');
    startRun.mockResolvedValue(
      result({
        agent_message_id: null,
        seq: null,
        status: 'refused',
        lease_token: null,
        refusal: 'disabled',
      }),
    );

    await expect(service.start(user, conversation, 'msg-1')).resolves.toEqual({
      id: 'run-1',
      messageId: null,
    });
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({ refusal: 'disabled' }),
    );
    expect(messageCreated).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith('run-1');
    expect(runLeased).not.toHaveBeenCalled();
  });

  it('delivers the 100% budget alert when the start function says so', async () => {
    startRun.mockResolvedValue(
      result({
        agent_message_id: null,
        status: 'refused',
        lease_token: null,
        refusal: 'budget_org',
        alert100: true,
      }),
    );
    await service.start(user, conversation, 'msg-1');

    expect(notifyBudgetAlert).toHaveBeenCalledWith('org-1', 100);
  });

  it('announces nothing again for a resend that found the run already there', async () => {
    startRun.mockResolvedValue(result({ created: false, lease_token: null }));

    await expect(service.start(user, conversation, 'msg-1')).resolves.toEqual({
      id: 'run-1',
      messageId: 'a1',
    });
    expect(messageCreated).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    expect(runLeased).not.toHaveBeenCalled();
  });

  it('leaves a queued run (no free slot, or the worker off here) to the sweep', async () => {
    startRun.mockResolvedValue(result({ status: 'queued', lease_token: null }));
    await service.start(user, conversation, 'msg-1');

    expect(messageCreated).toHaveBeenCalled();
    expect(runLeased).not.toHaveBeenCalled();
  });

  it('passes a re-run through to the start function', async () => {
    await service.start(user, conversation, 'msg-1', {
      rerunOf: 'run-0',
      timezone: null,
    });

    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({ rerunOf: 'run-0', timezone: null }),
    );
  });

  it('lets an error of the start function reach the caller (the send hook swallows it)', async () => {
    startRun.mockRejectedValue(new Error('down'));

    await expect(service.start(user, conversation, 'msg-1')).rejects.toThrow(
      'down',
    );
  });
});
