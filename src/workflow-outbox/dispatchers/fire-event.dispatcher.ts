/** @fileoverview Dispatcher for queued fire_event outbox rows — emits an in-process Nest event. @module src/workflow-outbox/dispatchers/fire-event.dispatcher @author Rajbha Manek */

import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

/** Outbox row payload shape for fire_event rules. */
export interface FireEventPayload {
  event_key: string;
  payload_extra?: Record<string, unknown>;
}

/**
 * Re-publishes a workflow event onto the Nest in-process bus so other modules
 * (e.g. notifications, audit, integrations) can subscribe via
 * `@OnEvent(event_key)`.
 *
 * Always succeeds — the underlying emitter never throws on emit, and we treat
 * "no subscribers" as a valid no-op.
 */
@Injectable()
export class FireEventDispatcher {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  /**
   * Dispatch one outbox row. Merges `payload_extra` with the task and
   * transition identifiers so downstream subscribers always have context.
   */
  dispatch(row: {
    id: string;
    organization_id: string;
    task_id: string;
    transition_id: string | null;
    payload: FireEventPayload;
  }): Promise<void> {
    const { event_key, payload_extra } = row.payload;

    if (!event_key || typeof event_key !== 'string') {
      return Promise.reject(
        new Error(
          `fire_event payload is missing a string event_key (outbox row ${row.id})`,
        ),
      );
    }

    this.eventEmitter.emit(event_key, {
      ...(payload_extra ?? {}),
      task_id: row.task_id,
      transition_id: row.transition_id,
      organization_id: row.organization_id,
    });

    return Promise.resolve();
  }
}
