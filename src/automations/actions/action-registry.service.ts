import { Injectable, OnModuleInit } from '@nestjs/common';
import type { ZodType, ZodSafeParseResult } from 'zod';

import { clampToMaxLength } from '../utils/truncate';

import type { ActionDefinition, ExecutionContext } from './types';
import { emailSend } from './integrations/email';
import { githubCreateIssue } from './integrations/github';
import { jiraCreateIssue } from './integrations/jira';
import { slackSendMessage } from './integrations/slack';
import { googleCalendarCreateEvent } from './integrations/google-calendar';
import { webhookOutbound } from './integrations/webhook-outbound';
import { notionCreatePage } from './integrations/notion';
import { linearCreateIssue } from './integrations/linear';
import { teamsSendMessage } from './integrations/teams';
import { clickupCreateTask } from './integrations/clickup';
import { asanaCreateTask } from './integrations/asana';
import { trelloCreateCard } from './integrations/trello';
import { discordPostWebhook } from './integrations/discord';
import { googleSheetsAppendRow } from './integrations/google-sheets';
import { airtableAction } from './integrations/airtable';
import { outlookSendEmail } from './integrations/outlook-send-email';
import { hubspotFetchOrCreateContact } from './integrations/hubspot';
import { salesforceCreateLead } from './integrations/salesforce';
import { twilioSendSms } from './integrations/twilio';
import {
  taskAddComment,
  taskCreate,
  taskUpdate,
  taskAssign,
} from './app-mutations/task';
import { wikiCreatePage, wikiUpdatePage } from './app-mutations/wiki';
import { processUpdate, riskUpdate } from './app-mutations/process';
import { planCreate } from './app-mutations/plan';
import { notificationCreate, auditLog } from './app-mutations/misc';
import {
  assetSendDetailsEmail,
  assetObjectCreate,
  assetObjectUpdate,
  assetObjectDelete,
  assetObjectChangeType,
  assetObjectAddComment,
  assetObjectAddAttachment,
} from './app-mutations/asset';

/**
 * Reads a value out of a nested object by a Zod issue path.
 */
function readAtPath(root: unknown, path: PropertyKey[]): unknown {
  return path.reduce<unknown>(
    (node, key) =>
      node && typeof node === 'object'
        ? (node as Record<PropertyKey, unknown>)[key]
        : undefined,
    root,
  );
}

/** Writes a value into a nested object by a Zod issue path, cloning each level it touches. */
function writeAtPath(
  root: unknown,
  path: PropertyKey[],
  value: unknown,
): unknown {
  if (!path.length) return value;
  const [head, ...rest] = path;
  const base: Record<PropertyKey, unknown> =
    root && typeof root === 'object'
      ? { ...(root as Record<PropertyKey, unknown>) }
      : {};

  base[head] = writeAtPath(base[head], rest, value);

  if (Array.isArray(root)) {
    const copy = [...root] as unknown[];
    copy[head as number] = base[head];

    return copy;
  }

  return base;
}

/**
 * Validates an action's config, trimming any string that merely exceeds the provider's own maximum
 * and validating once more.
 *
 * Why: a resolved template can be far longer than the provider allows — a whole form submission
 * rendered into a Slack `text` (max 4000), a Discord `content` (2000) or a Twilio `body` (1600).
 * Failing the run loses the notification entirely, which is worse than delivering it with a visible
 * "… (truncated)" marker. The limit is read from the provider's own schema, so every integration is
 * covered by this one place rather than each action repeating a cap.
 *
 * Deliberately narrow: it only runs on a config that ALREADY failed, and only when EVERY issue is an
 * oversized string. Any other problem — a bad UUID, a missing required field — is returned
 * untouched, so no real validation error is ever masked and nothing that validates today changes.
 */
export function parseConfigClampingOversizedStrings<T>(
  schema: ZodType<T>,
  config: unknown,
): ZodSafeParseResult<T> {
  const first = schema.safeParse(config);

  if (first.success) return first;

  const oversized = first.error.issues.filter(
    (issue) =>
      issue.code === 'too_big' &&
      typeof (issue as { maximum?: unknown }).maximum === 'number' &&
      issue.path.length > 0 &&
      readAtPath(config, issue.path as PropertyKey[]) !== undefined &&
      typeof readAtPath(config, issue.path as PropertyKey[]) === 'string',
  );

  if (!oversized.length || oversized.length !== first.error.issues.length)
    return first;

  let clamped: unknown = config;

  for (const issue of oversized) {
    const path = issue.path as PropertyKey[];
    const maximum = Number((issue as { maximum: number }).maximum);
    const text = readAtPath(clamped, path) as string;

    clamped = writeAtPath(clamped, path, clampToMaxLength(text, maximum));
  }

  const second = schema.safeParse(clamped);

  // If trimming did not actually satisfy the schema, report the ORIGINAL failure — it describes the
  // real problem, and a second-order error from our own edit would only mislead.
  return second.success ? second : first;
}

@Injectable()
export class ActionRegistryService implements OnModuleInit {
  private readonly map = new Map<string, ActionDefinition>();

  onModuleInit(): void {
    [
      emailSend,
      githubCreateIssue,
      jiraCreateIssue,
      slackSendMessage,
      googleCalendarCreateEvent,
      webhookOutbound,
      notionCreatePage,
      linearCreateIssue,
      teamsSendMessage,
      clickupCreateTask,
      asanaCreateTask,
      trelloCreateCard,
      discordPostWebhook,
      googleSheetsAppendRow,
      airtableAction,
      outlookSendEmail,
      twilioSendSms,
      hubspotFetchOrCreateContact,
      salesforceCreateLead,
      taskAddComment,
      taskCreate,
      taskUpdate,
      taskAssign,
      wikiCreatePage,
      wikiUpdatePage,
      processUpdate,
      riskUpdate,
      planCreate,
      notificationCreate,
      auditLog,
      assetSendDetailsEmail,
      assetObjectCreate,
      assetObjectUpdate,
      assetObjectDelete,
      assetObjectChangeType,
      assetObjectAddComment,
      assetObjectAddAttachment,
    ].forEach((def) => this.map.set(def.kind, def));
  }

  /**
   * Register an action definition at runtime (keyed by `kind`, overwriting any
   * existing entry). Lets a feature module self-register its own action from its
   * `onModuleInit` — e.g. the Document Designer "export by template" action —
   * instead of being hard-listed in this file's built-in array above.
   */
  register(def: ActionDefinition): void {
    this.map.set(def.kind, def);
  }

  get(kind: string): ActionDefinition | undefined {
    return this.map.get(kind);
  }

  has(kind: string): boolean {
    return this.map.has(kind);
  }

  async dispatch(
    kind: string,
    config: unknown,
    input: unknown,
    ctx: ExecutionContext,
  ): Promise<unknown> {
    const def = this.map.get(kind);

    if (!def) {
      throw new Error(`Action handler for "${kind}" not registered`);
    }

    // A blank/placeholder connectionId means "use the default connected account" (documented for
    // every provider). Drop it so .optional() treats it as absent and resolveConnection falls back
    // to the space default — instead of a raw ZodError on z.string().uuid(). Heals older saved
    // definitions and template seeds ('' / '__REPLACE_WITH_CONNECTION_ID__'); a non-blank non-UUID
    // string still fails validation.
    let normalizedConfig = config;

    if (config && typeof config === 'object' && !Array.isArray(config)) {
      const c = config as Record<string, unknown>;
      const conn = c.connectionId;

      if (
        conn === null ||
        conn === '__REPLACE_WITH_CONNECTION_ID__' ||
        (typeof conn === 'string' && conn.trim() === '')
      ) {
        normalizedConfig = { ...c };
        delete (normalizedConfig as Record<string, unknown>).connectionId;
      }
    }

    const configResult = parseConfigClampingOversizedStrings(
      def.configSchema,
      normalizedConfig,
    );

    if (!configResult.success) {
      console.error(
        `[dispatch] config validation failed for "${kind}":`,
        JSON.stringify(configResult.error.issues),
        '| raw config:',
        JSON.stringify(config),
      );
      throw configResult.error;
    }

    const parsedInput = def.inputSchema.parse(input ?? {});

    console.log(`Dispatching action "${kind}" with config:`, configResult.data);
    console.log(`Dispatching action "${kind}" with input:`, ctx);

    return def.handler(configResult.data, parsedInput, ctx);
  }
}
