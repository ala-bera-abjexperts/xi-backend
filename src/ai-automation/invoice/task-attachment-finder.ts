/**
 * @fileoverview Finds and downloads a ticket's invoice file for AI Invoice Extraction. The run's
 * client is service-role (no RLS), so every read is scoped to the run's organization and the task
 * to the run's space.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ExecutionContext } from '../../automations/actions/types';
import { hasUnresolvedPlaceholder } from '../../automations/utils/template';
import { neutraliseStatusCodes } from '../tenant-ai.service';

const LABEL = 'AI Invoice Extraction';

// Same buckets and path rule as attachments.service.ts.
const ATTACHMENT_BUCKET = 'attachments';
const LEGACY_TASK_ATTACHMENT_BUCKET = 'task-attachments';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_NAMES_IN_ERROR = 5;

export interface TaskRef {
  id: string;
  key: string | null;
}

export interface TaskAttachment {
  id: string;
  name: string;
  bucket: string;
  path: string;
  size: number | null;
  mimeType: string | null;
  addedAt: string;
}

export interface PickOptions {
  attachmentId?: string | null;
  fileNamePattern?: string | null;
  onMultipleMatches?: 'newest' | 'fail' | null;

  // The file the "Attachment added" trigger fired for, so a run reads the file that was just added
  // instead of an older one that happens to match the name pattern.
  triggerAttachmentId?: string | null;
}

interface VersionRow {
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
  uploaded_at: string | null;
}

interface CurrentRow {
  id: string;
  file_name: string;
  created_at: string;
  current_version: VersionRow | VersionRow[] | null;
}

interface LegacyRow {
  id: string;
  file_name: string;
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: string | null;
}

type RunLogger = ExecutionContext['logger'];

function normaliseName(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function listNames(attachments: TaskAttachment[]): string {
  const names = attachments
    .slice(0, MAX_NAMES_IN_ERROR)
    .map((a) => a.name)
    .join(', ');
  const more =
    attachments.length > MAX_NAMES_IN_ERROR
      ? `, +${attachments.length - MAX_NAMES_IN_ERROR} more`
      : '';

  return `${names}${more}`;
}

/** The run's task, verified to belong to this organization and space. */
export async function loadTask(
  client: SupabaseClient,
  organizationId: string,
  spaceId: string,
  rawTaskId: string,
): Promise<TaskRef> {
  const taskId = rawTaskId.trim();

  if (taskId === '' || hasUnresolvedPlaceholder(taskId)) {
    throw new Error(
      `(400) ${LABEL}: the task resolved to nothing for this trigger.`,
    );
  }

  if (!UUID_RE.test(taskId)) {
    throw new Error(
      `(400) ${LABEL}: "${taskId.slice(0, 100)}" is not a task id.`,
    );
  }

  const { data, error } = await client
    .from('tasks')
    .select('id, key')
    .eq('id', taskId)
    .eq('organization_id', organizationId)
    .eq('space_id', spaceId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `${LABEL}: could not read task ${taskId} — ${neutraliseStatusCodes(error.message)} — it will be retried.`,
    );
  }

  if (!data) {
    throw new Error(
      `(404) ${LABEL}: task ${taskId} was not found in this space.`,
    );
  }

  return data as TaskRef;
}

/** Current uploads (latest version) plus legacy `task_attachments` rows not mirrored there. */
export async function listTaskAttachments(
  client: SupabaseClient,
  organizationId: string,
  taskId: string,
): Promise<TaskAttachment[]> {
  const [current, legacy] = await Promise.all([
    client
      .from('file_attachments')
      .select(
        `id, file_name, created_at,
        current_version:file_versions!file_attachments_current_version_fk(
          file_path, file_size, mime_type, uploaded_at
        )`,
      )
      .eq('entity_type', 'task')
      .eq('entity_id', taskId)
      .eq('organization_id', organizationId)
      .not('current_version_id', 'is', null),
    client
      .from('task_attachments')
      .select('id, file_name, file_path, file_size, mime_type, created_at')
      .eq('task_id', taskId)
      .eq('organization_id', organizationId),
  ]);

  const error = current.error ?? legacy.error;

  if (error) {
    throw new Error(
      `${LABEL}: could not list the ticket's attachments — ${neutraliseStatusCodes(error.message)} — it will be retried.`,
    );
  }

  const attachments: TaskAttachment[] = [];
  const seenPaths = new Set<string>();

  for (const row of (current.data ?? []) as CurrentRow[]) {
    const version = Array.isArray(row.current_version)
      ? row.current_version[0]
      : row.current_version;

    if (!version) continue;

    seenPaths.add(version.file_path);
    attachments.push({
      id: row.id,
      name: row.file_name,
      path: version.file_path,
      bucket: version.file_path.startsWith(`${organizationId}/tasks/`)
        ? LEGACY_TASK_ATTACHMENT_BUCKET
        : ATTACHMENT_BUCKET,
      size: version.file_size,
      mimeType: version.mime_type,
      addedAt: version.uploaded_at ?? row.created_at,
    });
  }

  for (const row of (legacy.data ?? []) as LegacyRow[]) {
    if (seenPaths.has(row.file_path)) continue;

    attachments.push({
      id: row.id,
      name: row.file_name,
      path: row.file_path,
      bucket: LEGACY_TASK_ATTACHMENT_BUCKET,
      size: row.file_size,
      mimeType: row.mime_type,
      addedAt: row.created_at ?? '',
    });
  }

  return attachments;
}

/** The configured name words; unresolved `{{ }}` words are dropped. */
function nameWords(raw: string, logger: RunLogger): string[] {
  const words = raw
    .split(/[,\n]/)
    .map((word) => word.trim())
    .filter((word) => word !== '');

  if (words.length === 0) {
    throw new Error(`(400) ${LABEL}: no attachment name words configured.`);
  }

  const resolved = words.filter((word) => !hasUnresolvedPlaceholder(word));

  if (resolved.length < words.length) {
    logger.info(
      `${LABEL}: ${words.length - resolved.length} attachment name word(s) resolved to nothing for this trigger — ignored`,
    );
  }

  if (resolved.length === 0) {
    throw new Error(
      `(400) ${LABEL}: the attachment name words resolved to nothing for this trigger.`,
    );
  }

  return resolved;
}

/** The exact attachment when an id is given, else the name match (newest, or fail on several). */
export function pickAttachment(
  attachments: TaskAttachment[],
  task: TaskRef,
  options: PickOptions,
  logger: RunLogger,
): TaskAttachment {
  const ticket = task.key ?? task.id;
  const wantedId = options.attachmentId?.trim() ?? '';

  if (wantedId !== '') {
    if (hasUnresolvedPlaceholder(wantedId)) {
      logger.info(
        `${LABEL}: Attachment ID resolved to nothing for this trigger — searching by name instead`,
      );
    } else {
      if (!UUID_RE.test(wantedId)) {
        throw new Error(
          `(400) ${LABEL}: "${wantedId.slice(0, 100)}" is not an attachment id.`,
        );
      }

      const byId = attachments.find(
        (a) => a.id.toLowerCase() === wantedId.toLowerCase(),
      );

      if (!byId) {
        throw new Error(
          `(404) ${LABEL}: attachment ${wantedId} is not attached to ticket ${ticket}.`,
        );
      }

      return byId;
    }
  }

  const words = nameWords(options.fileNamePattern ?? '', logger);
  const wanted = words.map((word) => `"${word}"`).join(' or ');

  if (attachments.length === 0) {
    throw new Error(`(404) ${LABEL}: ticket ${ticket} has no attachments.`);
  }

  // The run is about the file that was just added. Searching by name here would happily pick an
  // older attachment that matches better, which is never what "attachment added" means.
  const triggered = options.triggerAttachmentId?.trim() ?? '';
  const current =
    triggered === ''
      ? undefined
      : attachments.find((a) => a.id.toLowerCase() === triggered.toLowerCase());

  if (current) {
    const currentName = normaliseName(current.name);

    if (
      words.length === 0 ||
      words.some((w) => currentName.includes(normaliseName(w)))
    ) {
      return current;
    }

    throw new Error(
      `(422) ${LABEL}: the file just added to ticket ${ticket} ("${current.name}") does not match ${wanted} — nothing to extract.`,
    );
  }

  const needles = words.map(normaliseName);
  const matches = attachments
    .filter((a) => {
      const name = normaliseName(a.name);

      return needles.some((needle) => name.includes(needle));
    })
    .sort(
      (a, b) => (Date.parse(b.addedAt) || 0) - (Date.parse(a.addedAt) || 0),
    );

  if (matches.length === 0) {
    throw new Error(
      `(404) ${LABEL}: no attachment on ticket ${ticket} has a name containing ${wanted} (attachments: ${listNames(attachments)}).`,
    );
  }

  if (matches.length > 1) {
    if (options.onMultipleMatches === 'fail') {
      throw new Error(
        `(409) ${LABEL}: ${matches.length} attachments match ${wanted}: ${listNames(matches)} — rename them or pick one with Attachment ID.`,
      );
    }

    logger.info(
      `${LABEL}: ${matches.length} attachments match ${wanted} — using the newest, ${matches[0].name}`,
    );
  }

  return matches[0];
}

/** The file's bytes; a missing object is permanent, any other storage error is retried. */
export async function downloadAttachment(
  client: SupabaseClient,
  attachment: TaskAttachment,
): Promise<Buffer> {
  const { data, error } = await client.storage
    .from(attachment.bucket)
    .download(attachment.path);

  if (error || !data) {
    const reason = error?.message || 'no data returned';
    const status = error as { status?: unknown; statusCode?: unknown } | null;
    const missing =
      status?.status === 404 ||
      status?.statusCode === '404' ||
      status?.statusCode === 'NoSuchKey' ||
      /not.?found/i.test(reason);

    if (missing) {
      throw new Error(
        `(404) ${LABEL}: ${attachment.name} is missing in storage (${reason}).`,
      );
    }

    throw new Error(
      `${LABEL}: could not download ${neutraliseStatusCodes(attachment.name)} — ${neutraliseStatusCodes(reason)} — it will be retried.`,
    );
  }

  return Buffer.from(await data.arrayBuffer());
}
