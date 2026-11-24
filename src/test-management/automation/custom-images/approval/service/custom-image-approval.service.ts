import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';

import { AuditLogsService } from '../../../../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../../../../auth/interfaces/request-user.interface';
import { NotificationEmailService } from '../../../../../notifications/notification-email.service';
import { NotificationsBroadcastService } from '../../../../../notifications/notifications-broadcast.service';
import { PermissionsService } from '../../../../../permissions/permissions.service';
import { SupabaseAdminService } from '../../../../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../../../../access/test-management-access.service';
import { notFound, tmDbError } from '../../../../test-management-errors';
import { OWN_IMAGE_KEY } from '../../shared/inputs/custom-image-inputs';
import {
  APPROVALS_TABLE,
  isSpaceAdminRole,
  ruleMet,
  VOTES_TABLE,
  type ApprovalRule,
  type ApprovalSettings,
  type ApprovalStatus,
  type ApproverGroup,
} from '../rules/approval-rules';
import {
  approvalSettingsIfAvailable,
  approvalSettingsOf,
  isMissingSchema,
  SpaceApprovalReadError,
} from '../check/space-approval-check';

const APPROVAL_REQUESTED_TYPE = 'custom_image_approval_requested';
const APPROVAL_DECIDED_TYPE = 'custom_image_approval_decided';
// One switch in the person's notification settings covers both types.
const APPROVAL_PREFERENCE = 'custom_image_approval';
const IMAGE_REFERENCE_TYPE = 'test_automation_user_image';

const IMAGES_TABLE = 'test_automation_user_images';
const IMAGE_SUMMARY_COLUMNS =
  'registry, repository, digest, platform, language, test_framework, status, findings, shared, created_by';
// The request can be sent again this long after the last time.
const REMIND_GAP_MS = 30 * 60 * 1000;
const MANAGERS_TTL_MS = 30_000;
const APPROVAL_COLUMNS =
  'id, organization_id, space_id, image_id, status, requested_by, decided_by, decided_at, reason, notified_at, created_at';

type ApprovalState =
  | 'not_needed'
  | 'not_requested'
  | 'pending'
  | 'approved'
  | 'rejected';

type CannotDecideReason =
  | 'not_needed'
  | 'not_requested'
  | 'not_checked'
  | 'not_approver'
  | 'own_request'
  | 'already_voted'
  | null;

type VoteDecision = 'approved' | 'rejected';

interface VoteRow {
  user_id: string;
  decision: VoteDecision;
  created_at: string;
}

interface ApproverVote extends PersonRef {
  decision: VoteDecision | null;
}

interface ApprovalRow {
  id: string;
  organization_id: string;
  space_id: string;
  image_id: string;
  status: ApprovalStatus;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  notified_at: string | null;
  created_at: string;
}

interface ImageSummaryRow {
  registry: string;
  repository: string;
  digest: string;
  platform: string;
  language: string | null;
  test_framework: string | null;
  status: string;
  findings: { code: string; detail: string }[];
  shared: boolean | null;
  created_by: string | null;
}

interface PersonRef {
  id: string;
  name: string;
}

export interface CustomImageApprovalView {
  required: boolean;
  status: ApprovalState;
  can_approve: boolean;
  can_reject: boolean;
  cannot_decide_reason: CannotDecideReason;
  requested_by: PersonRef | null;
  requested_at: string | null;
  decided_by: PersonRef | null;
  decided_at: string | null;
  reason: string | null;
  // Any one approver, or all of them.
  rule: ApprovalRule;
  // Owners only, or owners and admins.
  approver_group: ApproverGroup;
  // How many approves the rule needs, how many it has, and each approver's answer.
  approvals_needed: number;
  approvals_given: number;
  approvers: ApproverVote[];
  // Still undecided and nobody can approve it here.
  no_approvers: boolean;
  // When the request can be sent again; null when it can be sent now or isn't waiting.
  reminder_available_at: string | null;
  can_remind: boolean;
  // Shown only to people who may see the image.
  image: Omit<ImageSummaryRow, 'created_by' | 'shared'> | null;
}

function decidedAlready(): ConflictException {
  return new ConflictException({
    code: 'IMAGE_APPROVAL_DECIDED',
    message: 'This image was already decided in this space',
  });
}

// This space's owners and admins who can view tests; owners also listed apart.
type SpaceTeam = { all: string[]; owners: string[] };

// Owners always approve; admins too when chosen, but never for an admin's own image. Neither the asker nor the uploader approves.
function approversOf(
  team: SpaceTeam,
  group: ApproverGroup,
  askerId: string | null,
  uploaderId: string | null,
): string[] {
  const askerIsAdmin =
    !!askerId && team.all.includes(askerId) && !team.owners.includes(askerId);
  const pool =
    group === 'owners_admins' && !askerIsAdmin ? team.all : team.owners;

  return pool.filter((id) => id !== askerId && id !== uploaderId);
}

// Nobody in the space other than the person who asked or added the image.
function noApprovers(): ConflictException {
  return new ConflictException({
    code: 'IMAGE_NO_APPROVERS',
    message: 'No one else in this space can approve this image',
  });
}

/** Approval of a custom image in one space, after the image passed its own download and security check. */
@Injectable()
export class CustomImageApprovalService {
  private readonly logger = new Logger(CustomImageApprovalService.name);
  // ponytail: per-process 30 s cache, so a role change can take up to 30 s to count here.
  private readonly managerCache = new Map<
    string,
    { expiresAt: number; team: Promise<SpaceTeam> }
  >();

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
    private readonly auditLogs: AuditLogsService,
    private readonly access: TestManagementAccessService,
    @Optional()
    private readonly broadcast?: NotificationsBroadcastService,
    @Optional()
    private readonly email?: NotificationEmailService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async settings(
    organizationId: string,
    spaceId: string,
  ): Promise<ApprovalSettings> {
    try {
      return await approvalSettingsOf(this.client, organizationId, spaceId);
    } catch (error) {
      if (error instanceof SpaceApprovalReadError) {
        throw tmDbError(this.logger, 'load image approval settings', error);
      }

      throw error;
    }
  }

  /** The approval choice for the settings screen; null when its columns aren't there yet. */
  async settingsIfAvailable(
    organizationId: string,
    spaceId: string,
  ): Promise<ApprovalSettings | null> {
    try {
      return await approvalSettingsIfAvailable(
        this.client,
        organizationId,
        spaceId,
      );
    } catch (error) {
      if (error instanceof SpaceApprovalReadError) {
        throw tmDbError(this.logger, 'load image approval settings', error);
      }

      throw error;
    }
  }

  /** Only space owners and admins, and organisation owners and admins, change the approval setting. */
  async canManage(user: RequestUser, spaceId: string): Promise<boolean> {
    if (
      await this.permissions.isAdminOrOwner(user.userId, user.organizationId)
    ) {
      return true;
    }

    const space = await this.permissions.getUserSpacePermissions(
      user.userId,
      user.organizationId,
      spaceId,
    );

    return space.isMember && isSpaceAdminRole(space.spaceRole);
  }

  /** Only space owners, and organisation owners and admins, choose who approves. */
  async canChooseApprovers(
    user: RequestUser,
    spaceId: string,
  ): Promise<boolean> {
    if (
      await this.permissions.isAdminOrOwner(user.userId, user.organizationId)
    ) {
      return true;
    }

    const space = await this.permissions.getUserSpacePermissions(
      user.userId,
      user.organizationId,
      spaceId,
    );

    return space.isMember && space.spaceRole === 'owner';
  }

  /** Whether the space has an owner who can view tests, so an admin's image can be approved. */
  async hasOwners(organizationId: string, spaceId: string): Promise<boolean> {
    return (await this.team(organizationId, spaceId)).owners.length > 0;
  }

  /** A setting may not link an image this space rejected. */
  async assertNotRejectedHere(
    organizationId: string,
    spaceId: string,
    imageId: string,
  ): Promise<void> {
    const settings = await this.settings(organizationId, spaceId);

    if (!settings.required) return;

    const row = await this.approvalRow(organizationId, spaceId, imageId);

    if (row?.status !== 'rejected') return;

    throw new BadRequestException({
      code: 'IMAGE_REJECTED_HERE',
      message: 'This image was rejected in this space',
      data: { field: 'user_image_id' },
    });
  }

  /** Asks this space's approvers about an image it uses; nothing when approval is off or an answer exists. Adder null: whoever first linked it here. */
  async ensureRequest(
    organizationId: string,
    spaceId: string,
    imageId: string,
    adderId: string | null,
  ): Promise<void> {
    const settings = await this.settings(organizationId, spaceId);

    if (!settings.required) return;

    const requestedBy =
      adderId ?? (await this.adderOf(organizationId, spaceId, imageId));

    // A space owner needs nobody's approval when nobody asked yet; a request already waiting is decided by a click.
    if (
      requestedBy &&
      (await this.team(organizationId, spaceId)).owners.includes(requestedBy)
    ) {
      await this.approveForOwner(organizationId, spaceId, imageId, requestedBy);

      return;
    }

    const { error } = await this.client.from(APPROVALS_TABLE).upsert(
      {
        organization_id: organizationId,
        space_id: spaceId,
        image_id: imageId,
        requested_by: requestedBy,
      },
      { onConflict: 'space_id,image_id', ignoreDuplicates: true },
    );

    if (error) {
      if (isMissingSchema(error.code)) return;

      throw tmDbError(this.logger, 'ask for image approval', error);
    }

    // Runs after the row exists, so a check finishing meanwhile is never missed.
    await this.notifyWaiting(organizationId, imageId, spaceId);
  }

  /** A space owner's image is approved here at once, only when this space has no answer for it yet. */
  private async approveForOwner(
    organizationId: string,
    spaceId: string,
    imageId: string,
    ownerId: string,
  ): Promise<void> {
    const decided = {
      status: 'approved',
      decided_by: ownerId,
      decided_at: new Date().toISOString(),
      reason: null,
    };
    const { error } = await this.client.from(APPROVALS_TABLE).upsert(
      {
        organization_id: organizationId,
        space_id: spaceId,
        image_id: imageId,
        requested_by: ownerId,
        notified_at: decided.decided_at,
        ...decided,
      },
      { onConflict: 'space_id,image_id', ignoreDuplicates: true },
    );

    if (error) {
      if (isMissingSchema(error.code)) return;

      throw tmDbError(this.logger, 'approve image for a space owner', error);
    }
  }

  /** Who first linked the image in this space's settings; null when nobody did. */
  private async adderOf(
    organizationId: string,
    spaceId: string,
    imageId: string,
  ): Promise<string | null> {
    const { data, error } = await this.client
      .from('test_automation_configs')
      .select('created_by')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('image_key', OWN_IMAGE_KEY)
      .eq('user_image_id', imageId)
      .is('archived_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load who added the image', error);

    return (data as { created_by: string | null } | null)?.created_by ?? null;
  }

  /** Approval was just switched on: the images this space's settings already use need an answer too. */
  async requestForSpace(
    organizationId: string,
    spaceId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('test_automation_configs')
      .select('user_image_id, created_by')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('image_key', OWN_IMAGE_KEY)
      .is('archived_at', null)
      .not('user_image_id', 'is', null);

    if (error) throw tmDbError(this.logger, 'load linked images', error);

    const seen = new Set<string>();

    for (const row of (data ?? []) as {
      user_image_id: string;
      created_by: string | null;
    }[]) {
      if (seen.has(row.user_image_id)) continue;

      seen.add(row.user_image_id);

      // One image failing doesn't stop the others.
      try {
        await this.ensureRequest(
          organizationId,
          spaceId,
          row.user_image_id,
          row.created_by,
        );
      } catch (error) {
        this.logger.warn(
          `Image approval for ${row.user_image_id} not asked: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** A new rule or approver choice: finishes requests it already allows and asks the current approvers about the rest. */
  async refreshWaiting(organizationId: string, spaceId: string): Promise<void> {
    const { data, error } = await this.client
      .from(APPROVALS_TABLE)
      .select(APPROVAL_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('status', 'pending');

    if (error) {
      if (isMissingSchema(error.code)) return;

      throw tmDbError(this.logger, 'load waiting approvals', error);
    }

    for (const row of (data ?? []) as unknown as ApprovalRow[]) {
      try {
        const now = await this.settle(row);

        if (now.status !== 'pending' || !now.notified_at) continue;

        const image = await this.imageSummary(organizationId, row.image_id);

        if (!image) continue;

        await this.dismissRequests(now);
        await this.sendRequest(now, image);
      } catch (err) {
        this.logger.warn(
          `Waiting image approval ${row.id} not refreshed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Finishes a waiting request that the current approvers and rule already allow; returns the row as it now is. */
  private async settle(row: ApprovalRow): Promise<ApprovalRow> {
    if (row.status !== 'pending') return row;

    const [settings, team, image] = await Promise.all([
      this.settings(row.organization_id, row.space_id),
      this.team(row.organization_id, row.space_id),
      this.imageSummary(row.organization_id, row.image_id),
    ]);

    if (!settings.required || !image || image.status !== 'approved') return row;

    const approvers = approversOf(
      team,
      settings.approvers,
      row.requested_by,
      image.created_by,
    );
    const votes = (await this.votes(row.organization_id, row.id)).filter(
      (vote) =>
        vote.decision === 'approved' && approvers.includes(vote.user_id),
    );
    const approvedBy = new Set(votes.map((vote) => vote.user_id));
    const met =
      settings.rule === 'any'
        ? approvedBy.size > 0
        : ruleMet(approvers, approvedBy);

    if (!met) return row;

    // The latest approve stands for the decision.
    const last = votes.reduce((a, b) => (a.created_at >= b.created_at ? a : b));
    const { data, error } = await this.client
      .from(APPROVALS_TABLE)
      .update({
        status: 'approved',
        decided_by: last.user_id,
        decided_at: new Date().toISOString(),
        reason: null,
      })
      .eq('id', row.id)
      .eq('organization_id', row.organization_id)
      .eq('space_id', row.space_id)
      .eq('status', 'pending')
      .select(APPROVAL_COLUMNS)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'finish image approval', error);

    if (!data) {
      return (
        (await this.approvalRow(
          row.organization_id,
          row.space_id,
          row.image_id,
        )) ?? row
      );
    }

    const decided = data as unknown as ApprovalRow;

    await this.closeRequest(decided, image, last.user_id).catch((err) =>
      this.logger.warn(
        `Image approval notice for ${row.id} failed: ${(err as Error).message}`,
      ),
    );

    return decided;
  }

  /** The image passed its check: tell the approvers of every space still waiting for it. */
  async notifyPending(organizationId: string, imageId: string): Promise<void> {
    await this.notifyWaiting(organizationId, imageId);
  }

  async state(
    user: RequestUser,
    spaceId: string,
    imageId: string,
  ): Promise<CustomImageApprovalView> {
    await this.access.assertAvailable(user.organizationId, spaceId);

    return this.view(user, spaceId, imageId);
  }

  async decide(
    user: RequestUser,
    spaceId: string,
    imageId: string,
    decision: 'approved' | 'rejected',
    reason: string | undefined,
  ): Promise<CustomImageApprovalView> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const note = reason?.trim() ?? '';

    if (decision === 'rejected' && note.length < 3) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Say why the image is rejected, in at least 3 characters',
        data: { field: 'reason' },
      });
    }

    const { settings, row, image, managers, approver, ownRequest } =
      await this.context(user, spaceId, imageId);

    this.assertOpen(settings, row, image);

    if (!approver) {
      throw new ForbiddenException({
        code: 'IMAGE_APPROVAL_NOT_ALLOWED',
        message: ownRequest
          ? 'You asked for this approval or added the image, so someone else in the space must decide'
          : 'You are not an approver of custom images in this space',
      });
    }

    // A decided request is final; a rejected one can only be sent again.
    if (row.status !== 'pending') throw decidedAlready();

    await this.saveVote(row, user.userId, decision, note);

    // One reject or the "any one" rule decides; "all" waits until every approver approved.
    const final =
      decision === 'rejected' ||
      settings.rule === 'any' ||
      ruleMet(managers, await this.approvedVoters(user.organizationId, row.id));
    const log = (decided: boolean) =>
      void this.auditLogs.logActionForRequest(
        user,
        'test_automation_user_image_approval',
        row.id,
        'update',
        {
          image_id: imageId,
          space_id: spaceId,
          vote: decision,
          decided,
          rule: settings.rule,
          ...(decision === 'rejected' && { reason: note }),
        },
      );

    if (!final) {
      // Someone decided while this vote was saved: it no longer counts.
      const now = await this.approvalRow(user.organizationId, spaceId, imageId);

      if (now?.status !== 'pending') {
        await this.removeVote(row, user.userId);

        throw decidedAlready();
      }

      log(false);

      return this.view(user, spaceId, imageId);
    }

    const { data, error } = await this.client
      .from(APPROVALS_TABLE)
      .update({
        status: decision,
        decided_by: user.userId,
        decided_at: new Date().toISOString(),
        reason: decision === 'rejected' ? note : null,
      })
      .eq('id', row.id)
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .eq('status', 'pending')
      .select(APPROVAL_COLUMNS)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'decide image approval', error);

    // Someone else decided first; with "all" the last two approvers may finish it at the same time.
    if (!data) {
      const now = await this.approvalRow(user.organizationId, spaceId, imageId);

      if (now?.status === 'approved' && decision === 'approved') {
        log(false);

        return this.view(user, spaceId, imageId);
      }

      await this.removeVote(row, user.userId);

      throw decidedAlready();
    }

    log(true);

    const decided = data as unknown as ApprovalRow;

    await this.closeRequest(decided, image, user.userId).catch((err) =>
      this.logger.warn(
        `Image approval notice for ${row.id} failed: ${(err as Error).message}`,
      ),
    );

    return this.view(user, spaceId, imageId);
  }

  /** Asks this space's owners and admins again, at most once every 30 minutes per request. */
  async remind(
    user: RequestUser,
    spaceId: string,
    imageId: string,
  ): Promise<CustomImageApprovalView> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const { settings, row, image, team, managers } = await this.context(
      user,
      spaceId,
      imageId,
    );

    // No request yet: this sends the first one, as saving the setting would.
    if (settings.required && !row && image.status === 'approved') {
      if (!(await this.mayRemind(user, spaceId, null))) {
        throw new ForbiddenException({
          code: 'IMAGE_APPROVAL_NOT_ALLOWED',
          message:
            'Only someone who may edit the space settings can ask for approval',
        });
      }

      await this.ensureRequest(user.organizationId, spaceId, imageId, null);

      const created = await this.approvalRow(
        user.organizationId,
        spaceId,
        imageId,
      );

      if (created) {
        void this.auditLogs.logActionForRequest(
          user,
          'test_automation_user_image_approval',
          created.id,
          'create',
          {
            action: 'requested',
            image_id: imageId,
            space_id: spaceId,
            status: created.status,
          },
        );
      }

      // Nobody else to ask: said plainly instead of waiting silently.
      if (
        created?.status === 'pending' &&
        approversOf(
          team,
          settings.approvers,
          created.requested_by,
          image.created_by,
        ).length === 0
      ) {
        throw noApprovers();
      }

      return this.state(user, spaceId, imageId);
    }

    this.assertOpen(settings, row, image);

    // A rejected image is asked about again from the start, with no old votes.
    if (row.status === 'rejected') {
      if (!(await this.mayAskAgain(user, spaceId, row, image, team))) {
        throw new ForbiddenException({
          code: 'IMAGE_APPROVAL_NOT_ALLOWED',
          message:
            'Only the person who asked or who added the image can send it again',
        });
      }

      if (managers.length === 0) throw noApprovers();

      await this.reopen(row);
      await this.notifyWaiting(user.organizationId, imageId, spaceId);

      void this.auditLogs.logActionForRequest(
        user,
        'test_automation_user_image_approval',
        row.id,
        'update',
        { image_id: imageId, space_id: spaceId, asked_again: true },
      );

      return this.view(user, spaceId, imageId);
    }

    if (!(await this.mayRemind(user, spaceId, row))) {
      throw new ForbiddenException({
        code: 'IMAGE_APPROVAL_NOT_ALLOWED',
        message:
          'Only the person who asked, or someone who may edit the space settings, can send it again',
      });
    }

    if (row.status !== 'pending') throw decidedAlready();

    const claimedAt = new Date();
    const cutoff = new Date(claimedAt.getTime() - REMIND_GAP_MS).toISOString();
    let claim = this.client
      .from(APPROVALS_TABLE)
      .update({ notified_at: claimedAt.toISOString() })
      .eq('id', row.id)
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .eq('status', 'pending')
      .or(`notified_at.is.null,notified_at.lt.${cutoff}`);

    // Guarded by the value read above, so two clicks can't both send.
    claim = row.notified_at
      ? claim.eq('notified_at', row.notified_at)
      : claim.is('notified_at', null);

    const { data: claimed, error } = await claim.select('id').maybeSingle();

    if (error) throw tmDbError(this.logger, 'send image approval again', error);

    if (!claimed) {
      const now = await this.approvalRow(user.organizationId, spaceId, imageId);

      if (now?.status !== 'pending') throw decidedAlready();

      throw new ConflictException({
        code: 'APPROVAL_REMINDER_TOO_SOON',
        message: 'The request was sent a short while ago; try again later',
        data: {
          next_at: this.reminderAt(now.notified_at) ?? claimedAt.toISOString(),
        },
      });
    }

    let reached = 0;

    // The earlier notices are replaced, so nobody keeps two.
    await this.dismissRequests(row);

    try {
      reached = await this.sendRequest(row, image);
    } finally {
      if (reached === 0) {
        await this.unclaim(row, claimedAt.toISOString(), row.notified_at);
      }
    }

    if (reached === 0) throw noApprovers();

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_user_image_approval',
      row.id,
      'update',
      { image_id: imageId, space_id: spaceId, reminded: true },
    );

    return this.view(user, spaceId, imageId);
  }

  /** Approval is on, the image is asked for here, and its security check passed. */
  private assertOpen(
    settings: ApprovalSettings,
    row: ApprovalRow | null,
    image: ImageSummaryRow,
  ): asserts row is ApprovalRow {
    if (!settings.required) {
      throw new ConflictException({
        code: 'IMAGE_APPROVAL_NOT_NEEDED',
        message: 'This space does not ask for image approval',
      });
    }

    if (!row) {
      throw new ConflictException({
        code: 'IMAGE_APPROVAL_NOT_REQUESTED',
        message:
          'Approval is asked for once a setting of this space uses the image',
      });
    }

    if (image.status !== 'approved') {
      throw new ConflictException({
        code: 'IMAGE_NOT_CHECKED_YET',
        message: 'The image can be approved once its security check has passed',
      });
    }
  }

  // The person who asked, or someone who may change the space's settings.
  private async mayRemind(
    user: RequestUser,
    spaceId: string,
    row: ApprovalRow | null,
  ): Promise<boolean> {
    return (
      row?.requested_by === user.userId ||
      this.permissions.hasSpacePermission(
        user.userId,
        user.organizationId,
        spaceId,
        'edit_space_settings',
      )
    );
  }

  // Who asked or added the image; when both left the organisation, a space owner.
  private async mayAskAgain(
    user: RequestUser,
    spaceId: string,
    row: ApprovalRow,
    image: ImageSummaryRow,
    team: SpaceTeam,
  ): Promise<boolean> {
    const askers = [row.requested_by, image.created_by].filter(
      (id): id is string => Boolean(id),
    );

    if (askers.includes(user.userId)) return true;
    if (!team.owners.includes(user.userId)) return false;
    if (askers.length === 0) return true;

    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', user.organizationId)
      .in('user_id', askers);

    if (error) throw tmDbError(this.logger, 'load organisation members', error);

    return (data ?? []).length === 0;
  }

  private reminderAt(notifiedAt: string | null): string | null {
    return notifiedAt
      ? new Date(Date.parse(notifiedAt) + REMIND_GAP_MS).toISOString()
      : null;
  }

  // Gives back a claim nobody was told about, so the request can be sent again.
  private async unclaim(
    row: ApprovalRow,
    claimedAt: string,
    previous: string | null,
  ): Promise<void> {
    const { error } = await this.client
      .from(APPROVALS_TABLE)
      .update({ notified_at: previous })
      .eq('id', row.id)
      .eq('organization_id', row.organization_id)
      .eq('space_id', row.space_id)
      .eq('notified_at', claimedAt);

    if (error) {
      this.logger.warn(
        `Image approval claim for ${row.id} not given back: ${error.message}`,
      );
    }
  }

  /** A rejected answer waits again, with no votes. */
  private async reopen(row: ApprovalRow): Promise<void> {
    const { data, error } = await this.client
      .from(APPROVALS_TABLE)
      .update({
        status: 'pending',
        decided_by: null,
        decided_at: null,
        reason: null,
        notified_at: null,
      })
      .eq('id', row.id)
      .eq('organization_id', row.organization_id)
      .eq('space_id', row.space_id)
      .eq('status', 'rejected')
      .select('id')
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'reopen image approval', error);
    if (!data) throw decidedAlready();

    const { error: clearError } = await this.client
      .from(VOTES_TABLE)
      .delete()
      .eq('approval_id', row.id)
      .eq('organization_id', row.organization_id)
      .eq('space_id', row.space_id);

    if (clearError && !isMissingSchema(clearError.code)) {
      throw tmDbError(this.logger, 'clear image approval votes', clearError);
    }
  }

  /** Takes back one person's vote, after their answer lost to another. */
  private async removeVote(row: ApprovalRow, userId: string): Promise<void> {
    const { error } = await this.client
      .from(VOTES_TABLE)
      .delete()
      .eq('approval_id', row.id)
      .eq('user_id', userId)
      .eq('organization_id', row.organization_id)
      .eq('space_id', row.space_id);

    if (error && !isMissingSchema(error.code)) {
      this.logger.warn(
        `Image approval vote for ${row.id} not taken back: ${error.message}`,
      );
    }
  }

  /** One answer per person; a second answer from the same person replaces the first. */
  private async saveVote(
    row: ApprovalRow,
    userId: string,
    decision: VoteDecision,
    reason: string,
  ): Promise<void> {
    const { error } = await this.client.from(VOTES_TABLE).upsert(
      {
        organization_id: row.organization_id,
        space_id: row.space_id,
        approval_id: row.id,
        user_id: userId,
        decision,
        reason: decision === 'rejected' ? reason : null,
        created_at: new Date().toISOString(),
      },
      { onConflict: 'approval_id,user_id' },
    );

    // Before the votes table exists only "any one" is possible, which needs no votes.
    if (error && !isMissingSchema(error.code)) {
      throw tmDbError(this.logger, 'save image approval vote', error);
    }
  }

  private async votes(
    organizationId: string,
    approvalId: string,
  ): Promise<VoteRow[]> {
    const { data, error } = await this.client
      .from(VOTES_TABLE)
      .select('user_id, decision, created_at')
      .eq('organization_id', organizationId)
      .eq('approval_id', approvalId);

    if (error) {
      if (isMissingSchema(error.code)) return [];

      throw tmDbError(this.logger, 'load image approval votes', error);
    }

    return (data ?? []) as VoteRow[];
  }

  private async approvedVoters(
    organizationId: string,
    approvalId: string,
  ): Promise<Set<string>> {
    return new Set(
      (await this.votes(organizationId, approvalId))
        .filter((vote) => vote.decision === 'approved')
        .map((vote) => vote.user_id),
    );
  }

  /** Run start: refuses an image this space hasn't approved, asking for approval when nobody was asked yet. */
  async assertApprovedHere(
    user: RequestUser,
    spaceId: string,
    imageId: string,
  ): Promise<void> {
    const settings = await this.settings(user.organizationId, spaceId);

    if (!settings.required) return;

    let row = await this.approvalRow(user.organizationId, spaceId, imageId);

    // Nobody asked yet: the request is made for whoever first linked the image here.
    if (!row) {
      await this.ensureRequest(user.organizationId, spaceId, imageId, null);
      row = await this.approvalRow(user.organizationId, spaceId, imageId);
    }

    // Approvers or the rule may have changed since the last answer.
    if (row) row = await this.settle(row);

    if (row?.status === 'approved') return;

    if (row?.status === 'rejected') {
      throw new ConflictException({
        code: 'IMAGE_REJECTED_HERE',
        message: 'This image was rejected in this space',
      });
    }

    const [team, image] = await Promise.all([
      this.team(user.organizationId, spaceId),
      this.imageSummary(user.organizationId, imageId),
    ]);

    if (
      approversOf(
        team,
        settings.approvers,
        row?.requested_by ?? null,
        image?.created_by ?? null,
      ).length === 0
    ) {
      throw noApprovers();
    }

    throw new ConflictException({
      code: 'IMAGE_AWAITING_APPROVAL',
      message: 'This image waits for approval in this space',
    });
  }

  /** The answer of this space for each image, for lists; empty when approval is off. */
  async spaceApprovals(
    organizationId: string,
    spaceId: string,
    imageIds: string[],
  ): Promise<{
    required: boolean;
    statuses: Map<string, ApprovalStatus>;
  }> {
    const settings = await this.settings(organizationId, spaceId);
    const statuses = new Map<string, ApprovalStatus>();

    if (!settings.required || imageIds.length === 0) {
      return { required: settings.required, statuses };
    }

    const { data, error } = await this.client
      .from(APPROVALS_TABLE)
      .select('image_id, status')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .in('image_id', imageIds);

    if (error) {
      if (isMissingSchema(error.code)) return { required: false, statuses };

      throw tmDbError(this.logger, 'load image approvals', error);
    }

    for (const row of (data ?? []) as {
      image_id: string;
      status: ApprovalStatus;
    }[]) {
      statuses.set(row.image_id, row.status);
    }

    return { required: true, statuses };
  }

  private async view(
    user: RequestUser,
    spaceId: string,
    imageId: string,
  ): Promise<CustomImageApprovalView> {
    const {
      settings,
      row,
      image,
      managers,
      approver,
      orgAdmin,
      ownRequest,
      team,
    } = await this.context(user, spaceId, imageId);
    const status: ApprovalState = !settings.required
      ? 'not_needed'
      : (row?.status ?? 'not_requested');
    const approvers = settings.required ? managers : [];
    const votes = row ? await this.votes(user.organizationId, row.id) : [];
    const voteOf = new Map(votes.map((vote) => [vote.user_id, vote.decision]));
    const approvedBy = new Set(
      votes
        .filter((vote) => vote.decision === 'approved')
        .map((vote) => vote.user_id),
    );
    const pending = row?.status === 'pending';
    const checked = image.status === 'approved';
    const open = settings.required && !!row && checked && approver;
    // With "all", once everyone still asked has approved, any approver's click finishes it.
    const finishable =
      pending && settings.rule === 'all' && ruleMet(approvers, approvedBy);
    const votedYes =
      pending && voteOf.get(user.userId) === 'approved' && !finishable;
    // Same rules as decide(): only while waiting, never twice.
    const canApprove = open && !votedYes && pending;
    const canReject = open && pending;
    const reasonWhy: CannotDecideReason = !settings.required
      ? 'not_needed'
      : !row
        ? 'not_requested'
        : !checked
          ? 'not_checked'
          : ownRequest
            ? 'own_request'
            : !approver
              ? 'not_approver'
              : votedYes
                ? 'already_voted'
                : null;
    // Waiting or not asked yet: anyone who may remind; rejected: who asked or added the image.
    const canRemind =
      settings.required &&
      checked &&
      approvers.length > 0 &&
      (row?.status === 'rejected'
        ? await this.mayAskAgain(user, spaceId, row, image, team)
        : (!row || pending) && (await this.mayRemind(user, spaceId, row)));
    // Seeing the image follows the images list: shared, yours, or you may decide on it.
    const visible =
      image.shared !== false ||
      image.created_by === user.userId ||
      row?.requested_by === user.userId ||
      approver ||
      orgAdmin;
    const names = await this.names([
      row?.requested_by ?? null,
      row?.decided_by ?? null,
      ...approvers,
    ]);
    const approvalsGiven = approvers.filter((id) => approvedBy.has(id)).length;
    // Who added the image stays on the server.
    const summary = {
      registry: image.registry,
      repository: image.repository,
      digest: image.digest,
      platform: image.platform,
      language: image.language,
      test_framework: image.test_framework,
      status: image.status,
      findings: image.findings,
    };

    return {
      required: settings.required,
      status,
      can_approve: canApprove,
      can_reject: canReject,
      cannot_decide_reason: reasonWhy,
      requested_by: this.person(row?.requested_by ?? null, names),
      requested_at: row?.created_at ?? null,
      decided_by: this.person(row?.decided_by ?? null, names),
      decided_at: row?.decided_at ?? null,
      reason: row?.reason ?? null,
      rule: settings.rule,
      approver_group: settings.approvers,
      approvals_needed:
        settings.rule === 'all' ? Math.max(approvers.length, 1) : 1,
      approvals_given:
        row?.status === 'approved'
          ? Math.max(approvalsGiven, 1)
          : approvalsGiven,
      approvers: approvers.map((id) => ({
        id,
        name: names.get(id) ?? 'Someone',
        decision: voteOf.get(id) ?? null,
      })),
      no_approvers:
        settings.required && (!row || pending) && approvers.length === 0,
      reminder_available_at: pending
        ? this.reminderAt(row?.notified_at ?? null)
        : null,
      can_remind: canRemind,
      image: visible ? summary : null,
    };
  }

  private async context(user: RequestUser, spaceId: string, imageId: string) {
    const image = await this.imageSummary(user.organizationId, imageId);

    if (!image) throw notFound();

    const [settings, row, team, orgAdmin] = await Promise.all([
      this.settings(user.organizationId, spaceId),
      this.approvalRow(user.organizationId, spaceId, imageId),
      this.team(user.organizationId, spaceId),
      this.permissions.isAdminOrOwner(user.userId, user.organizationId),
    ]);
    // Only this space's owners (and admins, when chosen, for a member's request) decide; never who asked or added the image; organisation roles don't count.
    const approvers = approversOf(
      team,
      settings.approvers,
      row?.requested_by ?? null,
      image.created_by,
    );
    const ownRequest =
      (!!row && row.requested_by === user.userId) ||
      image.created_by === user.userId;

    return {
      settings,
      row,
      image,
      managers: approvers,
      approver: approvers.includes(user.userId),
      orgAdmin,
      ownRequest,
      team,
    };
  }

  /** This space's owners and admins (as a person, a group or a role) who can view tests. */
  private team(organizationId: string, spaceId: string): Promise<SpaceTeam> {
    const key = `${organizationId}:${spaceId}`;
    const cached = this.managerCache.get(key);

    if (cached && cached.expiresAt > Date.now()) return cached.team;

    const team = this.loadManagers(organizationId, spaceId);

    this.managerCache.set(key, {
      expiresAt: Date.now() + MANAGERS_TTL_MS,
      team,
    });
    team.catch(() => this.managerCache.delete(key));

    return team;
  }

  private async loadManagers(
    organizationId: string,
    spaceId: string,
  ): Promise<SpaceTeam> {
    const { data, error } = await this.client
      .from('space_members')
      .select('member_type, user_id, group_id, role_id, space_role')
      .eq('space_id', spaceId)
      .eq('is_active', true)
      .in('space_role', ['owner', 'admin']);

    if (error) throw tmDbError(this.logger, 'load space owners', error);

    const rows = (data ?? []) as {
      member_type: string | null;
      user_id: string | null;
      group_id: string | null;
      role_id: string | null;
      space_role: string | null;
    }[];
    const people = new Set<string>();
    // The owner role wins when someone is in the space twice.
    const ownerIds = new Set<string>();
    const groupIds = new Map<string, boolean>();
    const roleIds = new Map<string, boolean>();
    const add = (userId: string, owner: boolean) => {
      people.add(userId);
      if (owner) ownerIds.add(userId);
    };

    for (const row of rows) {
      const owner = row.space_role === 'owner';

      if (row.member_type === 'group') {
        if (row.group_id)
          groupIds.set(row.group_id, owner || !!groupIds.get(row.group_id));
      } else if (row.member_type === 'role') {
        if (row.role_id)
          roleIds.set(row.role_id, owner || !!roleIds.get(row.role_id));
      } else if (row.user_id) {
        add(row.user_id, owner);
      }
    }

    // Group links count only for this organisation's groups that still exist, as in the permissions service.
    const groupLinks = async (
      column: 'group_id' | 'role_id',
      ids: Map<string, boolean>,
    ) => {
      if (ids.size === 0) return;

      const { data: links, error: linkError } = await this.client
        .from('user_group_members')
        .select(
          'user_id, group_id, role_id, group:user_groups(organization_id, is_deleted)',
        )
        .in(column, [...ids.keys()]);

      if (linkError) {
        throw tmDbError(this.logger, 'load space owner groups', linkError);
      }

      for (const link of (links ?? []) as unknown as {
        user_id: string | null;
        group_id: string | null;
        role_id: string | null;
        group: { organization_id: string; is_deleted: boolean | null } | null;
      }[]) {
        if (
          link.user_id &&
          link.group?.organization_id === organizationId &&
          link.group.is_deleted !== true
        ) {
          add(link.user_id, !!ids.get(link[column] ?? ''));
        }
      }
    };

    await groupLinks('group_id', groupIds);
    await groupLinks('role_id', roleIds);

    if (roleIds.size > 0) {
      const { data: assigned, error: roleError } = await this.client
        .from('user_role_assignments')
        .select('user_id, role_id')
        .eq('organization_id', organizationId)
        .in('role_id', [...roleIds.keys()]);

      if (roleError) {
        throw tmDbError(this.logger, 'load space owner roles', roleError);
      }

      for (const link of (assigned ?? []) as {
        user_id: string | null;
        role_id: string | null;
      }[]) {
        if (link.user_id) add(link.user_id, !!roleIds.get(link.role_id ?? ''));
      }
    }

    if (people.size === 0) return { all: [], owners: [] };

    // Only people still in the organisation.
    const { data: members, error: memberError } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', organizationId)
      .in('user_id', [...people]);

    if (memberError) {
      throw tmDbError(this.logger, 'load organisation members', memberError);
    }

    const current = [
      ...new Set(
        ((members ?? []) as { user_id: string | null }[])
          .map((row) => row.user_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const checks = await Promise.all(
      current.map(async (userId) =>
        (
          await this.permissions.resolveTestManagementPermissions(
            userId,
            organizationId,
            spaceId,
          )
        ).permissions.view_tests
          ? userId
          : null,
      ),
    );

    const all = checks.filter((id): id is string => Boolean(id));

    return { all, owners: all.filter((id) => ownerIds.has(id)) };
  }

  /** Sends the first notice for each waiting answer of an image whose check passed; claimed once per answer. */
  private async notifyWaiting(
    organizationId: string,
    imageId: string,
    spaceId?: string,
  ): Promise<void> {
    let query = this.client
      .from(APPROVALS_TABLE)
      .select(APPROVAL_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('image_id', imageId)
      .eq('status', 'pending')
      .is('notified_at', null);

    if (spaceId) query = query.eq('space_id', spaceId);

    const { data, error } = await query;

    if (error) {
      if (isMissingSchema(error.code)) return;

      throw tmDbError(this.logger, 'load waiting approvals', error);
    }

    const rows = (data ?? []) as ApprovalRow[];

    if (rows.length === 0) return;

    const image = await this.imageSummary(organizationId, imageId);

    if (!image || image.status !== 'approved') return;

    for (const row of rows) {
      const settings = await this.settings(organizationId, row.space_id);

      if (!settings.required) continue;

      // Claimed first, so the API and the runner never both send it.
      const claimedAt = new Date().toISOString();
      const { data: claimed, error: claimError } = await this.client
        .from(APPROVALS_TABLE)
        .update({ notified_at: claimedAt })
        .eq('id', row.id)
        .eq('organization_id', organizationId)
        .is('notified_at', null)
        .select('id')
        .maybeSingle();

      if (claimError || !claimed) continue;

      let reached = 0;

      try {
        reached = await this.sendRequest(row, image);
      } finally {
        // Nobody was told, so a later save or check tries again.
        if (reached === 0) await this.unclaim(row, claimedAt, null);
      }
    }
  }

  /** Asks every approver of this request; returns how many of them were reached. */
  private async sendRequest(
    row: ApprovalRow,
    image: ImageSummaryRow,
  ): Promise<number> {
    const [team, settings] = await Promise.all([
      this.team(row.organization_id, row.space_id),
      this.settings(row.organization_id, row.space_id),
    ]);
    const managers = approversOf(
      team,
      settings.approvers,
      row.requested_by,
      image.created_by,
    );

    // No owner to ask: nothing is sent.
    if (!managers.some((id) => id !== row.requested_by)) return 0;

    const [space, names] = await Promise.all([
      this.space(row.space_id),
      this.names([row.requested_by]),
    ]);
    const asker =
      this.oneLine(this.person(row.requested_by, names)?.name) || 'Someone';
    const imageName = this.imageName(image);
    const spaceName = this.oneLine(space?.name) || 'your space';
    const common = {
      type: APPROVAL_REQUESTED_TYPE,
      spaceKey: space?.key ?? null,
      actorId: row.requested_by,
      actorName: asker,
    };
    const body = `${imageName} passed its security check and waits for approval before it can run in ${spaceName}.`;
    const reached = await this.send(
      row,
      managers.filter((id) => id !== row.requested_by),
      {
        ...common,
        title: `${asker} asked you to approve a custom Docker image`,
        body,
      },
    );

    return reached;
  }

  /** Marks this request's open "please approve" notices as handled. */
  private async dismissRequests(row: ApprovalRow): Promise<void> {
    const { error } = await this.client
      .from('notifications')
      .update({
        action_status: 'dismissed',
        is_read: true,
        updated_at: new Date().toISOString(),
      })
      .eq('organization_id', row.organization_id)
      .eq('type', APPROVAL_REQUESTED_TYPE)
      .eq('reference_type', IMAGE_REFERENCE_TYPE)
      .eq('reference_id', row.image_id)
      .eq('action_status', 'none')
      .contains('metadata', { space_id: row.space_id });

    if (error) {
      this.logger.warn(
        `Image approval notices for ${row.id} not closed: ${error.message}`,
      );
    }
  }

  /** The request was decided: its "please approve" notices are handled, and who asked and who was asked hear it. */
  private async closeRequest(
    row: ApprovalRow,
    image: ImageSummaryRow,
    deciderId: string,
  ): Promise<void> {
    await this.dismissRequests(row);

    const [space, names, managers] = await Promise.all([
      this.space(row.space_id),
      this.names([deciderId]),
      Promise.all([
        this.team(row.organization_id, row.space_id),
        this.settings(row.organization_id, row.space_id),
      ]).then(([team, settings]) =>
        approversOf(
          team,
          settings.approvers,
          row.requested_by,
          image.created_by,
        ),
      ),
    ]);
    const decider =
      this.oneLine(this.person(deciderId, names)?.name) || 'Someone';
    const imageName = this.imageName(image);
    const approved = row.status === 'approved';
    const verb = approved ? 'approved' : 'rejected';
    const spaceName = this.oneLine(space?.name) || 'your space';
    const outcome = approved
      ? `${imageName} can now run in ${spaceName}.`
      : `${imageName} can't run in ${spaceName}. Reason: ${row.reason ?? ''}`;
    const common = {
      type: APPROVAL_DECIDED_TYPE,
      spaceKey: space?.key ?? null,
      actorId: deciderId,
      actorName: decider,
    };

    if (row.requested_by && row.requested_by !== deciderId) {
      await this.send(row, [row.requested_by], {
        ...common,
        title: `${decider} ${verb} your custom Docker image`,
        body: outcome,
      });
    }

    // Only people who really got the "please approve" notice need to hear it is closed.
    if (!row.notified_at) return;

    await this.send(
      row,
      managers.filter((id) => id !== deciderId && id !== row.requested_by),
      {
        ...common,
        title: `${decider} ${verb} a custom Docker image you were asked about`,
        body: `${outcome} Nothing more is needed from you.`,
      },
    );
  }

  /** A bell row for people who keep the bell on; email follows each person's own email switch. */
  private async send(
    row: ApprovalRow,
    userIds: string[],
    notice: {
      type: string;
      title: string;
      body: string;
      spaceKey: string | null;
      actorId: string | null;
      actorName: string;
    },
  ): Promise<number> {
    const people = [...new Set(userIds)];

    if (people.length === 0) return 0;

    const bellOff = await this.bellOff(row.organization_id, people);
    const metadata = {
      ...(notice.spaceKey && {
        link: `/spaces/${notice.spaceKey}/test-management?imageApproval=${row.image_id}`,
        space_key: notice.spaceKey,
      }),
      space_id: row.space_id,
      image_id: row.image_id,
      approval_id: row.id,
      actor_user_id: notice.actorId,
      actor_name: notice.actorName,
    };
    const base = (userId: string) => ({
      organization_id: row.organization_id,
      user_id: userId,
      type: notice.type,
      title: notice.title,
      body: notice.body,
      is_read: false,
      action_status: 'none',
      reference_type: IMAGE_REFERENCE_TYPE,
      reference_id: row.image_id,
      metadata,
    });
    const bell = people.filter((id) => !bellOff.has(id));
    let inserted: Record<string, unknown>[] = [];

    if (bell.length > 0) {
      const { data, error } = await this.client
        .from('notifications')
        .insert(bell.map(base))
        .select();

      if (error) {
        this.logger.warn(`Image approval notice failed: ${error.message}`);
      } else {
        inserted = (data ?? []) as Record<string, unknown>[];
      }
    }

    for (const notification of inserted) {
      void this.broadcast?.broadcastNotification(notification);
    }

    const emailOnly = people.filter((id) => bellOff.has(id));

    // People with the bell off can still get the email.
    void this.email?.emailForNotifications([
      ...inserted,
      ...emailOnly.map(base),
    ]);

    return inserted.length + emailOnly.length;
  }

  private async bellOff(
    organizationId: string,
    userIds: string[],
  ): Promise<Set<string>> {
    const { data, error } = await this.client
      .from('notification_preferences')
      .select('user_id, in_app')
      .eq('organization_id', organizationId)
      .eq('notification_type', APPROVAL_PREFERENCE)
      .in('user_id', userIds);

    if (error) return new Set();

    return new Set(
      ((data ?? []) as { user_id: string; in_app: boolean }[])
        .filter((row) => row.in_app === false)
        .map((row) => row.user_id),
    );
  }

  private async approvalRow(
    organizationId: string,
    spaceId: string,
    imageId: string,
  ): Promise<ApprovalRow | null> {
    const { data, error } = await this.client
      .from(APPROVALS_TABLE)
      .select(APPROVAL_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('image_id', imageId)
      .maybeSingle();

    if (error) {
      if (isMissingSchema(error.code)) return null;

      throw tmDbError(this.logger, 'load image approval', error);
    }

    return data as unknown as ApprovalRow | null;
  }

  private async imageSummary(
    organizationId: string,
    imageId: string,
  ): Promise<ImageSummaryRow | null> {
    const { data, error } = await this.client
      .from(IMAGES_TABLE)
      .select(IMAGE_SUMMARY_COLUMNS)
      .eq('id', imageId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load custom image', error);

    return data as unknown as ImageSummaryRow | null;
  }

  private async space(
    spaceId: string,
  ): Promise<{ key: string; name: string } | null> {
    const { data } = await this.client
      .from('spaces')
      .select('key, name')
      .eq('id', spaceId)
      .maybeSingle();

    return data as { key: string; name: string } | null;
  }

  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];

    if (wanted.length === 0) return new Map();

    const { data } = await this.client
      .from('users')
      .select('id, first_name, last_name, email')
      .in('id', wanted);

    return new Map(
      (
        (data ?? []) as {
          id: string;
          first_name: string | null;
          last_name: string | null;
          email: string | null;
        }[]
      ).map((row) => [
        row.id,
        `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() ||
          row.email ||
          'Someone',
      ]),
    );
  }

  private person(
    id: string | null,
    names: Map<string, string>,
  ): PersonRef | null {
    return id ? { id, name: names.get(id) ?? 'Someone' } : null;
  }

  // Stored names can carry stray spaces, which show up in notification text.
  private oneLine(text: string | null | undefined): string {
    return (text ?? '').replace(/\s+/g, ' ').trim();
  }

  // The name people know the image by, with the short digest.
  private imageName(image: ImageSummaryRow): string {
    const name =
      image.registry === 'upload'
        ? image.repository
        : `${image.registry === 'docker.io' ? '' : `${image.registry}/`}${image.repository.replace(/^library\//, '')}`;

    return `${name} (${image.digest.slice(0, 19)})`;
  }
}
