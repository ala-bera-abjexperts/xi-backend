import { browserSafeStorageUrl } from '../common/utils/browser-storage-url';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { normalizeContentType } from '../common/upload-mime';
import { storageSafeFileName } from '../common/upload-filename';
import { formatMaxUpload, UPLOAD_LIMITS } from '../common/upload-limits';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { WikiPermissionsService } from '../wiki/wiki-permissions.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { NotificationEmailService } from '../notifications/notification-email.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ChatAccessService } from '../chat/chat-access.service';
import { ChatRealtimeService } from '../chat/chat-realtime.service';
import {
  isTestManagementAttachmentType,
  TestManagementAttachmentAccessService,
} from '../test-management/access/test-management-attachment-access.service';
import type {
  AttachmentEntityType,
  SpaceAttachmentEntityType,
} from './dto/list-attachments-query.dto';

const ATTACHMENT_BUCKET = 'attachments';
const LEGACY_TASK_ATTACHMENT_BUCKET = 'task-attachments';
const SIGNED_URL_TTL_SECONDS = 60;
const MAX_VERSION_RETRY_ATTEMPTS = 3;

const USER_STUB_FIELDS = 'id, first_name, last_name, email, avatar_url';

const SELECT_ATTACHMENT_WITH_RELATIONS = `
  *,
  current_version:file_versions!file_attachments_current_version_fk(
    id, attachment_id, version_number, file_path, file_size, mime_type,
    uploaded_by, uploaded_at, comment,
    uploader:users!file_versions_uploaded_by_fkey(${USER_STUB_FIELDS})
  ),
  checked_out_by_user:users!file_attachments_checked_out_by_fkey(${USER_STUB_FIELDS}),
  created_by_user:users!file_attachments_created_by_fkey(${USER_STUB_FIELDS})
`;

const SELECT_VERSION_WITH_UPLOADER = `
  *,
  uploader:users!file_versions_uploaded_by_fkey(${USER_STUB_FIELDS})
`;

const ENTITY_TABLE_MAP: Record<
  SpaceAttachmentEntityType,
  { table: string; spaceCol: string; orgCol: string; ownerCol?: string }
> = {
  task: { table: 'tasks', spaceCol: 'space_id', orgCol: 'organization_id' },
  process: {
    table: 'business_processes',
    spaceCol: 'space_id',
    orgCol: 'organization_id',
  },
  wiki_page: {
    table: 'wiki_pages',
    spaceCol: 'space_id',
    orgCol: 'organization_id',
  },
  asset_item: {
    table: 'asset_items',
    spaceCol: 'space_id',
    orgCol: 'organization_id',
  },
  space_gdpr_record: {
    table: 'space_gdpr_records',
    spaceCol: 'spaceid',
    orgCol: 'organizationid',
  },
  support_request: {
    table: 'support_requests',
    spaceCol: 'space_id',
    orgCol: 'organization_id',
    ownerCol: 'created_by',
  },
  asset_object: {
    table: 'asset_objects',
    spaceCol: 'space_id',
    orgCol: 'organization_id',
  },
};

const ENTITY_PERMISSION_MAP: Record<
  SpaceAttachmentEntityType,
  { view: string; upload: string; delete: string }
> = {
  task: {
    view: 'view_tasks',
    upload: 'add_attachments_tasks',
    delete: 'delete_attachments_tasks',
  },
  process: {
    view: 'view_processes',
    upload: 'add_attachments_processes',
    delete: 'delete_attachments_processes',
  },
  wiki_page: {
    view: 'view_wiki_pages',
    upload: 'add_attachments_wiki',
    delete: 'delete_attachments_wiki',
  },
  asset_item: {
    view: 'view_lists',
    upload: 'add_attachments_lists',
    delete: 'delete_attachments_lists',
  },
  space_gdpr_record: {
    view: 'view_gdpr',
    upload: 'add_attachments_gdpr',
    delete: 'delete_attachments_gdpr',
  },
  support_request: {
    view: 'support_request_owner',
    upload: 'support_request_owner',
    delete: 'support_request_owner',
  },
  asset_object: {
    view: 'view_assets',
    upload: 'edit_assets',
    delete: 'edit_assets',
  },
};

// Test evidence is capped at 25 MB on every installation.
const TEST_EVIDENCE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Per-entity upload rules. Only SVG is type-gated here, and only because these files can be
 * rendered inline by the entity's viewer; every other type is accepted and bounded by size alone.
 * Named `ENTITY_` to keep it distinct from the shared `UPLOAD_LIMITS` tiers it draws from.
 */
const ENTITY_UPLOAD_LIMITS: Record<
  AttachmentEntityType,
  { maxBytes: number; allowSvg: boolean }
> = {
  task: { maxBytes: UPLOAD_LIMITS.ATTACHMENT, allowSvg: false },
  process: { maxBytes: UPLOAD_LIMITS.ATTACHMENT, allowSvg: false },
  wiki_page: { maxBytes: UPLOAD_LIMITS.ATTACHMENT, allowSvg: false },
  asset_item: { maxBytes: UPLOAD_LIMITS.ATTACHMENT, allowSvg: false },
  space_gdpr_record: { maxBytes: UPLOAD_LIMITS.ATTACHMENT, allowSvg: false },
  support_request: { maxBytes: UPLOAD_LIMITS.ATTACHMENT, allowSvg: false },
  asset_object: { maxBytes: UPLOAD_LIMITS.ATTACHMENT, allowSvg: false },
  chat_message: { maxBytes: UPLOAD_LIMITS.ATTACHMENT, allowSvg: false },
  test_case: { maxBytes: TEST_EVIDENCE_MAX_BYTES, allowSvg: false },
  test_run_attempt: { maxBytes: TEST_EVIDENCE_MAX_BYTES, allowSvg: false },
  test_execution: { maxBytes: TEST_EVIDENCE_MAX_BYTES, allowSvg: false },
  test_step: { maxBytes: TEST_EVIDENCE_MAX_BYTES, allowSvg: false },
};

export interface UserStub {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  avatar_url: string | null;
}

export interface FileVersion {
  id: string;
  attachment_id: string;
  version_number: number;
  file_path: string;
  file_size: number;
  mime_type: string;
  uploaded_by: string | null;
  uploaded_at: string;
  comment: string | null;
  uploader?: UserStub | null;
}

export interface FileAttachment {
  id: string;
  organization_id: string;
  space_id: string | null;
  entity_type: AttachmentEntityType;
  entity_id: string;
  file_name: string;
  current_version_id: string | null;
  checked_out_by: string | null;
  checked_out_at: string | null;
  checkout_note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  current_version?: FileVersion | null;
  checked_out_by_user?: UserStub | null;
  created_by_user?: UserStub | null;
}

export interface FileAttachmentWithVersions extends FileAttachment {
  versions: FileVersion[];
}

interface EntityContext {
  organizationId: string;
  spaceId: string | null;
  ownerId: string | null;
  /** chat_message only: the message's conversation, for the realtime signal. */
  conversationId?: string;
}

interface AttachmentMembershipContext {
  ctx: EntityContext;
  permissions: {
    isMember: boolean;
    spaceRole: string | null;
    globalRole: string | null;
    permissions: Record<string, boolean>;
  };
}

export interface AttachmentLockedPayload {
  error: string;
  code: 'ATTACHMENT_LOCKED';
  attachmentId: string;
  fileName: string;
  checkedOutBy: UserStub | null;
  checkedOutAt: string;
  note: string | null;
}

export class AttachmentLockedException extends ConflictException {
  constructor(public readonly payload: AttachmentLockedPayload) {
    super({
      message: payload.error,
      data: payload,
    });
  }
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissionsService: PermissionsService,
    private readonly auditLogsService: AuditLogsService,
    @Optional() private readonly outboxService?: AutomationEventOutboxService,
    @Optional()
    private readonly broadcastService?: NotificationsBroadcastService,
    @Optional()
    private readonly notificationEmail?: NotificationEmailService,
    /**
     * Appended LAST so the positional shape of every existing construction is unchanged.
     * Optional so the existing unit harnesses keep constructing this service with three deps —
     * but when it is absent the wiki branch FAILS CLOSED rather than silently falling back to the
     * space-only check, because a missing permission service must never widen access.
     */
    @Optional()
    private readonly wikiPermissions?: WikiPermissionsService,
    /** chat_message access; absent = chat attachments fail closed (403). */
    @Optional() private readonly chatAccess?: ChatAccessService,
    @Optional() private readonly chatRealtime?: ChatRealtimeService,
    /** Test Management evidence access; absent = those attachments fail closed (403). */
    @Optional()
    private readonly testManagementAccess?: TestManagementAttachmentAccessService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async listForEntity(args: {
    user: RequestUser;
    entityType: AttachmentEntityType;
    entityId: string;
  }): Promise<FileAttachment[]> {
    await this.verifyAndResolve({ ...args, action: 'view' });

    const { data, error } = await this.client
      .from('file_attachments')
      .select(SELECT_ATTACHMENT_WITH_RELATIONS)
      .eq('entity_type', args.entityType)
      .eq('entity_id', args.entityId)
      // An attachment with no current version has no bytes behind it: the row
      // was written, the upload then failed, and nothing rolled the row back.
      // Listing it produces an entry that renders as "0 B", downloads as a 404,
      // and reads to the user as data loss. Three of these are live in
      // production right now.
      //
      // The upload path now rolls the row back, so this should never match
      // again. It stays because a crash between the two writes is still
      // possible and this is the layer that decides what a user sees. Filtered
      // in SQL rather than in JS so it also holds for any future caller that
      // paginates.
      .not('current_version_id', 'is', null)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    return (data ?? []) as FileAttachment[];
  }

  async getWithVersions(
    attachmentId: string,
    user: RequestUser,
  ): Promise<FileAttachmentWithVersions> {
    const attachment = await this.findAttachmentById(attachmentId);

    await this.verifyAttachmentPermission(attachment, user, 'view');

    const versions = await this.findVersionsByAttachment(attachmentId);

    return { ...attachment, versions };
  }

  async upload(args: {
    user: RequestUser;
    entityType: AttachmentEntityType;
    entityId: string;
    file: Express.Multer.File;
    comment?: string | null;
  }): Promise<{
    attachment: FileAttachment;
    version: FileVersion;
    isNewVersion: boolean;
  }> {
    const { user, entityType, entityId, file, comment } = args;
    const ctx = await this.verifyAndResolve({
      user,
      entityType,
      entityId,
      action: 'upload',
    });
    const fileName = (file.originalname || '').trim();

    if (!fileName) throw new BadRequestException('File name is required');

    this.validateFile(file, entityType);

    let attachment = await this.findAttachmentByEntityAndName(
      entityType,
      entityId,
      fileName,
    );
    let isNewVersion = false;

    if (attachment) {
      if (
        attachment.checked_out_by &&
        attachment.checked_out_by !== user.userId
      ) {
        throw new AttachmentLockedException(
          this.buildLockedPayload(attachment),
        );
      }

      isNewVersion = true;
    } else {
      try {
        attachment = await this.createAttachment({
          organization_id: ctx.organizationId,
          space_id: ctx.spaceId,
          entity_type: entityType,
          entity_id: entityId,
          file_name: fileName,
          created_by: user.userId,
        });
      } catch (err) {
        if (!this.isUniqueConflict(err)) throw err;

        attachment = await this.findAttachmentByEntityAndName(
          entityType,
          entityId,
          fileName,
        );

        if (!attachment) throw err;

        if (
          attachment.checked_out_by &&
          attachment.checked_out_by !== user.userId
        ) {
          throw new AttachmentLockedException(
            this.buildLockedPayload(attachment),
          );
        }

        isNewVersion = true;
      }
    }

    // The header row above already exists at this point. If the upload now
    // fails, it has to go, or it survives as an attachment the UI renders at
    // "0 B" and that 404s on download forever. Three of those are sitting in
    // production right now because this rollback was missing.
    //
    // Only when THIS request created it. `isNewVersion` means the attachment
    // predates this upload and already has good versions, so deleting it would
    // destroy files that are perfectly fine.
    const createdHere = !isNewVersion;
    let version: FileVersion;

    try {
      ({ version } = await this.uploadVersionWithRetry({
        attachment,
        organizationId: ctx.organizationId,
        entityType,
        entityId,
        file,
        fileName,
        userId: user.userId,
        comment: comment ?? null,
      }));
    } catch (err) {
      if (createdHere) {
        // Best-effort: the upload error is what the user needs to see, so a
        // failure to clean up must not replace it with a confusing second one.
        // A leftover row here is the old behaviour, not a regression.
        try {
          await this.client
            .from('file_attachments')
            .delete()
            .eq('id', attachment.id)
            .is('current_version_id', null);
        } catch (cleanupErr) {
          this.logger.error(
            `Failed to roll back orphaned attachment ${attachment.id}: ${
              cleanupErr instanceof Error ? cleanupErr.message : cleanupErr
            }`,
          );
        }
      }

      throw err;
    }

    const update: Record<string, unknown> = {
      current_version_id: version.id,
      updated_at: new Date().toISOString(),
    };

    if (attachment.checked_out_by === user.userId) {
      update.checked_out_by = null;
      update.checked_out_at = null;
      update.checkout_note = null;
    }

    const { error: updateError } = await this.client
      .from('file_attachments')
      .update(update)
      .eq('id', attachment.id);

    if (updateError) throw new BadRequestException(updateError.message);

    const refreshed = await this.findAttachmentById(attachment.id);

    this.queueAttachmentAudit(
      ctx.organizationId,
      user.userId,
      refreshed.id,
      isNewVersion ? 'update' : 'create',
      {
        action: isNewVersion
          ? 'attachment_version_upload'
          : 'attachment_upload',
        entity_type: entityType,
        entity_id: entityId,
        file_name: fileName,
        version_number: version.version_number,
        file_size: file.size,
        mime_type: normalizeContentType(file.mimetype),
      },
    );
    this.queueTaskAttachmentHistory(
      ctx.organizationId,
      user.userId,
      entityType,
      entityId,
      'attachment_added',
      null,
      null,
      {
        attachment_id: refreshed.id,
        file_name: fileName,
        file_size: file.size,
        mime_type: normalizeContentType(file.mimetype),
      },
    );

    // Publish automation event when a task attachment is added (matches app.task.attachment_added trigger)
    if (entityType === 'task') {
      // Look the task up for its key/summary. This path only had the id, so a message built on this
      // trigger could name nothing but a UUID. Failure is non-fatal — the event still fires with the
      // ids, exactly as it did before.
      const { data: attachedTask } = await this.client
        .from('tasks')
        .select('key, summary')
        .eq('id', entityId)
        .maybeSingle();

      void this.outboxService?.write(
        ctx.organizationId,
        ctx.spaceId,
        'app.task.attachment_added',
        {
          task: {
            key: (attachedTask as { key?: string } | null)?.key ?? '',
            summary:
              (attachedTask as { summary?: string } | null)?.summary ?? '',
            id: entityId,
            space_id: ctx.spaceId,
            organization_id: ctx.organizationId,
          },
          task_id: entityId,
          space_id: ctx.spaceId,
          attachment: {
            id: refreshed.id,
            name: fileName,
            url: '',
            size: file.size,
            mime_type: normalizeContentType(file.mimetype),
          },
        },
      );
    }

    if (entityType === 'chat_message' && ctx.conversationId) {
      void this.chatRealtime?.messageUpdated(ctx.conversationId, entityId);
    }

    return { attachment: refreshed, version, isNewVersion };
  }

  /**
   * Write ONE historical version of an attachment at an EXPLICIT version number, as the migration
   * engine rather than as a signed-in user.
   *
   * Why this is not `upload()`:
   *  - `upload()` derives the next version as `max + 1`. Imported history has to keep the SOURCE's
   *    numbering, so v3 must land as v3 even when v1 and v2 arrive after it.
   *  - `upload()` authorizes against the caller's permissions. The migration worker has no request
   *    user; it runs service-role and attributes each version to the ORIGINAL author.
   *
   * Idempotent by `(attachment_id, version_number)`, which is a real unique constraint: a version
   * that already exists is ADOPTED and its bytes are never re-uploaded or replaced. That is what
   * makes a retry or a repair run safe to point at content it already imported.
   *
   * The storage key is the same deterministic formula `uploadVersionWithRetry` uses, so historical
   * and user-uploaded versions are indistinguishable to download, cleanup and space deletion.
   */
  async importVersion(args: {
    organizationId: string;
    spaceId: string | null;
    entityType: AttachmentEntityType;
    entityId: string;
    fileName: string;
    versionNumber: number;
    data: Buffer;
    mimeType: string | null;
    /**
     * Target user id of the ORIGINAL author, already resolved through the user crosswalk.
     * Callers resolve an unmapped author to the acting user, so this is never null.
     */
    uploadedBy: string;
    /** Source timestamp for this version; falls back to now() when the source omits it. */
    uploadedAt?: string | null;
    /** Source change message ("version comment"). */
    comment?: string | null;
    /** Who to record as having created the container row when it does not exist yet. */
    createdBy: string;
  }): Promise<{
    attachment: FileAttachment;
    version: FileVersion;
    adopted: boolean;
  }> {
    const fileName = (args.fileName || '').trim();

    if (!fileName) throw new BadRequestException('File name is required');

    if (!Number.isInteger(args.versionNumber) || args.versionNumber < 1) {
      throw new BadRequestException(
        `Invalid version number ${String(args.versionNumber)}`,
      );
    }

    // Same size AND content-type (SVG) rules a normal upload enforces via validateFile — a
    // historical binary must be refused for exactly the same reasons a current one would be.
    this.validateFile(
      {
        size: args.data.byteLength,
        mimetype: normalizeContentType(args.mimeType),
        originalname: fileName,
      },
      args.entityType,
    );

    let attachment = await this.findAttachmentByEntityAndName(
      args.entityType,
      args.entityId,
      fileName,
    );
    const createdHere = !attachment;

    attachment ??= await this.createAttachment({
      organization_id: args.organizationId,
      space_id: args.spaceId,
      entity_type: args.entityType,
      entity_id: args.entityId,
      file_name: fileName,
      created_by: args.createdBy,
    });

    const already = await this.findVersionByAttachmentAndNumber(
      attachment.id,
      args.versionNumber,
    );

    if (already) return { attachment, version: already, adopted: true };

    // Same formula as uploadVersionWithRetry — do not diverge, cleanup and download both parse it.
    const storagePath = `${args.organizationId}/${args.entityType}/${args.entityId}/${attachment.id}/v${args.versionNumber}/${storageSafeFileName(fileName)}`;

    const { error: uploadError } = await this.client.storage
      .from(ATTACHMENT_BUCKET)
      .upload(storagePath, args.data, {
        contentType: normalizeContentType(args.mimeType),
        upsert: false,
      });

    if (uploadError) {
      if (createdHere) await this.deleteAttachmentRow(attachment.id);

      throw new BadRequestException(
        `Storage upload failed: ${uploadError.message}`,
      );
    }

    let version: FileVersion;

    try {
      version = await this.createVersion({
        attachment_id: attachment.id,
        version_number: args.versionNumber,
        file_path: storagePath,
        file_size: args.data.byteLength,
        mime_type: normalizeContentType(args.mimeType),
        uploaded_by: args.uploadedBy,
        ...(args.uploadedAt ? { uploaded_at: args.uploadedAt } : {}),
        comment: args.comment ?? null,
      });
    } catch (err) {
      // Never strand bytes behind a row that failed to write.
      await this.client.storage.from(ATTACHMENT_BUCKET).remove([storagePath]);

      if (createdHere) await this.deleteAttachmentRow(attachment.id);

      throw err;
    }

    // The container points at the HIGHEST version, which is not necessarily this one: history can
    // arrive in any order, and a later import of v2 must not demote a v5 that is already current.
    const highest = await this.getMaxVersionNumber(attachment.id);

    if (args.versionNumber >= highest) {
      const { error } = await this.client
        .from('file_attachments')
        .update({
          current_version_id: version.id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', attachment.id);

      if (error) throw new BadRequestException(error.message);

      attachment = { ...attachment, current_version_id: version.id };
    }

    return { attachment, version, adopted: false };
  }

  private async deleteAttachmentRow(id: string): Promise<void> {
    await this.client.from('file_attachments').delete().eq('id', id);
  }

  async getDownloadInfo(args: {
    attachmentId: string;
    versionNumber?: number;
    inline?: boolean;
    user: RequestUser;
  }): Promise<{
    signedUrl: string;
    fileName: string;
    mimeType: string;
    versionNumber: number;
  }> {
    const attachment = await this.findAttachmentById(args.attachmentId);

    await this.verifyAttachmentPermission(attachment, args.user, 'view');

    let version: FileVersion | null = null;

    if (args.versionNumber) {
      version = await this.findVersionByAttachmentAndNumber(
        args.attachmentId,
        args.versionNumber,
      );
    } else if (attachment.current_version_id) {
      version = await this.findVersionById(attachment.current_version_id);
    }

    if (!version) throw new NotFoundException('Version not found');

    if (args.inline) {
      const mimeType = version.mime_type.split(';', 1)[0].trim().toLowerCase();
      if (!mimeType.startsWith('image/') || mimeType.startsWith('image/svg')) {
        throw new BadRequestException('Attachment cannot be rendered inline');
      }
    }

    const bucket = this.getStorageBucketForVersion(attachment, version);
    // `download` makes storage send Content-Disposition with the ORIGINAL name — the stored key is
    // ASCII-sanitized, so without this a German customer saves "Anderungsantrag_Produktion.zip"
    // and PDFs render inline instead of downloading. storage-js percent-encodes it (URLSearchParams).
    const storage = this.client.storage.from(bucket);
    const { data, error } = args.inline
      ? await storage.createSignedUrl(version.file_path, SIGNED_URL_TTL_SECONDS)
      : await storage.createSignedUrl(
          version.file_path,
          SIGNED_URL_TTL_SECONDS,
          { download: attachment.file_name },
        );

    if (error || !data?.signedUrl) {
      this.logger.error('Failed to generate attachment signed URL:', error);
      throw new BadRequestException('Failed to generate download URL');
    }

    return {
      signedUrl: browserSafeStorageUrl(data.signedUrl),
      fileName: attachment.file_name,
      mimeType: version.mime_type,
      versionNumber: version.version_number,
    };
  }

  async checkOut(args: {
    attachmentId: string;
    user: RequestUser;
    note?: string | null;
  }): Promise<FileAttachment> {
    const attachment = await this.findAttachmentById(args.attachmentId);
    await this.assertCheckoutSupported(attachment, args.user);
    const ctx = await this.verifyAttachmentPermission(
      attachment,
      args.user,
      'upload',
    );

    const { data, error } = (await this.client
      .from('file_attachments')
      .update({
        checked_out_by: args.user.userId,
        checked_out_at: new Date().toISOString(),
        checkout_note: args.note ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', args.attachmentId)
      .or(`checked_out_by.is.null,checked_out_by.eq.${args.user.userId}`)
      .select(SELECT_ATTACHMENT_WITH_RELATIONS)
      .maybeSingle()) as {
      data: FileAttachment | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    if (!data) {
      const current = await this.findAttachmentById(args.attachmentId);

      if (
        current.checked_out_by &&
        current.checked_out_by !== args.user.userId
      ) {
        throw new AttachmentLockedException(this.buildLockedPayload(current));
      }

      throw new BadRequestException('Failed to check out attachment');
    }

    this.queueAttachmentAudit(
      ctx.organizationId,
      args.user.userId,
      args.attachmentId,
      'update',
      {
        action: 'attachment_checkout',
        note: args.note ?? null,
      },
    );

    return data;
  }

  async checkIn(args: {
    attachmentId: string;
    user: RequestUser;
  }): Promise<FileAttachment> {
    const attachment = await this.findAttachmentById(args.attachmentId);
    await this.assertCheckoutSupported(attachment, args.user);
    const { ctx, permissions } = await this.verifyAttachmentMembership(
      attachment,
      args.user,
    );

    if (!attachment.checked_out_by) return attachment;

    const isOwner = attachment.checked_out_by === args.user.userId;
    const canOverride =
      !isOwner && this.isSpacePowerFromPermissions(permissions);

    if (!isOwner && !canOverride) {
      throw new AttachmentLockedException(this.buildLockedPayload(attachment));
    }

    const released = await this.tryCheckIn(
      args.attachmentId,
      isOwner ? args.user.userId : null,
    );

    if (!released) {
      return this.findAttachmentById(args.attachmentId);
    }

    if (canOverride && attachment.checked_out_by) {
      this.resolveAttachmentRoutingMeta(attachment)
        .then((routingMeta) =>
          this.createNotification({
            organizationId: attachment.organization_id,
            userId: attachment.checked_out_by!,
            title: 'Your check-out was released',
            body: `A space admin checked in "${attachment.file_name}".`,
            metadata: {
              attachment_id: attachment.id,
              file_name: attachment.file_name,
              released_by: args.user.userId,
              kind: 'force_checkin',
              ...routingMeta,
            },
          }),
        )
        .catch((err: unknown) => {
          this.logger.error('Failed to create attachment notification:', err);
        });
    }

    this.queueAttachmentAudit(
      ctx.organizationId,
      args.user.userId,
      args.attachmentId,
      'update',
      {
        action: canOverride ? 'attachment_force_checkin' : 'attachment_checkin',
        previous_checked_out_by: attachment.checked_out_by,
      },
    );

    return this.findAttachmentById(args.attachmentId);
  }

  async sendCheckoutMessage(args: {
    attachmentId: string;
    user: RequestUser;
    message: string;
  }): Promise<{ success: true }> {
    const attachment = await this.findAttachmentById(args.attachmentId);
    const ctx = await this.verifyAttachmentPermission(
      attachment,
      args.user,
      'view',
    );

    if (!attachment.checked_out_by) return { success: true };

    if (attachment.checked_out_by === args.user.userId) {
      throw new BadRequestException('You currently have this file checked out');
    }

    const routingMeta = await this.resolveAttachmentRoutingMeta(attachment);

    await this.createNotification({
      organizationId: attachment.organization_id,
      userId: attachment.checked_out_by,
      title: `Question about "${attachment.file_name}"`,
      body: args.message,
      metadata: {
        attachment_id: attachment.id,
        file_name: attachment.file_name,
        from_user_id: args.user.userId,
        kind: 'message',
        ...routingMeta,
      },
    });

    this.queueAttachmentAudit(
      ctx.organizationId,
      args.user.userId,
      args.attachmentId,
      'update',
      {
        action: 'attachment_checkout_message',
        recipient_user_id: attachment.checked_out_by,
      },
    );

    return { success: true };
  }

  async delete(args: {
    attachmentId: string;
    user: RequestUser;
  }): Promise<{ success: true }> {
    const attachment = await this.findAttachmentById(args.attachmentId);
    const ctx = await this.verifyAttachmentPermission(
      attachment,
      args.user,
      'delete',
    );

    if (
      attachment.checked_out_by &&
      attachment.checked_out_by !== args.user.userId
    ) {
      const canOverride =
        attachment.entity_type === 'support_request'
          ? this.isOrgPower(args.user, ctx)
          : await this.isSpacePower(
              args.user.userId,
              args.user.organizationId,
              ctx.spaceId,
            );

      if (!canOverride) {
        throw new AttachmentLockedException(
          this.buildLockedPayload(attachment),
        );
      }
    }

    const versions = await this.findVersionsByAttachment(args.attachmentId);
    const { error } = await this.client
      .from('file_attachments')
      .delete()
      .eq('id', args.attachmentId);

    if (error) throw new BadRequestException(error.message);

    if (versions.length > 0) {
      const pathsByBucket = this.groupVersionPathsByBucket(
        attachment,
        versions,
      );

      for (const [bucket, bucketPaths] of pathsByBucket.entries()) {
        await this.client.storage
          .from(bucket)
          .remove(bucketPaths)
          .then(({ error: storageError }) => {
            if (storageError) {
              this.logger.error(
                'Attachment storage cleanup failed:',
                storageError,
              );
            }
          })
          .catch((err: unknown) => {
            this.logger.error('Attachment storage cleanup failed:', err);
          });
      }

      const legacyTaskPaths =
        pathsByBucket.get(LEGACY_TASK_ATTACHMENT_BUCKET) ?? [];

      if (attachment.entity_type === 'task' && legacyTaskPaths.length > 0) {
        await this.client
          .from('task_attachments')
          .delete()
          .eq('organization_id', attachment.organization_id)
          .eq('task_id', attachment.entity_id)
          .in('file_path', legacyTaskPaths)
          .then(({ error: legacyDeleteError }) => {
            if (legacyDeleteError) {
              this.logger.error(
                'Legacy task attachment cleanup failed:',
                legacyDeleteError,
              );
            }
          });
      }
    }

    this.queueAttachmentAudit(
      ctx.organizationId,
      args.user.userId,
      args.attachmentId,
      'delete',
      {
        action: 'attachment_delete',
        entity_type: attachment.entity_type,
        entity_id: attachment.entity_id,
        file_name: attachment.file_name,
        version_count: versions.length,
      },
    );
    this.queueTaskAttachmentHistory(
      ctx.organizationId,
      args.user.userId,
      attachment.entity_type,
      attachment.entity_id,
      'attachment_deleted',
      null,
      {
        attachment_id: args.attachmentId,
        file_name: attachment.file_name,
        version_count: versions.length,
      },
      null,
    );

    if (attachment.entity_type === 'chat_message' && ctx.conversationId) {
      void this.chatRealtime?.messageUpdated(
        ctx.conversationId,
        attachment.entity_id,
      );
    }

    return { success: true };
  }

  /** Chat attachments have no check-out / check-in: readers get 403, others 404. */
  private async assertCheckoutSupported(
    attachment: FileAttachment,
    user: RequestUser,
  ): Promise<void> {
    if (isTestManagementAttachmentType(attachment.entity_type)) {
      await this.verifyAttachmentPermission(attachment, user, 'view');
      throw new ForbiddenException(
        'Check-out is not supported for test evidence',
      );
    }

    if (attachment.entity_type !== 'chat_message') return;

    await this.verifyAttachmentPermission(attachment, user, 'view');
    throw new ForbiddenException(
      'Check-out is not supported for chat attachments',
    );
  }

  private async verifyAndResolve(args: {
    user: RequestUser;
    entityType: AttachmentEntityType;
    entityId: string;
    action: 'view' | 'upload' | 'delete';
  }): Promise<EntityContext> {
    // Chat messages are not space rows: ChatAccessService owns their access rule.
    if (args.entityType === 'chat_message') {
      if (!this.chatAccess) {
        throw new ForbiddenException(
          'Chat permissions are unavailable; refusing attachment access',
        );
      }

      return this.chatAccess.resolveAttachmentAccess(
        args.user,
        args.entityId,
        args.action,
      );
    }

    // Test Management evidence follows the module's own permission and lifecycle rules.
    if (isTestManagementAttachmentType(args.entityType)) {
      if (!this.testManagementAccess) {
        throw new ForbiddenException(
          'Test Management permissions are unavailable; refusing attachment access',
        );
      }

      return this.testManagementAccess.resolveAttachmentAccess(
        args.user,
        args.entityType,
        args.entityId,
        args.action,
      );
    }

    const ctx = await this.resolveEntityContext(args.entityType, args.entityId);

    if (!ctx || ctx.organizationId !== args.user.organizationId) {
      throw new NotFoundException(`${args.entityType} not found`);
    }

    if (args.entityType === 'support_request') {
      if (ctx.ownerId === args.user.userId || this.isOrgPower(args.user, ctx)) {
        return ctx;
      }

      throw new ForbiddenException(
        `You do not have permission to ${args.action} attachments`,
      );
    }

    if (!ctx.spaceId) {
      throw new ForbiddenException('Entity is not associated with a space');
    }

    const permissions = await this.permissionsService.getUserSpacePermissions(
      args.user.userId,
      args.user.organizationId,
      ctx.spaceId,
    );
    const permissionKey = ENTITY_PERMISSION_MAP[args.entityType][args.action];

    if (
      !permissions.isMember ||
      permissions.permissions[permissionKey] !== true
    ) {
      throw new ForbiddenException(
        `You do not have permission to ${args.action} attachments`,
      );
    }

    // Wiki pages carry PER-PAGE restrictions on top of the space permission, and until now this
    // path only checked the space — so a member who cannot open a restricted page could still pull
    // its attachments, including every historical version, straight off the download route. The
    // wiki attachment LISTING already makes exactly this call (wiki.controller.ts), so this closes
    // the gap between listing a page's files and fetching their bytes.
    //
    // Scoped to `wiki_page` only: task, process, asset and support attachments are untouched.
    if (args.entityType === 'wiki_page') {
      if (!this.wikiPermissions) {
        throw new ForbiddenException(
          'Wiki page permissions are unavailable; refusing attachment access',
        );
      }

      await this.wikiPermissions.assertPageAccess(
        args.entityId,
        args.user.userId,
        ctx.spaceId,
        args.action === 'view' ? 'can_view' : 'can_edit',
      );
    }

    return ctx;
  }

  private async verifyAttachmentPermission(
    attachment: FileAttachment,
    user: RequestUser,
    action: 'view' | 'upload' | 'delete',
  ): Promise<EntityContext> {
    return this.verifyAndResolve({
      user,
      entityType: attachment.entity_type,
      entityId: attachment.entity_id,
      action,
    });
  }

  private async verifyAttachmentMembership(
    attachment: FileAttachment,
    user: RequestUser,
  ): Promise<AttachmentMembershipContext> {
    if (attachment.entity_type === 'chat_message') {
      // Resolve access first so an unreadable (or other-tenant) attachment answers 404, not 403.
      await this.verifyAttachmentPermission(attachment, user, 'view');
      throw new ForbiddenException(
        'Check-in is not supported for chat attachments',
      );
    }

    if (isTestManagementAttachmentType(attachment.entity_type)) {
      await this.verifyAttachmentPermission(attachment, user, 'view');
      throw new ForbiddenException(
        'Check-in is not supported for test evidence',
      );
    }

    const ctx = await this.resolveEntityContext(
      attachment.entity_type,
      attachment.entity_id,
    );

    if (!ctx || ctx.organizationId !== user.organizationId) {
      throw new NotFoundException('Attachment not found');
    }

    if (attachment.entity_type === 'support_request') {
      if (ctx.ownerId === user.userId || this.isOrgPower(user, ctx)) {
        return {
          ctx,
          permissions: {
            isMember: true,
            spaceRole: this.isOrgPower(user, ctx) ? 'admin' : 'member',
            globalRole: null,
            permissions: {},
          },
        };
      }

      throw new ForbiddenException(
        'You do not have permission to check in attachments',
      );
    }

    if (!ctx.spaceId) {
      throw new ForbiddenException('Entity is not associated with a space');
    }

    const permissions = await this.permissionsService.getUserSpacePermissions(
      user.userId,
      user.organizationId,
      ctx.spaceId,
    );

    if (!permissions.isMember) {
      throw new ForbiddenException(
        'You do not have permission to check in attachments',
      );
    }

    return { ctx, permissions };
  }

  private async resolveEntityContext(
    entityType: SpaceAttachmentEntityType,
    entityId: string,
  ): Promise<EntityContext | null> {
    const meta = ENTITY_TABLE_MAP[entityType];
    const ownerSelect = meta.ownerCol ? `, ${meta.ownerCol}` : '';
    const { data, error } = await this.client
      .from(meta.table)
      .select(`${meta.spaceCol}, ${meta.orgCol}${ownerSelect}`)
      .eq('id', entityId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) return null;

    const row = data as unknown as Record<string, string | null>;

    return {
      organizationId: row[meta.orgCol] as string,
      spaceId: row[meta.spaceCol] ?? null,
      ownerId: meta.ownerCol ? (row[meta.ownerCol] ?? null) : null,
    };
  }

  private async findAttachmentById(id: string): Promise<FileAttachment> {
    const { data, error } = (await this.client
      .from('file_attachments')
      .select(SELECT_ATTACHMENT_WITH_RELATIONS)
      .eq('id', id)
      .maybeSingle()) as {
      data: FileAttachment | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Attachment not found');

    return data;
  }

  private async findAttachmentByEntityAndName(
    entityType: AttachmentEntityType,
    entityId: string,
    fileName: string,
  ): Promise<FileAttachment | null> {
    const { data, error } = (await this.client
      .from('file_attachments')
      .select(SELECT_ATTACHMENT_WITH_RELATIONS)
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .eq('file_name', fileName)
      .maybeSingle()) as {
      data: FileAttachment | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    return data ?? null;
  }

  private async createAttachment(input: {
    organization_id: string;
    space_id: string | null;
    entity_type: AttachmentEntityType;
    entity_id: string;
    file_name: string;
    created_by: string;
  }): Promise<FileAttachment> {
    const { data, error } = (await this.client
      .from('file_attachments')
      .insert(input)
      .select(SELECT_ATTACHMENT_WITH_RELATIONS)
      .single()) as {
      data: FileAttachment;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    return data;
  }

  private async uploadVersionWithRetry(args: {
    attachment: FileAttachment;
    organizationId: string;
    entityType: AttachmentEntityType;
    entityId: string;
    file: Express.Multer.File;
    fileName: string;
    userId: string;
    comment: string | null;
  }): Promise<{ version: FileVersion; storagePath: string }> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < MAX_VERSION_RETRY_ATTEMPTS; attempt += 1) {
      const nextVersion =
        (await this.getMaxVersionNumber(args.attachment.id)) + 1;
      // Sanitised, NOT raw. `args.fileName` is whatever the user named the
      // file, and a Supabase Storage key must be ASCII, so interpolating it raw
      // is what made "Änderungsantrag Produktion.zip" fail to upload in
      // production. The original name is still stored verbatim on
      // `file_attachments.file_name`, which is what the user sees and downloads
      // as, so none of this is visible to them.
      const storagePath = `${args.organizationId}/${args.entityType}/${args.entityId}/${args.attachment.id}/v${nextVersion}/${storageSafeFileName(args.fileName)}`;

      const { error: uploadError } = await this.client.storage
        .from(ATTACHMENT_BUCKET)
        .upload(storagePath, args.file.buffer, {
          contentType: normalizeContentType(args.file.mimetype),
          upsert: false,
        });

      if (uploadError) {
        if (this.isUniqueConflict(uploadError)) {
          lastError = uploadError;
          continue;
        }

        throw new BadRequestException(
          `File upload failed: ${uploadError.message}`,
        );
      }

      try {
        const version = await this.createVersion({
          attachment_id: args.attachment.id,
          version_number: nextVersion,
          file_path: storagePath,
          file_size: args.file.size,
          mime_type: normalizeContentType(args.file.mimetype),
          uploaded_by: args.userId,
          comment: args.comment,
        });

        return { version, storagePath };
      } catch (err) {
        await this.client.storage
          .from(ATTACHMENT_BUCKET)
          .remove([storagePath])
          .catch(() => undefined);

        if (this.isUniqueConflict(err)) {
          lastError = err;
          continue;
        }

        throw err;
      }
    }

    if (lastError instanceof Error) throw lastError;
    throw new BadRequestException('Could not assign a version number');
  }

  private async createVersion(input: {
    attachment_id: string;
    version_number: number;
    file_path: string;
    file_size: number;
    mime_type: string;
    uploaded_by: string;
    comment: string | null;
    /** Only set by history import, which preserves the SOURCE's upload time; else DB default now(). */
    uploaded_at?: string;
  }): Promise<FileVersion> {
    const { data, error } = (await this.client
      .from('file_versions')
      .insert(input)
      .select(SELECT_VERSION_WITH_UPLOADER)
      .single()) as {
      data: FileVersion;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    return data;
  }

  private async findVersionById(id: string): Promise<FileVersion | null> {
    const { data, error } = (await this.client
      .from('file_versions')
      .select(SELECT_VERSION_WITH_UPLOADER)
      .eq('id', id)
      .maybeSingle()) as {
      data: FileVersion | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    return data ?? null;
  }

  private async findVersionByAttachmentAndNumber(
    attachmentId: string,
    versionNumber: number,
  ): Promise<FileVersion | null> {
    const { data, error } = (await this.client
      .from('file_versions')
      .select(SELECT_VERSION_WITH_UPLOADER)
      .eq('attachment_id', attachmentId)
      .eq('version_number', versionNumber)
      .maybeSingle()) as {
      data: FileVersion | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);

    return data ?? null;
  }

  private async findVersionsByAttachment(
    attachmentId: string,
  ): Promise<FileVersion[]> {
    const { data, error } = await this.client
      .from('file_versions')
      .select(SELECT_VERSION_WITH_UPLOADER)
      .eq('attachment_id', attachmentId)
      .order('version_number', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    return (data ?? []) as FileVersion[];
  }

  private async getMaxVersionNumber(attachmentId: string): Promise<number> {
    const { data, error } = await this.client
      .from('file_versions')
      .select('version_number')
      .eq('attachment_id', attachmentId)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    return (data as { version_number?: number } | null)?.version_number ?? 0;
  }

  private async tryCheckIn(
    attachmentId: string,
    expectedOwnerId: string | null,
  ): Promise<boolean> {
    let query = this.client
      .from('file_attachments')
      .update({
        checked_out_by: null,
        checked_out_at: null,
        checkout_note: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', attachmentId)
      .not('checked_out_by', 'is', null);

    if (expectedOwnerId !== null) {
      query = query.eq('checked_out_by', expectedOwnerId);
    }

    const { data, error } = await query.select('id').maybeSingle();

    if (error) throw new BadRequestException(error.message);

    return data !== null;
  }

  private async isSpacePower(
    userId: string,
    organizationId: string,
    spaceId: string | null,
  ): Promise<boolean> {
    if (!spaceId) return false;

    const permissions = await this.permissionsService.getUserSpacePermissions(
      userId,
      organizationId,
      spaceId,
    );

    return this.isSpacePowerFromPermissions(permissions);
  }

  private isSpacePowerFromPermissions(permissions: {
    spaceRole: string | null;
  }): boolean {
    return (
      permissions.spaceRole === 'owner' ||
      permissions.spaceRole === 'admin' ||
      permissions.spaceRole === 'space_admin'
    );
  }

  private isOrgPower(user: RequestUser, ctx: EntityContext): boolean {
    const membership = user.memberships?.find(
      (member) => member.organizationId === ctx.organizationId,
    );

    return membership?.role === 'owner' || membership?.role === 'admin';
  }

  private buildLockedPayload(
    attachment: FileAttachment,
  ): AttachmentLockedPayload {
    return {
      error: 'File is checked out',
      code: 'ATTACHMENT_LOCKED',
      attachmentId: attachment.id,
      fileName: attachment.file_name,
      checkedOutBy: attachment.checked_out_by_user || null,
      checkedOutAt: attachment.checked_out_at || new Date().toISOString(),
      note: attachment.checkout_note,
    };
  }

  private getStorageBucketForVersion(
    attachment: FileAttachment,
    version: FileVersion,
  ): string {
    if (
      attachment.entity_type === 'task' &&
      this.isLegacyTaskAttachmentPath(version.file_path, attachment)
    ) {
      return LEGACY_TASK_ATTACHMENT_BUCKET;
    }

    return ATTACHMENT_BUCKET;
  }

  private groupVersionPathsByBucket(
    attachment: FileAttachment,
    versions: FileVersion[],
  ): Map<string, string[]> {
    const pathsByBucket = new Map<string, string[]>();

    for (const version of versions) {
      const bucket = this.getStorageBucketForVersion(attachment, version);
      const paths = pathsByBucket.get(bucket) ?? [];

      paths.push(version.file_path);
      pathsByBucket.set(bucket, paths);
    }

    return pathsByBucket;
  }

  private isLegacyTaskAttachmentPath(
    filePath: string,
    attachment: FileAttachment,
  ): boolean {
    return filePath.startsWith(`${attachment.organization_id}/tasks/`);
  }

  /**
   * Structural, not `Express.Multer.File`: `importVersion` validates a downloaded Buffer, which
   * has no Multer wrapper, and duplicating this rule set there (as an earlier version of this file
   * did) is exactly how the SVG block silently stopped applying to historical binaries.
   */
  private validateFile(
    file: Pick<Express.Multer.File, 'size' | 'mimetype' | 'originalname'>,
    entityType: AttachmentEntityType,
  ): void {
    const limits = ENTITY_UPLOAD_LIMITS[entityType];

    if (file.size > limits.maxBytes) {
      throw new BadRequestException(
        `File exceeds ${formatMaxUpload(limits.maxBytes)} limit`,
      );
    }

    const lowerName = (file.originalname || '').toLowerCase();
    const isSvg =
      normalizeContentType(file.mimetype) === 'image/svg+xml' ||
      lowerName.endsWith('.svg');

    if (isSvg && !limits.allowSvg) {
      throw new BadRequestException(
        'SVG files are not allowed for this entity type',
      );
    }
  }

  private isUniqueConflict(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;

    const error = err as {
      code?: string;
      statusCode?: string | number;
      message?: string;
    };

    if (error.code === '23505') return true;

    const status =
      typeof error.statusCode === 'string'
        ? Number.parseInt(error.statusCode, 10)
        : error.statusCode;

    if (status === 409) return true;

    return (
      typeof error.message === 'string' &&
      /already exists|duplicate/i.test(error.message)
    );
  }

  private async resolveAttachmentRoutingMeta(
    attachment: FileAttachment,
  ): Promise<Record<string, unknown>> {
    const meta: Record<string, unknown> = {
      entity_type: attachment.entity_type,
      entity_id: attachment.entity_id,
      space_id: attachment.space_id ?? null,
    };

    if (attachment.space_id) {
      const { data: space, error: spaceErr } = await this.client
        .from('spaces')
        .select('key')
        .eq('id', attachment.space_id)
        .single();

      if (spaceErr) {
        this.logger.warn(
          `resolveAttachmentRoutingMeta: space lookup failed for ${attachment.space_id}: ${spaceErr.message}`,
        );
      }

      meta.space_key = (space as { key?: string } | null)?.key ?? null;
    }

    if (attachment.entity_type === 'task') {
      const { data: task, error: taskErr } = await this.client
        .from('tasks')
        .select('key')
        .eq('id', attachment.entity_id)
        .single();

      if (taskErr) {
        this.logger.warn(
          `resolveAttachmentRoutingMeta: task lookup failed for ${attachment.entity_id}: ${taskErr.message}`,
        );
      }

      meta.task_key = (task as { key?: string } | null)?.key ?? null;
    } else if (attachment.entity_type === 'asset_item') {
      const { data: item, error: itemErr } = await this.client
        .from('asset_items')
        .select('schema_id')
        .eq('id', attachment.entity_id)
        .single();

      if (itemErr) {
        this.logger.warn(
          `resolveAttachmentRoutingMeta: asset_item lookup failed for ${attachment.entity_id}: ${itemErr.message}`,
        );
      }

      const schemaId = (item as { schema_id?: string } | null)?.schema_id;

      if (schemaId) {
        const { data: schema, error: schemaErr } = await this.client
          .from('asset_schemas')
          .select('key')
          .eq('id', schemaId)
          .single();

        if (schemaErr) {
          this.logger.warn(
            `resolveAttachmentRoutingMeta: schema lookup failed for ${schemaId}: ${schemaErr.message}`,
          );
        }

        meta.schema_key = (schema as { key?: string } | null)?.key ?? null;
      }
    }

    return meta;
  }

  private async createNotification(args: {
    organizationId: string;
    userId: string;
    title: string;
    body: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    const row = {
      organization_id: args.organizationId,
      user_id: args.userId,
      type: 'attachment_checkout_message',
      title: args.title,
      body: args.body,
      is_read: false,
      action_status: 'pending',
      reference_type: 'file_attachment',
      reference_id: args.metadata['attachment_id'],
      metadata: args.metadata,
    };

    const { data: inserted, error } = (await this.client
      .from('notifications')
      .insert(row)
      .select()
      .maybeSingle()) as {
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    };

    if (error) {
      this.logger.error('Failed to create attachment notification:', error);

      return;
    }

    if (inserted) {
      void this.broadcastService?.broadcastNotification(inserted);
      void this.notificationEmail?.emailForNotifications([inserted]);
    }
  }

  private queueAttachmentAudit(
    organizationId: string,
    userId: string,
    attachmentId: string,
    action: 'create' | 'update' | 'delete',
    changes: Record<string, unknown>,
  ): void {
    this.logAttachmentAudit(
      organizationId,
      userId,
      attachmentId,
      action,
      changes,
    ).catch((err: unknown) => {
      this.logger.error('Attachment audit logging failed:', err);
    });
  }

  private queueTaskAttachmentHistory(
    organizationId: string,
    userId: string,
    entityType: AttachmentEntityType,
    entityId: string,
    action: 'attachment_added' | 'attachment_deleted',
    fieldName: string | null,
    oldValue?: unknown,
    newValue?: unknown,
  ): void {
    if (entityType !== 'task') return;

    this.logTaskHistory(
      entityId,
      organizationId,
      userId,
      action,
      fieldName,
      oldValue,
      newValue,
    ).catch((err: unknown) => {
      this.logger.error('Attachment task history logging failed:', err);
    });
  }

  private async logTaskHistory(
    taskId: string,
    organizationId: string,
    userId: string,
    action: 'attachment_added' | 'attachment_deleted',
    fieldName: string | null,
    oldValue?: unknown,
    newValue?: unknown,
  ): Promise<void> {
    await this.client.from('task_history').insert({
      task_id: taskId,
      organization_id: organizationId,
      action,
      field_name: fieldName,
      old_value: oldValue !== undefined ? oldValue : null,
      new_value: newValue !== undefined ? newValue : null,
      changed_by: userId,
    });
  }

  private async logAttachmentAudit(
    organizationId: string,
    userId: string,
    attachmentId: string,
    action: 'create' | 'update' | 'delete',
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.auditLogsService.logAction(
      organizationId,
      userId,
      'file_attachment',
      attachmentId,
      action,
      changes,
    );
  }
}
