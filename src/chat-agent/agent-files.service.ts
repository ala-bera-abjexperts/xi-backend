/**
 * @fileoverview The files Robert reads for a run (1.18), as the person who asked. Each file goes
 * through AttachmentsService.getDownloadInfo with the invoker, so Robert opens exactly the files
 * that person could open; a refusal is `no_access` and nothing is downloaded. Downloads are
 * capped in size and time, read in small batches, and every failure is a reason, never a throw.
 */
import { Injectable, Logger } from '@nestjs/common';

import { AttachmentsService } from '../attachments/attachments.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { extractText, type FileText, labelled, selectRelevant } from './pipeline/agent-file-text';

/** A file a run may read: where it was shared and how the model will cite it. */
export interface AgentFileRef {
  handle: string;
  attachmentId: string;
  name: string;
  mime: string | null;
  size: number | null;
  /** The message it is attached to (m3), or the task (T1). */
  from: string;
}

export type AgentFileRead = AgentFileRef & FileText;

export const MAX_FILES_PER_RUN = 8;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** What one run reads of its files altogether when the request is about them: about 20k tokens. */
export const MAX_RUN_FILE_CHARS = 70_000;
/** When the request is not about the files, the recent ones are only background. */
export const MAX_BACKGROUND_FILE_CHARS = 12_000;
const DOWNLOAD_TIMEOUT_MS = 10_000;

/**
 * The signed URL as the server can fetch it. On a local stack it comes back browser-relative
 * ("/storage/v1/...", see browserSafeStorageUrl): it is resolved against SUPABASE_URL. Only the
 * configured storage origin is ever fetched.
 */
export function storageUrl(signedUrl: string, storageBase = process.env.SUPABASE_URL ?? ''): string {
  const base = new URL(storageBase);
  const url = new URL(signedUrl, base);
  if (url.origin !== base.origin || !url.pathname.startsWith('/storage/v1/')) {
    throw new Error('not a storage URL');
  }
  return url.toString();
}
const PARALLEL = 3;

@Injectable()
export class AgentFilesService {
  private readonly logger = new Logger(AgentFilesService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly attachments: AttachmentsService,
  ) {}

  /** The current files of these tasks (ids), with their names; permissions are checked on read. */
  async taskFiles(
    organizationId: string,
    taskIds: string[],
  ): Promise<{ taskId: string; attachmentId: string; name: string; mime: string | null; size: number | null }[]> {
    if (!taskIds.length) return [];
    const { data } = await this.supabaseAdmin
      .getClient()
      .from('file_attachments')
      .select('id, entity_id, file_name, current_version:file_versions!file_attachments_current_version_fk(file_size, mime_type)')
      .eq('organization_id', organizationId)
      .eq('entity_type', 'task')
      .in('entity_id', taskIds)
      .not('current_version_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(50);
    return ((data ?? []) as unknown as {
      id: string;
      entity_id: string;
      file_name: string;
      current_version: { file_size: number | null; mime_type: string | null } | null;
    }[]).map((r) => ({
      taskId: r.entity_id,
      attachmentId: r.id,
      name: r.file_name,
      mime: r.current_version?.mime_type ?? null,
      size: r.current_version?.file_size ?? null,
    }));
  }

  /**
   * Reads up to MAX_FILES_PER_RUN files as the invoker, newest first as given. The run's budget is
   * shared fairly: what a short file does not need goes to the others, and a file over its share
   * keeps the parts closest to `request`.
   */
  async read(
    invoker: Pick<RequestUser, 'userId' | 'organizationId'>,
    files: AgentFileRef[],
    request = '',
    budget = MAX_RUN_FILE_CHARS,
  ): Promise<AgentFileRead[]> {
    const picked = files.slice(0, MAX_FILES_PER_RUN);
    const out: AgentFileRead[] = new Array(picked.length);
    for (let i = 0; i < picked.length; i += PARALLEL) {
      const batch = picked.slice(i, i + PARALLEL);
      const read = await Promise.all(batch.map((f) => this.readOne(invoker as RequestUser, f)));
      read.forEach((r, k) => (out[i + k] = r));
    }
    let left = budget;
    let waiting = out.filter((f) => f.text).length;
    const share = new Map<AgentFileRead, number>();
    for (const f of out.filter((x) => x.text).sort((a, b) => a.text.length - b.text.length)) {
      const room = Math.min(f.text.length, Math.floor(left / waiting));
      share.set(f, room);
      left -= room;
      waiting--;
    }
    const several = out.filter((f) => f.text).length > 1;
    return out.map((f) => {
      if (!f.text) return f;
      // Labels take some room: the selection leaves it.
      const room = share.get(f) ?? 0;
      const kept = selectRelevant(f.text, request, several && room < f.text.length ? Math.floor(room * 0.97) : room);
      const text = several ? labelled(kept.text, `${f.handle} ${f.name}`) : kept.text;
      return kept.truncated ? { ...f, ...kept, text } : { ...f, text };
    });
  }

  private async readOne(user: RequestUser, file: AgentFileRef): Promise<AgentFileRead> {
    const none = (unreadable: FileText['unreadable']): AgentFileRead => ({ ...file, text: '', truncated: false, unreadable });
    if (file.size !== null && file.size > MAX_FILE_BYTES) return none('too_large');

    let url: string;
    try {
      // The same check a download by this person makes: no access, no bytes.
      url = (await this.attachments.getDownloadInfo({ attachmentId: file.attachmentId, user })).signedUrl;
    } catch {
      return none('no_access');
    }

    try {
      const bytes = await this.download(url);
      if (!bytes) return none('too_large');
      return { ...file, ...(await extractText(bytes, file.name, file.mime)) };
    } catch (err) {
      this.logger.warn(`Robert could not read file ${file.attachmentId}: ${err instanceof Error ? err.name : 'error'}`);
      return none('broken');
    }
  }

  /** The file's bytes, or null past MAX_FILE_BYTES (the transfer stops there). */
  private async download(signedUrl: string): Promise<Uint8Array | null> {
    const url = storageUrl(signedUrl);
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'error' });
    if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return bytes;
  }
}
