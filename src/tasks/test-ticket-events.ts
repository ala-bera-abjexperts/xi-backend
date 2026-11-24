import { BadRequestException } from '@nestjs/common';

import { htmlToPlainText } from '../chat/chat-html';
import type { KindTypeColumn } from '../test-management/common/test-task-types';

// Limits of test_cases / test_sets that the shared ticket fields must also meet.
export const TEST_TITLE_MAX = 255;
export const TEST_TEXT_MAX = 10000;
export const TEST_ESTIMATE_MAX = 10080;

// Test Management listens to this, so tasks never import that module.
export const TEST_TICKET_CREATED_EVENT = 'tasks.test_ticket.created';

export interface TestTicketCreatedEvent {
  organizationId: string;
  spaceId: string;
  taskId: string;
  kind: KindTypeColumn;
  summary: string;
  description: string | null;
  estimatedTime: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  assignedTo?: string | null;
  userId: string;
}

// Test Management sends this to delete the ticket of a linked test case or set.
export const TEST_RECORD_DELETED_EVENT = 'tasks.test_record.deleted';

export interface TestRecordDeletedEvent {
  organizationId: string;
  taskId: string;
  userId: string;
}

// Task → Test Management before a ticket is deleted, so a linked test plan is checked and deleted first.
export const TEST_TICKET_DELETING_EVENT = 'tasks.test_ticket.deleting';

export interface TestTicketDeletingEvent {
  organizationId: string;
  taskId: string;
  userId: string | null;
}

// Fields a ticket and its test record share; only the changed ones are sent.
export interface TestTicketFieldChanges {
  summary?: string;
  // The old summary, for the test case's history; the case no longer keeps a copy.
  previousSummary?: string;
  description?: string | null;
  estimatedTime?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  assignedTo?: string | null;
}

/** Test case objective is plain text; the ticket description is rich text. */
export function ticketTextForCase(description: string | null | undefined) {
  return htmlToPlainText(description) || null;
}

/** A plan date is a day; a ticket date becomes the day of its nearest UTC midnight, so local-midnight picks keep their day. */
export function ticketDateToPlanDay(
  value: string | null | undefined,
): string | null {
  if (!value) return null;

  const time = Date.parse(value);

  return Number.isNaN(time)
    ? null
    : new Date(time + 12 * 3_600_000).toISOString().slice(0, 10);
}

/** Rich text goes to the ticket as it is; older plain-text descriptions become one escaped paragraph per line. */
export function planTextToTicketHtml(text: string | null): string {
  if (!text) return '';
  if (text.trimStart().startsWith('<')) return text;

  const escape = (line: string) =>
    line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return text
    .split('\n')
    .map((line) => `<p>${escape(line)}</p>`)
    .join('');
}

export function planDayToTicketDate(day: string | null): string | null {
  return day ? `${day}T00:00:00.000Z` : null;
}

/** Throws a clear 400 when a test plan ticket would end before it starts. */
export function checkPlanTicketDates(
  start: string | null | undefined,
  due: string | null | undefined,
): void {
  const from = ticketDateToPlanDay(start);
  const to = ticketDateToPlanDay(due);

  if (from && to && to < from) {
    throw new BadRequestException({
      code: 'TEST_DATES_ORDER',
      message:
        'The due date of a test plan ticket cannot be before its start date.',
    });
  }
}

/** Throws a clear 400 when a shared field would not fit the test case or set of the ticket. */
export function checkTestTicketFields(
  kind:
    | 'case_task_type_id'
    | 'set_task_type_id'
    | 'plan_task_type_id'
    | 'execution_task_type_id'
    | 'precondition_task_type_id',
  fields: TestTicketFieldChanges,
): void {
  if (fields.summary !== undefined) {
    const title = fields.summary.trim();

    if (!title) {
      throw new BadRequestException({
        code: 'TEST_TITLE_EMPTY',
        message: 'A Test Management ticket needs a summary.',
      });
    }

    // Counted in characters, as the database counts them.
    if (Array.from(title).length > TEST_TITLE_MAX) {
      throw new BadRequestException({
        code: 'TEST_TITLE_TOO_LONG',
        message: `The summary of a Test Management ticket can be at most ${TEST_TITLE_MAX} characters.`,
      });
    }
  }

  if (fields.description !== undefined) {
    // Test cases and executions show plain text, so that is what counts.
    const text =
      kind === 'case_task_type_id' || kind === 'execution_task_type_id'
        ? (ticketTextForCase(fields.description) ?? '')
        : (fields.description ?? '');

    if (text.length > TEST_TEXT_MAX) {
      throw new BadRequestException({
        code: 'TEST_TEXT_TOO_LONG',
        message: `The description of a Test Management ticket can be at most ${TEST_TEXT_MAX} characters.`,
      });
    }
  }

  const estimate = fields.estimatedTime;

  if (
    kind === 'case_task_type_id' &&
    estimate !== undefined &&
    estimate !== null &&
    (!Number.isInteger(estimate) ||
      estimate < 0 ||
      estimate > TEST_ESTIMATE_MAX)
  ) {
    throw new BadRequestException({
      code: 'TEST_ESTIMATE_TOO_LARGE',
      message: `The estimate of a test case ticket must be between 0 and ${TEST_ESTIMATE_MAX} minutes.`,
    });
  }
}

// Task → test record, after a ticket's shared fields changed.
export const TEST_TICKET_UPDATED_EVENT = 'tasks.test_ticket.updated';

export interface TestTicketUpdatedEvent {
  organizationId: string;
  spaceId: string;
  taskId: string;
  kind: KindTypeColumn;
  userId: string;
  changes: TestTicketFieldChanges;
}

// Test record → task, after Test Management changed a shared field.
export const TEST_RECORD_UPDATED_EVENT = 'tasks.test_record.updated';

export interface TestRecordUpdatedEvent {
  organizationId: string;
  taskId: string;
  userId: string;
  changes: TestTicketFieldChanges;
}
