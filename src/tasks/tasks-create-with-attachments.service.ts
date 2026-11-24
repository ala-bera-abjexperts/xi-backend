/**
 * @fileoverview Creates a task and its files in ONE request, so the task row is written exactly
 * once and only `app.task.created` leaves the outbox.
 * @module src/tasks/tasks-create-with-attachments.service
 * @author Prince Jadiya
 *
 * Uploading first and PATCHing the description afterwards cost an unconditional
 * `app.task.updated`, an SLA event, a watcher notification and two full description blobs in
 * `task_history` on every create. Nothing downstream can filter that by changed field, so the task
 * id is reserved here BEFORE any row is written: the files land against the reserved id, the
 * description is rewritten to point at them, and `TasksService.create` then inserts once.
 */

import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AttachmentsService } from '../attachments/attachments.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { uniqueFileName } from '../inbound-email/attachment-import';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { CreateTaskDto } from './dto/create-task.dto';
import type { CreateTaskWithAttachmentsDto } from './dto/create-task-with-attachments.dto';
import { TasksService, type Task } from './tasks.service';

/** Space-permission key gating file upload on a task, spelled as ENTITY_PERMISSION_MAP spells it. */
const UPLOAD_PERMISSION = 'add_attachments_tasks';

/** The bucket `importVersion` writes into; rollback has to reach the same objects. */
const ATTACHMENT_BUCKET = 'attachments';

/** One stored file, paired with the placeholder token the editor put in the description. */
interface ImportedFile {
  token?: string;
  attachmentId: string;
  fileName: string;
}

/** `&`, `<`, `>` only — the name is substituted into element text, never into an attribute. */
function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Repoint each `#pending-<token>` anchor at its stored file and relabel it with the final name.
 *
 * An anchor whose token has no matching upload is left exactly as it arrived — a partially
 * uploaded description must not lose the links that did not resolve.
 */
function rewritePendingLinks(
  description: string | undefined,
  imported: ImportedFile[],
): string | undefined {
  if (!description) return description;

  let html = description;

  for (const entry of imported) {
    if (!entry.token) continue;

    const pattern = new RegExp(
      `(<a\\b[^>]*\\bhref=)(["'])#pending-${escapeRegExp(entry.token)}\\2([^>]*>)[\\s\\S]*?(</a>)`,
      'gi',
    );

    html = html.replace(
      pattern,
      (
        _match: string,
        before: string,
        quote: string,
        after: string,
        close: string,
      ) =>
        `${before}${quote}/api/v1/attachments/${entry.attachmentId}/download${quote}${after}${escapeHtmlText(entry.fileName)}${close}`,
    );
  }

  return html;
}

@Injectable()
export class TasksCreateWithAttachmentsService {
  private readonly logger = new Logger(TasksCreateWithAttachmentsService.name);

  constructor(
    private readonly tasks: TasksService,
    private readonly attachments: AttachmentsService,
    private readonly permissionsService: PermissionsService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Store the uploaded files against a freshly reserved task id, rewrite the description to link
   * them, then create the task in a single insert.
   *
   * @param user the authenticated caller; the org is always taken from here, never from the body.
   * @param dto the JSON-encoded `CreateTaskDto` plus one placeholder token per file.
   * @param files the uploaded files, index-aligned with `dto.tokens`.
   * @returns the created task, exactly as `POST /tasks` returns it.
   * @throws BadRequestException when the payload is not valid JSON or fails `CreateTaskDto`.
   * @throws ForbiddenException when the caller may not upload files in the target space.
   */
  async createWithAttachments(
    user: RequestUser,
    dto: CreateTaskWithAttachmentsDto,
    files: Express.Multer.File[],
  ): Promise<Task> {
    const createDto = await this.parsePayload(dto.payload);
    const spaceId = await this.resolveSpaceId(user.organizationId, createDto);

    // Mandatory: importVersion performs NO tenancy or permission check of its own, so omitting
    // this would let any caller write files into a space they cannot touch.
    const resolved = await this.permissionsService.getUserSpacePermissions(
      user.userId,
      user.organizationId,
      spaceId,
    );

    if (
      !resolved.isMember ||
      resolved.permissions[UPLOAD_PERMISSION] !== true
    ) {
      throw new ForbiddenException(
        'You do not have permission to upload attachments',
      );
    }

    const taskId = randomUUID();
    const imported: ImportedFile[] = [];

    try {
      const taken = new Set<string>();

      // Sequential on purpose: one buffer is written at a time and the rename set stays correct.
      for (const [index, file] of files.entries()) {
        // Always version 1, and duplicates are renamed rather than stacked: importVersion ADOPTS
        // an existing (attachment, version) pair and silently discards the incoming bytes.
        const fileName = uniqueFileName(file.originalname, taken);
        const result = await this.attachments.importVersion({
          organizationId: user.organizationId,
          spaceId,
          entityType: 'task',
          entityId: taskId,
          fileName,
          versionNumber: 1,
          data: file.buffer,
          mimeType: file.mimetype,
          uploadedBy: user.userId,
          createdBy: user.userId,
          comment: null,
        });

        taken.add(fileName.toLowerCase());
        imported.push({
          token: dto.tokens?.[index],
          attachmentId: result.attachment.id,
          fileName,
        });
      }

      createDto.description = rewritePendingLinks(
        createDto.description,
        imported,
      );

      return await this.tasks.create(
        user.organizationId,
        user.userId,
        createDto,
        { taskId },
      );
    } catch (err) {
      await this.rollback(imported);

      throw err;
    }
  }

  /**
   * Run the validation the global pipe would have run, now that the payload is out of its string.
   */
  private async parsePayload(payload: string): Promise<CreateTaskDto> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new BadRequestException('payload must be valid JSON');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BadRequestException('payload must be a JSON object');
    }

    const instance = plainToInstance(CreateTaskDto, parsed);
    const errors = await validate(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    if (errors.length > 0) {
      throw new BadRequestException(
        errors.flatMap((error) => Object.values(error.constraints ?? {})),
      );
    }

    return instance;
  }

  /**
   * Resolve only where the FILES belong. Every other space rule (process/space agreement, parent
   * task in the same space) still runs inside `TasksService.create`.
   */
  private async resolveSpaceId(
    organizationId: string,
    dto: CreateTaskDto,
  ): Promise<string> {
    let spaceId = dto.space_id ?? dto.spaceId;

    if (!spaceId && dto.process_id) {
      const { data, error } = await this.client
        .from('business_processes')
        .select('space_id')
        .eq('id', dto.process_id)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (error) throw new BadRequestException(error.message);

      spaceId =
        (data as { space_id?: string | null } | null)?.space_id ?? undefined;
    }

    if (!spaceId) {
      throw new BadRequestException(
        'space_id is required (either from process or explicitly provided)',
      );
    }

    return spaceId;
  }

  /**
   * Drop files written for a task that never landed.
   *
   * `AttachmentsService.delete()` cannot be used here: it resolves the task row first and would
   * throw "task not found" for an id that was never inserted, and it also demands
   * `delete_attachments_tasks`, which an uploader need not hold. Cleanup failures are logged so
   * the caller still sees the original error.
   */
  private async rollback(imported: ImportedFile[]): Promise<void> {
    if (imported.length === 0) return;

    const ids = imported.map((entry) => entry.attachmentId);

    try {
      const { data, error } = await this.client
        .from('file_versions')
        .select('file_path')
        .in('attachment_id', ids);

      if (error) throw new Error(error.message);

      const paths = ((data ?? []) as { file_path: string | null }[])
        .map((row) => row.file_path)
        .filter((path): path is string => !!path);

      if (paths.length > 0) {
        await this.client.storage.from(ATTACHMENT_BUCKET).remove(paths);
      }

      await this.client.from('file_attachments').delete().in('id', ids);
    } catch (err) {
      this.logger.error(
        `Attachment cleanup failed after task create failed (${ids.join(', ')}):`,
        err,
      );
    }
  }
}
