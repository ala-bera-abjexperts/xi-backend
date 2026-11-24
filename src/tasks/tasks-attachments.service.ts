/**
 * @fileoverview Service for task attachment file management.
 * Mirrors risk-management-app TaskAttachmentService exactly:
 * - Uploads to Supabase Storage bucket "task-attachments" via admin client
 * - Queries task_attachments table with joined uploader user
 * - Returns identical response shapes to the frontend
 * @module src/tasks/tasks-attachments.service
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import { UPLOAD_LIMITS, formatMaxUpload } from '../common/upload-limits';
import { WatchersService } from '../watchers/watchers.service';

const BUCKET = 'task-attachments';
const TABLE = 'task_attachments';
/**
 * Attachments carry NO type restriction — the size cap is the abuse control.
 *
 * This previously held a 30-entry allow-list that had to be widened twice, because it also gates
 * MIGRATION imports and every gap silently cost a customer their data: a Jira project attaching a
 * `.zip` of diagrams or a `.json` export hit `File type ... is not allowed`, and the attachments
 * stage failed the item rather than skipping it, so one ordinary file could fail a whole run.
 * Enumerating acceptable types was never going to converge; the list is gone.
 */
const MAX_FILE_SIZE = UPLOAD_LIMITS.ATTACHMENT;

export interface ITaskAttachment {
  id: string;
  task_id: string;
  organization_id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  uploaded_by: string | undefined;
  uploader?: {
    id: string;
    first_name?: string;
    last_name?: string;
    email: string;
    avatar_url?: string;
  };
  created_at: string;
}

const USER_JOIN = `
  *,
  uploader:users!task_attachments_uploaded_by_fkey(
    id,
    first_name,
    last_name,
    email,
    avatar_url
  )
`;

@Injectable()
export class TaskAttachmentsService {
  private readonly logger = new Logger(TaskAttachmentsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly outboxService?: AutomationEventOutboxService,
    @Optional() private readonly watchersService?: WatchersService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * GET /tasks/:id/attachments
   * Returns all attachments for a task, newest first.
   * Response shape: { data: ITaskAttachment[], count: number }
   */
  async getAttachments(
    taskId: string,
    organizationId: string,
  ): Promise<{ data: ITaskAttachment[]; count: number }> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(USER_JOIN)
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error('Failed to fetch task attachments:', error);
      throw new BadRequestException('Failed to fetch attachments');
    }

    const attachments = (data ?? []) as ITaskAttachment[];
    return { data: attachments, count: attachments.length };
  }

  /**
   * POST /tasks/:id/attachments
   * Validates file, uploads to Supabase Storage, inserts DB record.
   * Response shape: { data: ITaskAttachment, success: true } (201)
   */
  /**
   * @param userId - recorded as `uploaded_by`. A migration passes the ORIGINAL author (resolved
   *   through the user crosswalk) rather than whoever ran the import, so attribution survives.
   * @param opts.createdAt - replay the source's upload time instead of defaulting to now().
   *   Not reachable from the HTTP layer, so a client cannot forge an upload date.
   */
  async uploadAttachment(
    taskId: string,
    organizationId: string,
    userId: string,
    file: Express.Multer.File,
    opts: { createdAt?: string } = {},
  ): Promise<{ data: ITaskAttachment; success: true }> {
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(
        `File size exceeds the maximum allowed size of ${formatMaxUpload(MAX_FILE_SIZE)}`,
      );
    }

    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 10);
    const ext = file.originalname.includes('.')
      ? file.originalname.split('.').pop()
      : '';
    const filePath = ext
      ? `${organizationId}/tasks/${taskId}/${timestamp}-${randomString}.${ext}`
      : `${organizationId}/tasks/${taskId}/${timestamp}-${randomString}`;

    const { error: uploadError } = await this.client.storage
      .from(BUCKET)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      this.logger.error('Storage upload failed:', uploadError);
      throw new BadRequestException(
        `File upload failed: ${uploadError.message}`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error: insertError } = await this.client
      .from(TABLE)
      .insert({
        task_id: taskId,
        organization_id: organizationId,
        file_name: file.originalname,
        file_path: filePath,
        file_size: file.size,
        mime_type: file.mimetype,
        uploaded_by: userId,
        // Omitted unless replayed, so normal uploads keep the column default.
        ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
      })
      .select(USER_JOIN)
      .single();

    if (insertError || !data) {
      await this.client.storage.from(BUCKET).remove([filePath]);
      this.logger.error('DB insert failed after storage upload:', insertError);
      throw new BadRequestException('Failed to save attachment record');
    }

    void this.logTaskHistory(
      taskId,
      organizationId,
      userId,
      'attachment_added',
      null,
      null,
      {
        attachment_id: (data as { id?: string }).id,
        file_name: file.originalname,
        file_size: file.size,
        mime_type: file.mimetype,
      },
    );
    void this.logAudit(organizationId, userId, taskId, 'attachment_upload', {
      attachment_id: (data as { id?: string }).id,
      file_name: file.originalname,
    });

    // Emit automation event for attachment added
    void (async () => {
      const taskRes = await this.client
        .from('tasks')
        .select('key, summary, status, priority, assigned_to, space_id')
        .eq('id', taskId)
        .eq('organization_id', organizationId)
        .maybeSingle();
      const t = taskRes.data as {
        key?: string;
        summary?: string;
        status?: string;
        priority?: string;
        assigned_to?: string | null;
        space_id?: string;
      } | null;
      void this.outboxService?.write(
        organizationId,
        t?.space_id ?? null,
        'app.task.attachment_added',
        {
          task: {
            id: taskId,
            key: t?.key ?? '',
            summary: t?.summary ?? '',
            status: t?.status ?? '',
            priority: t?.priority ?? '',
            assigned_to: t?.assigned_to ?? null,
            space_id: t?.space_id ?? '',
            organization_id: organizationId,
          },
          task_id: taskId,
          attachment: {
            id: (data as { id?: string }).id ?? '',
            name: file.originalname,
            url: '',
            size: file.size,
            mime_type: file.mimetype,
          },
          space_id: t?.space_id ?? null,
        },
      );
      if (t) {
        void this.watchersService?.notifyTaskWatchers({
          organizationId,
          spaceId: t.space_id ?? null,
          taskId,
          actorUserId: userId,
          taskKey: t.key ?? '',
          title: t.summary ?? '',
          changeKind: 'attachment_added',
        });
      }
    })();

    return { data: data as ITaskAttachment, success: true };
  }

  /**
   * GET /tasks/:id/attachments/:attachmentId
   * Returns a signed download URL (1-hour expiry).
   * Response shape: { data: { url: string } }
   */
  async getDownloadUrl(
    taskId: string,
    attachmentId: string,
    organizationId: string,
  ): Promise<{ data: { url: string } }> {
    const attachment = await this.findByIdOrThrow(
      attachmentId,
      organizationId,
      taskId,
    );

    const { data: signed, error } = await this.client.storage
      .from(BUCKET)
      // `download`: serve with the ORIGINAL (possibly non-ASCII) name, not the sanitized key.
      .createSignedUrl(attachment.file_path, 3600, {
        download: attachment.file_name,
      });

    if (error || !signed?.signedUrl) {
      this.logger.error('Failed to generate signed URL:', error);
      throw new BadRequestException('Failed to generate download URL');
    }

    return { data: { url: signed.signedUrl } };
  }

  /**
   * DELETE /tasks/:id/attachments/:attachmentId
   * Deletes from storage then from DB.
   * Response shape: { success: true, message: 'Attachment deleted' }
   */
  async deleteAttachment(
    taskId: string,
    attachmentId: string,
    organizationId: string,
    userId?: string,
  ): Promise<{ success: true; message: string }> {
    const attachment = await this.findByIdOrThrow(
      attachmentId,
      organizationId,
      taskId,
    );

    const { error: storageError } = await this.client.storage
      .from(BUCKET)
      .remove([attachment.file_path]);

    if (storageError) {
      this.logger.error('Storage deletion failed:', storageError);
    }

    const { error: dbError } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', attachmentId)
      .eq('organization_id', organizationId);

    if (dbError) {
      this.logger.error('DB deletion failed:', dbError);
      throw new BadRequestException('Failed to delete attachment record');
    }

    if (userId) {
      void this.logTaskHistory(
        taskId,
        organizationId,
        userId,
        'attachment_deleted',
        null,
        {
          attachment_id: attachmentId,
          file_name: attachment.file_name,
          file_size: attachment.file_size,
        },
        null,
      );
      void this.logAudit(organizationId, userId, taskId, 'attachment_delete', {
        attachment_id: attachmentId,
        file_name: attachment.file_name,
        storage_error: storageError?.message,
      });
      void (async () => {
        const { data: task } = await this.client
          .from('tasks')
          .select('key, summary, space_id')
          .eq('id', taskId)
          .eq('organization_id', organizationId)
          .maybeSingle();
        if (task) {
          void this.watchersService?.notifyTaskWatchers({
            organizationId,
            spaceId: task.space_id as string | null,
            taskId,
            actorUserId: userId,
            taskKey: (task.key as string) ?? '',
            title: (task.summary as string) ?? '',
            changeKind: 'attachment_removed',
          });
        }
      })();
    }

    return { success: true, message: 'Attachment deleted' };
  }

  private async findByIdOrThrow(
    attachmentId: string,
    organizationId: string,
    taskId?: string,
  ): Promise<ITaskAttachment> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .select(USER_JOIN)
      .eq('id', attachmentId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error?.code === 'PGRST116' || !data) {
      throw new NotFoundException('Attachment not found');
    }

    if (error) {
      this.logger.error('Failed to fetch attachment:', error);
      throw new BadRequestException('Failed to fetch attachment');
    }

    const attachment = data as ITaskAttachment;
    if (taskId && attachment.task_id !== taskId) {
      throw new NotFoundException('Attachment not found');
    }

    return attachment;
  }

  private async logTaskHistory(
    taskId: string,
    organizationId: string,
    userId: string,
    action: string,
    fieldName?: string | null,
    oldValue?: unknown,
    newValue?: unknown,
  ): Promise<void> {
    try {
      await this.client.from('task_history').insert({
        task_id: taskId,
        organization_id: organizationId,
        action,
        field_name: fieldName ?? null,
        old_value: oldValue !== undefined ? oldValue : null,
        new_value: newValue !== undefined ? newValue : null,
        changed_by: userId,
      });
    } catch {
      // History logging must not fail attachment mutations.
    }
  }

  private async logAudit(
    organizationId: string,
    userId: string,
    taskId: string,
    actionType: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.client.from('audit_logs').insert({
        organization_id: organizationId,
        user_id: userId,
        entity_type: 'task',
        entity_id: taskId,
        action: 'update',
        changes: { action_type: actionType, ...changes },
      });
    } catch {
      // Audit logging is best-effort and must not fail attachment mutations.
    }
  }
}
