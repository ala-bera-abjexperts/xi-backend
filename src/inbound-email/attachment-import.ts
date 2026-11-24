// Import policy for email attachments → ticket files.
//
// Everything that decides WHICH attachments become files lives here, so the rules are readable in
// one place instead of being spread through the action.
//
// Writes go through AttachmentsService.importVersion, never upload(): upload() demands a real
// space-member permission (an automation's resolved user often is not one) and fires an
// app.task.attachment_added outbox event per file, so a five-attachment email would trigger five
// more automations. importVersion has neither problem and is idempotent by version number.

import { Logger } from '@nestjs/common';
import type { AttachmentsService } from '../attachments/attachments.service';
import {
  listAttachments,
  downloadAttachment,
  FILE_ATTACHMENT_TYPE,
  type GraphAttachmentMeta,
} from './graph-attachment.reader';

// Per file. Well under the 100 MB `attachments` bucket ceiling on purpose: bytes are held in memory
// as a Buffer, and one email already fans out to every automation watching that mailbox.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Per email, across all files. The real guard against a mail bomb — a count limit alone would still
// allow 20 × 25 MB.
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

// Default when the automation does not configure one.
export const DEFAULT_MAX_FILES = 20;

// Ceiling on the configured value. A mistyped 500 must not become 500 Graph downloads.
export const MAX_FILES_LIMIT = 50;

export interface SkippedAttachment {
  name: string;
  reason: string;
}

export interface ImportOutcome {
  imported: number;
  skipped: SkippedAttachment[];
}

/**
 * Why an import produced the result it did.
 *
 * "imported 0" is ambiguous on its own — the switch may be off, the email may have had no files, or
 * every file may have been skipped. Run history has to tell those apart, so the reason travels with
 * the count instead of being inferred from it.
 */
export type AttachmentImportState =
  /** saveAttachments is off for this automation. */
  | 'disabled'
  /** Already imported on an earlier attempt; this run did nothing. */
  | 'already'
  /** Ingested before attachment support shipped, so the Graph id was never stored. */
  | 'unsupported'
  /** Ran to completion. `imported` and `skipped` describe what happened. */
  | 'done'
  /** Graph or storage failed. The ticket is unaffected. */
  | 'error';

export interface AttachmentImportReport extends ImportOutcome {
  state: AttachmentImportState;
  /** Only set when state is 'error'. */
  error?: string;
}

export interface ImportArgs {
  accessToken: string;
  mailboxAddress: string;
  graphMessageId: string;
  taskId: string;
  /** Read from the task row, never from the run context — importVersion does no tenancy check. */
  organizationId: string;
  spaceId: string | null;
  /** Real public.users.id. Both columns are FKs, so this may never be null. */
  userId: string;
  /** Configured limit; clamped into [1, MAX_FILES_LIMIT]. */
  maxFiles?: number;
  /** File names already on the task, lower-cased, so an import never collides with them. */
  existingNames: Set<string>;
}

export function clampMaxFiles(value: unknown): number {
  const n = Number(value);

  if (!Number.isFinite(n)) return DEFAULT_MAX_FILES;

  return Math.min(Math.max(Math.trunc(n), 1), MAX_FILES_LIMIT);
}

/** "report.pdf" + taken → "report (2).pdf". Extension is preserved so the file still opens. */
export function uniqueFileName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;

  const dot = name.lastIndexOf('.');
  // A leading dot marks a hidden file, it is not an extension separator.
  const hasExt = dot > 0 && dot < name.length - 1;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';

  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;

    if (!taken.has(candidate.toLowerCase())) return candidate;
  }

  // Deterministic names exhausted; fall back to something guaranteed unique.
  return `${base} (${Date.now()})${ext}`;
}

/**
 * Splits the listed attachments into the ones worth downloading and the ones to record as skipped.
 *
 * An absent @odata.type is treated as importable rather than skipped: some tenants omit it when
 * $select is used, and skipping on absence would silently import nothing. A referenceAttachment that
 * slips through fails on download and is caught per-file.
 */
export function selectImportable(
  all: GraphAttachmentMeta[],
  maxFiles: number,
): { take: GraphAttachmentMeta[]; skipped: SkippedAttachment[] } {
  const skipped: SkippedAttachment[] = [];
  const candidates: GraphAttachmentMeta[] = [];

  for (const a of all) {
    if (a.isInline) {
      // Signature logos and banners. Importing them would attach several junk images to every
      // ticket; the body already references them by cid.
      skipped.push({ name: a.name, reason: 'inline' });
      continue;
    }

    if (a.odataType && a.odataType !== FILE_ATTACHMENT_TYPE) {
      // itemAttachment (an embedded mail/event) and referenceAttachment (a OneDrive link) have no
      // retrievable bytes.
      skipped.push({ name: a.name, reason: `unsupported_type:${a.odataType}` });
      continue;
    }

    if (a.size > MAX_ATTACHMENT_BYTES) {
      skipped.push({ name: a.name, reason: 'too_large' });
      continue;
    }

    candidates.push(a);
  }

  for (const a of candidates.slice(maxFiles)) {
    skipped.push({ name: a.name, reason: 'max_files_exceeded' });
  }

  return { take: candidates.slice(0, maxFiles), skipped };
}

/**
 * Download each selected attachment and store it against the task.
 *
 * Sequential on purpose: only one file is ever resident in memory, and Graph throttles a burst of
 * parallel reads. One bad attachment is recorded and skipped — it never aborts the rest.
 */
export async function importEmailAttachments(
  attachments: AttachmentsService,
  logger: Logger,
  args: ImportArgs,
): Promise<ImportOutcome> {
  const maxFiles = clampMaxFiles(args.maxFiles ?? DEFAULT_MAX_FILES);

  const listed = await listAttachments(
    args.accessToken,
    args.mailboxAddress,
    args.graphMessageId,
  );

  const { take, skipped } = selectImportable(listed, maxFiles);
  const taken = new Set(args.existingNames);
  let imported = 0;
  let totalBytes = 0;

  for (const meta of take) {
    try {
      if (totalBytes + meta.size > MAX_TOTAL_BYTES) {
        skipped.push({ name: meta.name, reason: 'email_total_size_exceeded' });
        continue;
      }

      const data = await downloadAttachment(
        args.accessToken,
        args.mailboxAddress,
        args.graphMessageId,
        meta.id,
      );

      // Graph's reported size includes encoding overhead, so re-check the real length rather than
      // trusting the estimate that got us here.
      if (data.byteLength > MAX_ATTACHMENT_BYTES) {
        skipped.push({ name: meta.name, reason: 'too_large' });
        continue;
      }

      const fileName = uniqueFileName(meta.name, taken);

      await attachments.importVersion({
        organizationId: args.organizationId,
        spaceId: args.spaceId,
        entityType: 'task',
        entityId: args.taskId,
        fileName,
        // Always the first version: an email attachment is never a revision of an existing file.
        // Collisions are avoided by renaming above, not by stacking versions, so importVersion can
        // never adopt-and-discard these bytes.
        versionNumber: 1,
        data,
        mimeType: meta.contentType,
        uploadedBy: args.userId,
        comment: null,
        createdBy: args.userId,
      });

      taken.add(fileName.toLowerCase());
      totalBytes += data.byteLength;
      imported++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      logger.warn(
        `attachment "${meta.name}" not imported for task ${args.taskId}: ${message}`,
      );
      skipped.push({ name: meta.name, reason: 'error' });
    }
  }

  return { imported, skipped };
}
