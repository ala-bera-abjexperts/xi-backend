/** @fileoverview Unit tests for FireEventDispatcher — emits the configured event with merged payload. @module src/workflow-outbox/dispatchers/fire-event.dispatcher.spec @author Rajbha Manek */

import type { EventEmitter2 } from '@nestjs/event-emitter';

import {
  FireEventDispatcher,
  type FireEventPayload,
} from './fire-event.dispatcher';

describe('FireEventDispatcher', () => {
  let emitter: { emit: jest.Mock };
  let dispatcher: FireEventDispatcher;

  function row(payload: FireEventPayload) {
    return {
      id: 'outbox-1',
      organization_id: 'org-1',
      task_id: 'task-1',
      transition_id: 'tx-1',
      payload,
    };
  }

  beforeEach(() => {
    emitter = { emit: jest.fn() };
    dispatcher = new FireEventDispatcher(emitter as unknown as EventEmitter2);
  });

  it('emits the event with merged payload (extras + task + transition + org)', async () => {
    await dispatcher.dispatch(
      row({
        event_key: 'workflow.task.released',
        payload_extra: { custom: 'value', nested: { x: 1 } },
      }),
    );

    expect(emitter.emit).toHaveBeenCalledTimes(1);
    expect(emitter.emit).toHaveBeenCalledWith('workflow.task.released', {
      custom: 'value',
      nested: { x: 1 },
      task_id: 'task-1',
      transition_id: 'tx-1',
      organization_id: 'org-1',
    });
  });

  it('emits even when payload_extra is missing', async () => {
    await dispatcher.dispatch(row({ event_key: 'workflow.task.closed' }));

    expect(emitter.emit).toHaveBeenCalledWith('workflow.task.closed', {
      task_id: 'task-1',
      transition_id: 'tx-1',
      organization_id: 'org-1',
    });
  });

  it('throws when event_key is missing or not a string', async () => {
    await expect(
      dispatcher.dispatch(
        row({ event_key: '' } as unknown as FireEventPayload),
      ),
    ).rejects.toThrow(/event_key/);

    await expect(
      dispatcher.dispatch(
        row({
          event_key: 42 as unknown as string,
        } as unknown as FireEventPayload),
      ),
    ).rejects.toThrow(/event_key/);

    expect(emitter.emit).not.toHaveBeenCalled();
  });
});
