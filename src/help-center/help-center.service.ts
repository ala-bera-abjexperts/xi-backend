/**
 * @fileoverview Business logic for Help Center — support request lifecycle.
 * Portal customers are ordinary XISUITE users who may not be members of the
 * org that owns the ticket, so every share-aware method here routes through
 * `HelpCenterRepository.findVisible` (creator-or-shared, 404 otherwise) rather
 * than a membership check.
 * @module src/help-center/help-center.service
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HelpCenterRepository } from './help-center.repository';
import type {
  IEnrichedSupportRequest,
  IEnrichedSupportRequestUser,
  ISupportRequest,
  SupportRequestViewerRole,
} from './help-center.repository';
import type { CreateSupportRequestDto } from './dto/create-support-request.dto';
import type { ListSupportRequestsQueryDto } from './dto/list-support-requests-query.dto';
import { SlaAccessService } from '../sla/sla-access.service';
import { SlaRepliesService } from '../sla/sla-replies.service';
import { SlaFormRequestsService } from '../sla/sla-form-requests.service';
import { WorkflowEngineService } from '../workflow-engine/workflow-engine.service';
import { randomUUID } from 'crypto';
import { RequestUser } from '../auth/interfaces/request-user.interface';
import { TasksService } from '../tasks/tasks.service';
import { EntitlementsService } from '../licensing/entitlements.service';
import {
  FieldValidationError,
  validateFieldValue,
} from '../custom-fields/utils/custom-field-validation';
import {
  resolvePriorityIdFromLadder,
  toSupportRequestPriorityBucket,
} from './priority.util';

const PUBLIC_SUPPORT_FIELD_TYPES = new Set([
  'string',
  'number',
  'editor',
  'select',
  'multiselect',
  'checkbox',
  'radio',
  'date',
  'time',
  'datetime',
  'url',
]);

export type ActivityItem =
  | { id: string; kind: 'reply'; at: string; content: string }
  | {
      id: string;
      kind: 'comment';
      at: string;
      content: string;
      author: { id: string; name: string };
    }
  | {
      id: string;
      kind: 'status';
      at: string;
      status: { name: string; color: string | null };
    };

/** The stored published block a customer transition is bound to (contract §7). */
export interface TransitionElementRef {
  funnelId: string;
  pageId: string;
  elementId: string;
}

export interface CustomerTransition {
  id: string;
  name: string;
  to_status: { id: string; name: string; color: string | null };
}

export interface ShareRow {
  user_id: string;
  name: string;
  role: SupportRequestViewerRole;
  is_viewer: boolean;
}

@Injectable()
export class HelpCenterService {
  private readonly logger = new Logger(HelpCenterService.name);

  constructor(
    private readonly repo: HelpCenterRepository,
    private readonly tasksService: TasksService,
    private readonly entitlements: EntitlementsService,
    private readonly access: SlaAccessService,
    private readonly slaReplies: SlaRepliesService,
    private readonly workflowEngine: WorkflowEngineService,
    private readonly formRequests: SlaFormRequestsService,
  ) {}

  private formatUserName(
    user: IEnrichedSupportRequestUser | null | undefined,
  ): string {
    if (!user) return 'Unknown';
    return (
      [user.first_name, user.last_name].filter(Boolean).join(' ').trim() ||
      'Unknown'
    );
  }

  /**
   * Resolve the configurable priority for a write, then collapse it to the legacy bucket
   * `support_requests.priority` requires.
   *
   * `priority_id` (org/space-configurable) wins when supplied; otherwise a legacy key is
   * accepted as-is and bucketed. An unknown id is a 400 rather than a silent 'medium'.
   */
  private async resolvePriorityForWrite(
    organizationId: string,
    spaceId: string | null,
    priority: string | undefined,
    priorityId: string | undefined,
  ): Promise<{ id: string | null; bucket: string }> {
    if (!priorityId) {
      return {
        id: null,
        bucket: toSupportRequestPriorityBucket(priority ?? 'medium'),
      };
    }

    const ladder = await this.repo.loadPriorityLadder(organizationId, spaceId);
    const resolved = resolvePriorityIdFromLadder(ladder, priorityId);

    if (!resolved) {
      throw new BadRequestException('Invalid priority_id');
    }

    return { id: priorityId, bucket: resolved.bucket };
  }

  /**
   * Create a support request on behalf of the authenticated user.
   *
   * @param organizationId - Active tenant resolved from the JWT / tenant header.
   * @param userId - Public user ID of the caller.
   * @param dto - Validated request body.
   */
  async createSupportRequest(
    organizationId: string,
    userId: string,
    dto: CreateSupportRequestDto,
  ): Promise<ISupportRequest> {
    // When a spaceId is provided (e.g. from a published form), the ticket must be
    // created in the space's owning org — not the submitter's org. This handles the
    // cross-tenant published-form scenario: form belongs to org A, submitter is from
    // org B; ticket and linked task must both land in org A.
    let effectiveOrgId = organizationId;
    if (dto.spaceId) {
      const spaceOrgId = await this.repo.findSpaceOrganization(dto.spaceId);
      if (!spaceOrgId) {
        throw new BadRequestException(
          'The specified space does not exist or has been deleted.',
        );
      }
      effectiveOrgId = spaceOrgId;
    }

    if (!effectiveOrgId) {
      throw new BadRequestException(
        'Organization context could not be resolved. Ensure you are a member of an organization.',
      );
    }

    const customFieldValues = await this.validateCustomFieldValues(
      effectiveOrgId,
      dto.spaceId,
      dto.custom_field_values,
    );

    // Resolve the configurable priority (when supplied) against the org/space ladder, then
    // derive the legacy bucket the CHECK-constrained column requires. `priority_id` is the
    // source of truth; `priority` is kept in sync for older read paths.
    const resolved = await this.resolvePriorityForWrite(
      effectiveOrgId,
      dto.spaceId ?? null,
      dto.priority,
      dto.priority_id,
    );

    const supportRequest = await this.repo.create(effectiveOrgId, userId, {
      ...dto,
      priority: resolved.bucket,
      priority_id: resolved.id ?? undefined,
      custom_field_values: customFieldValues,
    });

    if (dto.spaceId) {
      try {
        return await this.createTaskForRequest(supportRequest);
      } catch (err) {
        this.logger.error(
          `Failed to create linked task for support request ${supportRequest.id}: ${(err as Error).message}`,
        );
      }
    }

    return supportRequest;
  }

  async retryTask(id: string, user: RequestUser) {
    const request = await this.repo.findForStaff(id);
    if (!request.space_id)
      throw new BadRequestException('Request has no configured space');
    await this.access.authorizeSpace(
      user,
      request.organization_id,
      request.space_id,
      'publish_customer_replies',
    );
    await this.access.authorizeSpace(
      user,
      request.organization_id,
      request.space_id,
      'create_tasks',
    );
    return this.createTaskForRequest(request);
  }

  private async createTaskForRequest(
    request: ISupportRequest,
  ): Promise<ISupportRequest> {
    if (request.task_id) return request;
    const taskId = await this.repo.reserveTask(request);
    await this.tasksService.create(
      request.organization_id,
      request.created_by,
      {
        summary: request.subject,
        task_type_id: 'task',
        space_id: request.space_id!,
        description: request.description,
        // Carry the configurable priority through so the task lands on the SAME priority the
        // customer picked; `request.priority` alone is only the coarse bucket (Highest →
        // Critical). Exactly ONE of the two is sent: `resolveTaskPriorityForWrite` rejects a
        // `priority_id` paired with a `priority` that is not that row's real key, and the
        // bucket is not the key.
        ...(request.priority_id
          ? { priority_id: request.priority_id }
          : { priority: request.priority }),
        custom_field_values: request.custom_field_values,
      },
      { supportRequestId: request.id, taskId },
    );
    return this.repo.linkTask(request, taskId);
  }

  private async validateCustomFieldValues(
    organizationId: string,
    spaceId: string | undefined,
    values: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown>> {
    const entries = Object.entries(values ?? {}).filter(
      ([, value]) => value !== undefined && value !== null && value !== '',
    );

    if (entries.length === 0) return {};

    if (!spaceId) {
      throw new BadRequestException(
        'Custom field values require a configured space.',
      );
    }

    if (entries.length > 30) {
      throw new BadRequestException(
        'A support request can submit at most 30 custom fields.',
      );
    }

    const fieldKeys = entries.map(([key]) => key);

    if (fieldKeys.some((key) => !/^[a-z][a-z0-9_]{0,99}$/.test(key))) {
      throw new BadRequestException('Custom field keys are invalid.');
    }

    const fields = await this.repo.findActiveTaskCustomFields(
      organizationId,
      spaceId,
      fieldKeys,
    );
    const fieldMap = new Map(fields.map((field) => [field.field_key, field]));
    const invalidKeys = fieldKeys.filter((key) => {
      const field = fieldMap.get(key);

      return !field || !PUBLIC_SUPPORT_FIELD_TYPES.has(field.field_type);
    });

    if (invalidKeys.length > 0) {
      throw new BadRequestException(
        `Unsupported or unknown custom fields: ${invalidKeys.join(', ')}`,
      );
    }

    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of entries) {
      const field = fieldMap.get(key)!;

      try {
        validateFieldValue(field, value);
      } catch (err) {
        if (err instanceof FieldValidationError) {
          throw new BadRequestException(err.message);
        }

        throw err;
      }

      sanitized[key] = value;
    }

    return sanitized;
  }

  /**
   * List support requests visible to the caller under the requested scope
   * (mine / shared / all), enriched with task/requester/space (contract §1).
   *
   * @returns Paginated result with `data`, `count`, `page`, and `limit`.
   */
  async listMyRequests(
    userId: string,
    query: ListSupportRequestsQueryDto,
  ): Promise<{
    data: IEnrichedSupportRequest[];
    count: number;
    page: number;
    limit: number;
  }> {
    const { data, count } = await this.repo.findByUser(userId, query);

    return {
      data,
      count,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    };
  }

  /**
   * Fetch a single enriched support request plus the caller's viewer role.
   * Throws 404 if the ticket is not visible to the caller (contract §2).
   *
   * @param id - UUID of the support request.
   * @param userId - Caller's public user ID.
   */
  async getRequest(
    id: string,
    userId: string,
  ): Promise<
    IEnrichedSupportRequest & { viewer_role: SupportRequestViewerRole }
  > {
    const { request, viewer_role } = await this.repo.findVisible(id, userId);
    return { ...request, viewer_role };
  }

  /**
   * Staff replies published against this request (contract §3). Share-aware:
   * visibility is checked here, then the existing SlaRepliesService is called
   * with the request's OWN creator id — which always passes its internal
   * `created_by = userId` check — so a shared viewer still sees the replies
   * without editing `src/sla/*`.
   */
  async getReplies(id: string, userId: string) {
    const { request } = await this.repo.findVisible(id, userId);
    return this.slaReplies.requesterReplies(id, request.created_by);
  }

  /**
   * Combined reply / comment / status-change timeline, oldest first (contract §4).
   */
  async getActivity(id: string, userId: string): Promise<ActivityItem[]> {
    const { request } = await this.repo.findVisible(id, userId);

    const [replies, comments] = await Promise.all([
      this.slaReplies.requesterReplies(id, request.created_by) as Promise<
        Array<{ id: string; content: string; published_at: string }>
      >,
      this.repo.listPortalComments(id),
    ]);

    const items: ActivityItem[] = [
      ...replies.map(
        (r): ActivityItem => ({
          id: r.id,
          kind: 'reply',
          at: r.published_at,
          content: r.content,
        }),
      ),
      ...comments.map(
        (c): ActivityItem => ({
          id: c.id,
          kind: 'comment',
          at: c.created_at,
          content: c.content,
          author: {
            id: c.author?.id ?? '',
            name: this.formatUserName(c.author),
          },
        }),
      ),
    ];

    if (request.task_id) {
      const [statusRows, transitionAudits] = await Promise.all([
        this.repo.listStatusHistory(request.task_id),
        this.repo.listTransitionAudits(request.task_id),
      ]);

      if (statusRows.length > 0) {
        const statuses = await this.repo.listTaskStatuses(
          request.organization_id,
          request.task?.space_id ?? null,
        );

        // `task_history.new_value` is the legacy status BUCKET (six-value CHECK), not the
        // status key — `obsolete` and `done` share the bucket `done`. When a status change
        // was driven by the workflow engine, the exact destination survives as a
        // `to_status_id` in its audit row; match the two by timestamp so the feed can show
        // the real status. Changes made outside the engine keep the bucket mapping.
        const auditByTime = transitionAudits.map((a) => ({
          at: new Date(a.changed_at).getTime(),
          statusId: a.to_status_id,
        }));

        for (const row of statusRows) {
          const rowTime = new Date(row.changed_at).getTime();
          // Multiple audits inside the window means the pairing is not certain — fall back.
          const nearby = auditByTime.filter(
            (a) => Math.abs(a.at - rowTime) <= 5000,
          );
          const exact = nearby.length === 1 ? nearby[0].statusId : null;
          const exactMatch = exact
            ? statuses.find((s) => s.id === exact)
            : undefined;

          if (exactMatch) {
            items.push({
              id: row.id,
              kind: 'status',
              at: row.changed_at,
              status: { name: exactMatch.name, color: exactMatch.color },
            });
            continue;
          }

          const raw = typeof row.new_value === 'string' ? row.new_value : '';
          const match =
            statuses.find((s) => s.key.toLowerCase() === raw.toLowerCase()) ??
            statuses.find((s) => s.name.toLowerCase() === raw.toLowerCase());

          items.push({
            id: row.id,
            kind: 'status',
            at: row.changed_at,
            status: match
              ? { name: match.name, color: match.color }
              : { name: raw, color: null },
          });
        }
      }
    }

    items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    return items;
  }

  /**
   * Add a customer-portal comment (contract §5). 409 if the request has no
   * linked task yet — there is nothing to attach the comment to.
   */
  async addComment(
    id: string,
    userId: string,
    content: string,
  ): Promise<{
    id: string;
    at: string;
    content: string;
    author: { id: string; name: string };
  }> {
    const { request } = await this.repo.findVisible(id, userId);
    if (!request.task_id) {
      throw new ConflictException('This request is not linked to a task yet');
    }

    const [created, author] = await Promise.all([
      this.tasksService.createComment(
        request.task_id,
        request.organization_id,
        userId,
        content,
        { support_request_id: id },
      ),
      this.repo.findUserName(userId),
    ]);

    const row = created as { id: string; content: string; created_at: string };

    return {
      id: row.id,
      at: row.created_at,
      content: row.content,
      author: { id: userId, name: this.formatUserName(author) },
    };
  }

  /**
   * Shared users plus the creator, creator first. Never includes email (contract §6).
   * `is_viewer` marks the caller's own entry — the frontend cannot derive it because
   * the JWT `sub` is the auth user id, not the `public.users.id` share rows carry.
   */
  async listShares(id: string, userId: string): Promise<ShareRow[]> {
    const { request } = await this.repo.findVisible(id, userId);
    const shares = await this.repo.listShares(id);

    return [
      {
        user_id: request.created_by,
        name: this.formatUserName(request.requester),
        role: 'creator',
        is_viewer: request.created_by === userId,
      },
      ...shares.map(
        (s): ShareRow => ({
          user_id: s.user_id,
          name: this.formatUserName(s.user),
          role: 'shared',
          is_viewer: s.user_id === userId,
        }),
      ),
    ];
  }

  /**
   * Share a request with a user by email (contract §6). Always resolves without
   * throwing — an unknown email, the creator's own email, or an already-shared
   * user are all silent no-ops so the 204 response never probes for accounts.
   */
  async share(id: string, userId: string, email: string): Promise<void> {
    const { request } = await this.repo.findVisible(id, userId);

    const normalized = email.trim().toLowerCase();
    const target = await this.repo.findUserIdByEmail(
      normalized,
      request.organization_id,
    );
    if (!target) return;
    if (target.id === request.created_by) return;

    const existing = await this.repo.findShare(id, target.id);
    if (existing) return;

    await this.repo.insertShare(id, target.id, request.organization_id, userId);
  }

  /**
   * Remove a shared user (contract §6). Allowed if the caller is the creator, or
   * the caller is removing themself. Removing the creator, or a non-creator
   * removing someone else, is a 404 — never a 403.
   */
  async unshare(
    id: string,
    userId: string,
    targetUserId: string,
  ): Promise<void> {
    const { request, viewer_role } = await this.repo.findVisible(id, userId);

    if (targetUserId === request.created_by) {
      throw new NotFoundException('Support request not found');
    }

    const isCreator = viewer_role === 'creator';
    const isSelf = targetUserId === userId;
    if (!isCreator && !isSelf) {
      throw new NotFoundException('Support request not found');
    }

    await this.repo.deleteShare(id, targetUserId);
  }

  /**
   * Transitions the portal may offer on this request (contract §7). Allowed target
   * statuses come ONLY from the stored published `supportTicketList` block — the
   * page→element binding is the authorization. The engine runs as the request's org and
   * its own conditions stay authoritative on top (a non-member customer fails role /
   * permission conditions closed, which is intended).
   */
  private async offeredTransitions(
    request: IEnrichedSupportRequest,
    user: RequestUser,
    ref: TransitionElementRef,
  ): Promise<{ engineUser: RequestUser; offered: CustomerTransition[] }> {
    const engineUser = { ...user, organizationId: request.organization_id };
    if (!request.task_id) return { engineUser, offered: [] };

    const element = await this.repo.findPublishedElementContent(
      ref.funnelId,
      ref.pageId,
      ref.elementId,
    );
    if (!element || element.organizationId !== request.organization_id) {
      throw new NotFoundException('Ticket list not found');
    }
    if (
      typeof element.content.spaceId === 'string' &&
      element.content.spaceId &&
      request.space_id &&
      element.content.spaceId !== request.space_id
    ) {
      throw new NotFoundException('Ticket list not found');
    }

    const ids = element.content.allowedStatusIds;
    const allowed = new Set(
      Array.isArray(ids)
        ? ids.filter((s): s is string => typeof s === 'string')
        : [],
    );
    if (allowed.size === 0) return { engineUser, offered: [] };

    const { transitions } = await this.workflowEngine.getAvailableTransitions(
      request.task_id,
      engineUser,
    );
    const candidates = transitions.flatMap((t) => {
      // Decision nodes have no to_status_id; use the engine's pre-resolved target.
      // Both null = unresolvable, never offered.
      const to = t.transition.to_status_id ?? t.resolved_to_status_id;
      return t.can_execute && !t.has_screen && to && allowed.has(to)
        ? [{ id: t.transition.id, name: t.transition.name, to }]
        : [];
    });
    if (candidates.length === 0) return { engineUser, offered: [] };

    const statuses = await this.repo.findStatusesByIds(
      request.organization_id,
      [...new Set(candidates.map((c) => c.to))],
    );
    const byId = new Map(statuses.map((s) => [s.id, s]));

    return {
      engineUser,
      offered: candidates.flatMap((c) => {
        const s = byId.get(c.to);
        return s
          ? [
              {
                id: c.id,
                name: c.name,
                to_status: { id: s.id, name: s.name, color: s.color ?? null },
              },
            ]
          : [];
      }),
    };
  }

  async listTransitions(
    id: string,
    user: RequestUser,
    ref: TransitionElementRef,
  ): Promise<CustomerTransition[]> {
    const { request } = await this.repo.findVisible(id, user.userId);
    return (await this.offeredTransitions(request, user, ref)).offered;
  }

  /**
   * Execute an offered transition, then return the refreshed enriched request. An
   * un-offered id is a 404 and never reaches the engine; engine errors (409 version
   * mismatch, 422 validators, 403 conditions, 400) propagate unchanged.
   */
  async executeTransition(
    id: string,
    user: RequestUser,
    body: TransitionElementRef & {
      transitionId: string;
      expectedVersion?: number;
    },
  ) {
    const { request } = await this.repo.findVisible(id, user.userId);
    const { engineUser, offered } = await this.offeredTransitions(
      request,
      user,
      body,
    );
    if (!request.task_id || !offered.some((t) => t.id === body.transitionId)) {
      throw new NotFoundException('Transition not available');
    }

    await this.workflowEngine.executeTransition({
      taskId: request.task_id,
      transitionId: body.transitionId,
      user: engineUser,
      expectedVersion: body.expectedVersion,
      executionId: randomUUID(),
    });

    return this.getRequest(id, user.userId);
  }

  /** Staff-requested forms on this request (contract §8). Share-aware. */
  async listFormRequests(id: string, userId: string) {
    const { request } = await this.repo.findVisible(id, userId);
    return this.formRequests.listForRequest(request.id);
  }

  /** Fill a pending staff-requested form; answers attach to the linked task. */
  async submitFormRequest(
    id: string,
    userId: string,
    formRequestId: string,
    data: Record<string, unknown>,
    meta: { ip?: string | null; userAgent?: string | null },
  ) {
    const { request } = await this.repo.findVisible(id, userId);
    return this.formRequests.submitForRequest(
      request.id,
      formRequestId,
      userId,
      data,
      meta,
    );
  }

  /**
   * Return spaces the user is a member of — used by the Help Center space selector.
   *
   * @param userId - Caller's public user ID.
   */
  async getUserSpaces(
    userId: string,
  ): Promise<
    Array<{ id: string; name: string; color: string | null; key: string }>
  > {
    return this.repo.findUserSpaces(userId);
  }

  /**
   * Return enabled module keys for a space.
   * Returns empty array if the user is not a member of the space.
   *
   * @param spaceId - UUID of the space.
   * @param userId - Caller's public user ID (membership check).
   */
  async getSpaceModules(
    spaceId: string,
    userId: string,
    organizationId?: string,
  ): Promise<string[]> {
    const moduleTypes = await this.repo.findEnabledModulesForSpace(
      spaceId,
      userId,
    );

    if (!organizationId) return moduleTypes;

    // This list populates the module picker on the support-request form. An
    // unlicensed module there lets a user file a ticket against a module their
    // tenant cannot open, so the picker follows the entitlement rather than the
    // raw space_modules rows.
    return this.entitlements.filterEntitledModuleTypes(
      organizationId,
      moduleTypes,
    );
  }
}
