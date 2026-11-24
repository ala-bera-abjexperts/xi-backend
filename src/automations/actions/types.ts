import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';

import type { ConnectionProvider } from '../interfaces/automation.interface';

export type { ConnectionProvider };

export interface StepHelpers {
  sleep: (name: string, ms: number) => Promise<void>;
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

export interface DecryptedConnection {
  id: string;
  provider: ConnectionProvider;
  displayName: string;
  externalAccountId: string | null;
  decryptedSecret: string;
  metadata: Record<string, unknown>;
}

/**
 * A photo/signature answer from the triggering form submission, carried as bytes.
 *
 * Providers differ in how an image is shown: Slack takes the raw bytes (files.upload), Discord takes
 * multipart, email takes an attachment, while Jira/Teams/Notion only accept a URL. Handing every
 * action BOTH the bytes and a signed URL lets each use whichever it supports, instead of the message
 * text carrying a link nobody can render.
 */
export interface SubmissionMediaItem {
  filename: string;
  mimeType: string;
  /** Raw bytes, for providers that upload directly. */
  bytes: Buffer;
  /** Time-limited link, for providers that can only reference a URL. */
  signedUrl?: string;
}

export interface ExecutionContext {
  runId: string;
  automationId: string;
  spaceId: string;
  organizationId: string;
  triggerKind: string;
  triggerPayload: unknown;
  previousStepOutputs: Record<string, unknown>;
  resolveConnection: (
    provider: ConnectionProvider,
    connectionId?: string,
  ) => Promise<DecryptedConnection>;
  step: StepHelpers;
  supabase: SupabaseClient;
  actingUserId: string | null;
  logger: {
    info: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
  };
  broadcastNotification?: (notification: Record<string, unknown>) => void;

  /** Image answers from the triggering form submission; empty for every other trigger. */
  submissionMedia?: SubmissionMediaItem[];
}

export type NodeCategory =
  | 'app_event'
  | 'schedule'
  | 'webhook'
  | 'integration'
  | 'app_mutation'
  | 'ai'
  | 'control';

export interface I18nString {
  en: string;
  de: string;
}

export interface ActionDefinition {
  kind: string;
  category: NodeCategory;
  type: 'action' | 'control';
  label: I18nString;
  description: I18nString;
  icon: string;
  inputSchema: z.ZodType;
  configSchema: z.ZodType;
  outputSchema: z.ZodType;
  requiresConnection?: string;
  handler: (
    config: unknown,
    input: unknown,
    ctx: ExecutionContext,
  ) => Promise<unknown>;
}
