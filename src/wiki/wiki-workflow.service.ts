/**
 * @fileoverview Wiki review/approval workflow (Wiki 2.0).
 *
 * State machine over `wiki_pages.workflow_status`:
 *   draft → in_review (submit_for_review) → published (approve) | draft (reject/withdraw)
 *   draft → published (publish; direct — allowed without approval flow)
 *   published → draft (unpublish)
 * `is_published`/`published_at` are kept in sync with the workflow status so
 * every legacy consumer of the boolean keeps working. Space-level behavior
 * (require_approval, default approvers) lives in `wiki_space_settings`.
 * @module src/wiki/wiki-workflow.service
 */

import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { NotificationEmailService } from '../notifications/notification-email.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import type { PermissionDecisionTrace } from './wiki-permissions.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type {
  WikiSpaceSettingsDto,
  WikiWorkflowTransitionDto,
} from './dto/wiki-workflow.dto';

/** Wiki workflow statuses (mirrors the DB CHECK constraint). */
export type WikiWorkflowStatus = 'draft' | 'in_review' | 'published';

/** Per-user workflow capabilities appended to page GET payloads. */
export interface WikiWorkflowCapabilities {
  can_submit: boolean;
  can_approve: boolean;
  can_publish_direct: boolean;
}

/** Resolved wiki_space_settings (with defaults when no row exists). */
export interface WikiSpaceSettings {
  space_id: string;
  require_approval: boolean;
  default_approver_ids: string[];
}

interface WorkflowPageRow {
  id: string;
  organization_id: string;
  space_id: string;
  title: string;
  created_by: string | null;
  is_archived: boolean | null;
  is_published: boolean | null;
  workflow_status: string | null;
  workflow_metadata: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

@Injectable()
export class WikiWorkflowService {
  private static readonly PAGES = 'wiki_pages';
  private static readonly SETTINGS = 'wiki_space_settings';
  private static readonly AUDIT_LOGS = 'audit_logs';
  private readonly logger = new Logger(WikiWorkflowService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly wikiPermissions: WikiPermissionsService,
    @Optional()
    private readonly notificationsBroadcast?: NotificationsBroadcastService,
    @Optional()
    private readonly notificationEmail?: NotificationEmailService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  /** Space workflow settings (defaults when no row exists). */
  async getSettings(
    spaceId: string,
    organizationId: string,
  ): Promise<WikiSpaceSettings> {
    const { data, error } = await this.client
      .from(WikiWorkflowService.SETTINGS)
      .select('space_id, require_approval, default_approver_ids')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);

    const row = data as {
      require_approval?: boolean;
      default_approver_ids?: string[] | null;
    } | null;

    return {
      space_id: spaceId,
      require_approval: row?.require_approval === true,
      default_approver_ids: row?.default_approver_ids ?? [],
    };
  }

  /** Upserts the space workflow settings (space admins only). */
  async setSettings(
    spaceId: string,
    user: RequestUser,
    dto: WikiSpaceSettingsDto,
  ): Promise<WikiSpaceSettings> {
    const ctx = await this.wikiPermissions.resolveUserContext(
      user.userId,
      spaceId,
    );

    if (!ctx.isSpaceAdmin) {
      throw new ForbiddenException(
        'Only a space admin can change wiki workflow settings',
      );
    }

    // Verify the space belongs to the caller's org before writing.
    const { data: space } = await this.client
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (!space) throw new NotFoundException('Space not found');

    const { error } = await this.client
      .from(WikiWorkflowService.SETTINGS)
      .upsert(
        {
          space_id: spaceId,
          organization_id: user.organizationId,
          require_approval: dto.require_approval,
          default_approver_ids: dto.default_approver_ids ?? [],
          updated_by: user.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'space_id' },
      );
    if (error) throw new BadRequestException(error.message);

    return this.getSettings(spaceId, user.organizationId);
  }

  // ── Capabilities ──────────────────────────────────────────────────────────

  /**
   * Per-user workflow capabilities for a page, computed from an existing
   * permission trace + settings (no extra queries — callers already hold the
   * trace from their access check).
   */
  computeCapabilities(
    userId: string,
    status: WikiWorkflowStatus,
    workflowMetadata: Record<string, unknown> | null,
    trace: PermissionDecisionTrace,
    settings: WikiSpaceSettings,
  ): WikiWorkflowCapabilities {
    const isAdmin = trace.source === 'admin';
    const canEdit = trace.decision.can_edit;
    const approverIds = Array.isArray(workflowMetadata?.['approver_ids'])
      ? (workflowMetadata['approver_ids'] as string[])
      : [];

    return {
      can_submit: status === 'draft' && canEdit,
      can_approve:
        status === 'in_review' && (isAdmin || approverIds.includes(userId)),
      can_publish_direct:
        status === 'draft' &&
        (isAdmin || (!settings.require_approval && canEdit)),
    };
  }

  /** Workflow state + capabilities + settings for a page (inspector payload). */
  async getWorkflowState(
    pageId: string,
    spaceId: string,
    user: RequestUser,
  ): Promise<Record<string, unknown>> {
    const page = await this.loadPage(pageId, spaceId, user.organizationId);
    const [trace, settings] = await Promise.all([
      this.wikiPermissions.resolveWithTrace(user.userId, pageId, spaceId),
      this.getSettings(spaceId, user.organizationId),
    ]);
    const status = this.currentStatus(page);

    return {
      status,
      workflow_metadata: page.workflow_metadata ?? {},
      settings,
      capabilities: this.computeCapabilities(
        user.userId,
        status,
        page.workflow_metadata,
        trace,
        settings,
      ),
    };
  }

  // ── Transitions ───────────────────────────────────────────────────────────

  /**
   * Executes a workflow transition. Every transition is audit-logged
   * ('workflow_transition') and notifies the counterpart (approvers on
   * submit; the requester on approve/reject) fire-and-forget.
   *
   * @returns The updated page row plus the caller's fresh capabilities.
   */
  async transition(
    pageId: string,
    spaceId: string,
    user: RequestUser,
    dto: WikiWorkflowTransitionDto,
  ): Promise<{ page: unknown; capabilities: WikiWorkflowCapabilities }> {
    const page = await this.loadPage(pageId, spaceId, user.organizationId);

    if (page.is_archived) {
      throw new BadRequestException(
        'Workflow transitions are not allowed on archived pages',
      );
    }

    const [trace, settings] = await Promise.all([
      this.wikiPermissions.resolveWithTrace(user.userId, pageId, spaceId),
      this.getSettings(spaceId, user.organizationId),
    ]);
    const isAdmin = trace.source === 'admin';
    const canEdit = trace.decision.can_edit;
    const isCreator = page.created_by === user.userId;
    const status = this.currentStatus(page);
    const meta = page.workflow_metadata ?? {};
    const approverIds = Array.isArray(meta['approver_ids'])
      ? (meta['approver_ids'] as string[])
      : [];
    const isApprover = isAdmin || approverIds.includes(user.userId);
    const nowIso = new Date().toISOString();

    const invalid = (): never => {
      throw new BadRequestException(
        `Cannot ${dto.action} a page in status '${status}'`,
      );
    };

    const update: Record<string, unknown> = {
      updated_by: user.userId,
      updated_at: nowIso,
    };
    let toStatus: WikiWorkflowStatus = status;
    let notify: {
      recipients: string[];
      type: 'wiki_review_requested' | 'wiki_review_decided';
      title: string;
      body: string | null;
      extraMetadata: Record<string, unknown>;
    } | null = null;

    switch (dto.action) {
      case 'submit_for_review': {
        if (status !== 'draft') invalid();
        if (!canEdit) {
          throw new ForbiddenException(
            'You need edit access to submit this page for review',
          );
        }

        const requested =
          dto.approverIds && dto.approverIds.length > 0
            ? dto.approverIds
            : settings.default_approver_ids;
        // Approvers must be SPACE members (not merely org members): an org
        // member outside this space can't approve, and storing them would leak
        // the page title into their review notification across spaces.
        const approvers = await this.filterSpaceMembers(requested, spaceId);

        if (settings.require_approval && approvers.length === 0) {
          throw new BadRequestException(
            'At least one approver is required to submit for review',
          );
        }

        toStatus = 'in_review';
        update['workflow_status'] = toStatus;
        update['workflow_metadata'] = {
          requested_by: user.userId,
          requested_at: nowIso,
          approver_ids: approvers,
          review_note: null,
        };
        notify = {
          recipients: approvers.filter((id) => id !== user.userId),
          type: 'wiki_review_requested',
          title: '', // filled after we resolve the actor name
          body: dto.note ?? null,
          extraMetadata: { requested_by: user.userId },
        };
        break;
      }

      case 'approve': {
        if (status !== 'in_review') invalid();
        if (!isApprover) {
          throw new ForbiddenException(
            'Only a designated approver or a space admin can approve',
          );
        }

        toStatus = 'published';
        update['workflow_status'] = toStatus;
        update['is_published'] = true;
        update['published_at'] = nowIso;
        update['workflow_metadata'] = {
          ...meta,
          reviewed_by: user.userId,
          reviewed_at: nowIso,
          review_note: dto.note ?? null,
        };
        // Publish cuts a distinct version.
        update['metadata'] = {
          ...(page.metadata ?? {}),
          _version_hint: randomUUID(),
        };

        const requestedBy = meta['requested_by'];

        notify = {
          recipients:
            typeof requestedBy === 'string' && requestedBy !== user.userId
              ? [requestedBy]
              : [],
          type: 'wiki_review_decided',
          title: '',
          body: dto.note ?? null,
          extraMetadata: { decision: 'approved', reviewed_by: user.userId },
        };
        break;
      }

      case 'reject': {
        if (status !== 'in_review') invalid();
        if (!isApprover) {
          throw new ForbiddenException(
            'Only a designated approver or a space admin can reject',
          );
        }
        if (!dto.note || !dto.note.trim()) {
          throw new BadRequestException('A note is required when rejecting');
        }

        toStatus = 'draft';
        update['workflow_status'] = toStatus;
        update['workflow_metadata'] = {
          ...meta,
          reviewed_by: user.userId,
          reviewed_at: nowIso,
          review_note: dto.note,
        };

        const requestedBy = meta['requested_by'];

        notify = {
          recipients:
            typeof requestedBy === 'string' && requestedBy !== user.userId
              ? [requestedBy]
              : [],
          type: 'wiki_review_decided',
          title: '',
          body: dto.note,
          extraMetadata: { decision: 'rejected', reviewed_by: user.userId },
        };
        break;
      }

      case 'withdraw': {
        if (status !== 'in_review') invalid();

        const requestedBy = meta['requested_by'];

        if (!isAdmin && requestedBy !== user.userId) {
          throw new ForbiddenException(
            'Only the requester or a space admin can withdraw a review',
          );
        }

        toStatus = 'draft';
        update['workflow_status'] = toStatus;
        update['workflow_metadata'] = {
          ...meta,
          withdrawn_by: user.userId,
          withdrawn_at: nowIso,
        };
        break;
      }

      case 'publish': {
        if (status !== 'draft') invalid();
        if (!isAdmin && (settings.require_approval || !canEdit)) {
          throw new ForbiddenException(
            settings.require_approval
              ? 'This space requires review before publishing'
              : 'You need edit access to publish this page',
          );
        }

        toStatus = 'published';
        update['workflow_status'] = toStatus;
        update['is_published'] = true;
        update['published_at'] = nowIso;
        update['metadata'] = {
          ...(page.metadata ?? {}),
          _version_hint: randomUUID(),
        };
        break;
      }

      case 'unpublish': {
        if (status !== 'published') invalid();
        if (!(canEdit && (isAdmin || isCreator))) {
          throw new ForbiddenException(
            'Only the page creator or a space admin can unpublish',
          );
        }

        toStatus = 'draft';
        update['workflow_status'] = toStatus;
        update['is_published'] = false;
        break;
      }

      default:
        invalid();
    }

    const upd = await this.client
      .from(WikiWorkflowService.PAGES)
      .update(update)
      .eq('id', pageId)
      .eq('space_id', spaceId)
      .select()
      .single();
    if (upd.error) throw new BadRequestException(upd.error.message);

    // Audit trail. Best-effort, but the insert MUST be awaited: a PostgREST
    // builder is a thenable that only issues its request from `then()`, so
    // `void builder` sends nothing at all.
    try {
      await this.client.from(WikiWorkflowService.AUDIT_LOGS).insert({
        organization_id: page.organization_id,
        user_id: user.userId,
        entity_type: 'wiki_page',
        entity_id: pageId,
        action: 'workflow_transition',
        changes: {
          from: status,
          to: toStatus,
          action: dto.action,
          note: dto.note ?? null,
        },
      });
    } catch {
      // Audit logging must not fail the transition.
    }

    if (notify && notify.recipients.length > 0) {
      void this.sendWorkflowNotifications(page, user, dto.action, notify).catch(
        (err) =>
          this.logger.warn(`workflow notification failed: ${String(err)}`),
      );
    }

    const updatedRow = upd.data as Record<string, unknown>;

    return {
      page: updatedRow,
      capabilities: this.computeCapabilities(
        user.userId,
        toStatus,
        (updatedRow['workflow_metadata'] as Record<string, unknown>) ?? null,
        trace,
        settings,
      ),
    };
  }

  /**
   * Legacy PATCH /:pageId/publish semantics mapped onto the workflow:
   * publish=true → 'publish' from draft (or 'approve' when a space admin
   * publishes an in-review page — the admin escape hatch); publish=false →
   * 'unpublish'. Idempotent when the page is already in the target state.
   */
  async legacyPublish(
    pageId: string,
    spaceId: string,
    publish: boolean,
    user: RequestUser,
  ): Promise<unknown> {
    const page = await this.loadPage(pageId, spaceId, user.organizationId);
    const status = this.currentStatus(page);

    if (publish) {
      if (status === 'published') {
        return this.reloadPage(pageId, spaceId);
      }

      if (status === 'in_review') {
        const result = await this.transition(pageId, spaceId, user, {
          action: 'approve',
        });

        return result.page;
      }

      const result = await this.transition(pageId, spaceId, user, {
        action: 'publish',
      });

      return result.page;
    }

    if (status !== 'published') {
      return this.reloadPage(pageId, spaceId);
    }

    const result = await this.transition(pageId, spaceId, user, {
      action: 'unpublish',
    });

    return result.page;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private currentStatus(page: WorkflowPageRow): WikiWorkflowStatus {
    const s = page.workflow_status;

    if (s === 'draft' || s === 'in_review' || s === 'published') return s;

    return page.is_published ? 'published' : 'draft';
  }

  private async loadPage(
    pageId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<WorkflowPageRow> {
    const { data, error } = await this.client
      .from(WikiWorkflowService.PAGES)
      .select(
        'id, organization_id, space_id, title, created_by, is_archived, is_published, workflow_status, workflow_metadata, metadata',
      )
      .eq('id', pageId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Wiki page not found');

    return data as WorkflowPageRow;
  }

  private async reloadPage(pageId: string, spaceId: string): Promise<unknown> {
    const { data, error } = (await this.client
      .from(WikiWorkflowService.PAGES)
      .select('*')
      .eq('id', pageId)
      .eq('space_id', spaceId)
      .single()) as { data: unknown; error: { message: string } | null };
    if (error) throw new BadRequestException(error.message);

    return data;
  }

  /** Keep only ids that are ACTIVE user members of the given space. */
  private async filterSpaceMembers(
    userIds: string[],
    spaceId: string,
  ): Promise<string[]> {
    if (userIds.length === 0) return [];

    const { data } = await this.client
      .from('space_members')
      .select('user_id')
      .eq('space_id', spaceId)
      .eq('member_type', 'user')
      .eq('is_active', true)
      .in('user_id', [...new Set(userIds)]);

    return ((data ?? []) as { user_id: string }[]).map((m) => m.user_id);
  }

  // Inserts workflow notifications mirroring the wiki mention-notification row
  // shape, then broadcasts + emails them fire-and-forget.
  private async sendWorkflowNotifications(
    page: WorkflowPageRow,
    actor: RequestUser,
    action: string,
    notify: {
      recipients: string[];
      type: 'wiki_review_requested' | 'wiki_review_decided';
      body: string | null;
      extraMetadata: Record<string, unknown>;
    },
  ): Promise<void> {
    const [{ data: actorRow }, { data: spaceRow }] = await Promise.all([
      this.client
        .from('users')
        .select('first_name, last_name')
        .eq('id', actor.userId)
        .maybeSingle(),
      this.client
        .from('spaces')
        .select('key')
        .eq('id', page.space_id)
        .maybeSingle(),
    ]);

    const actorName = actorRow
      ? `${(actorRow as { first_name?: string | null }).first_name ?? ''} ${(actorRow as { last_name?: string | null }).last_name ?? ''}`.trim() ||
        'Someone'
      : 'Someone';
    const spaceKey = (spaceRow as { key?: string } | null)?.key ?? null;

    const title =
      notify.type === 'wiki_review_requested'
        ? `${actorName} requested your review on "${page.title}"`
        : `${actorName} ${notify.extraMetadata['decision'] === 'approved' ? 'approved' : 'rejected'} "${page.title}"`;

    const { data: inserted, error } = await this.client
      .from('notifications')
      .insert(
        notify.recipients.map((userId) => ({
          organization_id: page.organization_id,
          user_id: userId,
          type: notify.type,
          title,
          body: notify.body,
          is_read: false,
          reference_type: 'wiki_page',
          reference_id: page.id,
          metadata: {
            entity_id: page.id,
            entity_name: page.title,
            action,
            actor_user_id: actor.userId,
            actor_name: actorName,
            ...(spaceKey && { space_key: spaceKey }),
            ...notify.extraMetadata,
          },
        })),
      )
      .select();

    if (error) {
      this.logger.warn(`workflow notification insert failed: ${error.message}`);

      return;
    }

    for (const notif of inserted ?? []) {
      void this.notificationsBroadcast?.broadcastNotification(
        notif as Record<string, unknown>,
      );
    }
    void this.notificationEmail?.emailForNotifications(
      (inserted ?? []) as Record<string, unknown>[],
    );
  }
}
