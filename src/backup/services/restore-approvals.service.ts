/**
 * @fileoverview One organization asking another to accept a restore into it.
 * @module src/backup/services/restore-approvals
 *
 * A restore writes into the organization the session is in. When an operator picks a different one,
 * that is not a destination the engine can honour by itself — the archived rows carry the ids of the
 * tenant they came from — and it is also not a decision the requesting organization gets to make
 * alone. This service is the consent record: organization A asks, an owner of organization B
 * decides, and only an approved, unexpired, unconsumed request lets a restore aim across the line.
 *
 * Three rules are enforced in the DATABASE rather than here, because this service talks to Postgres
 * with the service-role client and RLS is therefore not a boundary (see the migration header):
 * the requester must belong to both organizations, a decider must be an active owner of the target,
 * and an approval must record which organization its decider acted for. The checks in this file
 * exist to produce a readable error, not to be the only thing standing there.
 */

import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { crossOrgRestorableTables } from '../engine/restore-id-remapper';
import { tableEntry } from '../registry/component-registry';

const REQUESTS_TABLE = 'restore_approval_requests';
const MEMBERS_TABLE = 'organization_members';
const ARTIFACTS_TABLE = 'backup_artifacts';
const NOTIFICATIONS_TABLE = 'notifications';
const ORGANIZATIONS_TABLE = 'organizations';

/**
 * Where a restore-approval notification takes the reader.
 *
 * The Restore sub-tab of Tenant Config, which is where both the incoming queue an owner decides
 * from and the outgoing list a requester watches are rendered. Carried as `metadata.link` because
 * that takes priority over every other rule in `getNotificationLink` — so neither link resolver,
 * frontend or backend, needs to learn about this notification type.
 */
const RESTORE_SECTION_LINK = '/tenant-config?tab=backup&section=restore';

/**
 * Tables a cross-organization restore may carry.
 *
 * Writing into another tenant needs every id in the row rewritten. Anything outside this set is
 * refused when the request is RAISED, so an owner is never asked to approve something the engine
 * would then decline to do.
 *
 * Asked of the engine rather than restated here — `remapSpecFor` is the same function the writer
 * uses to decide whether it can move a row, so the gate and the engine cannot disagree. They did:
 * this was `Object.keys(CROSS_ORG_REMAP_SPECS)`, a list of thirteen hand-written specs, and when the
 * engine began deriving specs from the schema this set stayed behind. The result was a request for
 * `form_builder_fields` refused at the door by a rule that no longer described what the engine could
 * do — while the writer's own fail-closed check, the one this set exists to keep unreachable, had
 * quietly stopped being the thing that protected the boundary.
 *
 * Still a tenant boundary, not a convenience: a table appears here only because the engine can
 * genuinely rewrite every id in it, and credentials are cleared on the way across regardless
 * (`SECRET_COLUMNS` in `restore-id-remapper.ts`), or the table is refused outright where the
 * credential is `NOT NULL` and so cannot be left behind (`MANDATORY_SECRET_TABLES`).
 *
 * The derivation now lives in `crossOrgRestorableTables()` because it has a second consumer: the
 * component tree served to the restore picker. The picker used to carry its own four-name literal,
 * which is the same drift this docblock describes, one layer up — it hid forty-nine of fifty-two
 * areas from a cross-organization restore. Both ends read this function so they cannot disagree.
 */
const CROSS_ORG_SUPPORTED_TABLES = crossOrgRestorableTables();

/**
 * The same boundary for a request that RECREATES the archived spaces rather than folding onto one.
 *
 * Differs by exactly one member, `spaces`, and is a separate set rather than a widening of the one
 * above so a FOLDING request cannot pick up the extra name. That distinction is the whole point:
 * folding gives every row the destination space the operator chose, so a `spaces` row has nowhere to
 * be written and letting it through would produce a request the engine refuses row by row.
 *
 * Which of the two applies is decided by `destinationSpaceId` alone — see `supportedTablesFor`.
 */
const RECREATE_SPACES_SUPPORTED_TABLES = crossOrgRestorableTables(true);

/**
 * Which boundary this request is judged against.
 *
 * The absence of a destination space IS the recreate mode, everywhere in the restore path. Asked
 * here in exactly the form `BackupRestoreService` asks it, because these two must agree: the gate
 * deciding what may be approved and the engine deciding what may be written are the same rule seen
 * from two ends, and the last time they drifted a legitimate selection was refused at the door.
 */
function supportedTablesFor(
  destinationSpaceId?: string | null,
): ReadonlySet<string> {
  return destinationSpaceId
    ? CROSS_ORG_SUPPORTED_TABLES
    : RECREATE_SPACES_SUPPORTED_TABLES;
}

export interface CreateApprovalRequestInput {
  targetOrganizationId: string;
  targetId: string;
  artifactId: string;
  tables: string[];
  sourceSpaceId?: string;
  destinationSpaceId?: string;

  /**
   * Whether the requester is asking to carry identity-tier rows across.
   *
   * A separate question from the table list, and asked of the OWNER being written into: restoring
   * roles and memberships changes who can act in their organization, because `users` is global and
   * `organization_members` is the grant itself.
   */
  includeIdentity?: boolean;
  note?: string;
}

export interface RestoreApprovalRequestRow {
  id: string;
  requesting_organization_id: string;
  target_organization_id: string;
  requested_by: string | null;
  target_id: string | null;
  artifact_id: string | null;
  selection: Record<string, unknown>;
  selection_fingerprint: string;

  /** Whether the owner consented to identity rows landing in their organization. */
  include_identity: boolean;
  request_snapshot: Record<string, unknown>;
  status: string;
  decided_by: string | null;
  decided_by_organization_id: string | null;
  decided_at: string | null;
  decision_note: string | null;
  self_approved: boolean;
  consumed_by_run_id: string | null;
  expires_at: string;
  created_at: string;
}

/**
 * What an approval covers, hashed so it can be compared cheaply at run time.
 *
 * An approval must authorise exactly what the approver was shown. Binding only to the archive id
 * would let an approved `tasks` restore be replayed later as a `wiki` restore from the same file.
 */
export function fingerprintSelection(input: {
  tables: string[];
  sourceSpaceId?: string | null;
  destinationSpaceId?: string | null;

  /**
   * Whether the owner was asked about identity-tier rows.
   *
   * Part of the fingerprint because it is a different question from the table list. Two requests
   * naming the same tables are not the same request if one of them also puts people into the
   * approver's organization, and without this an approval granted for content could be consumed by
   * a run that carries memberships.
   */
  includeIdentity?: boolean;
}): string {
  const canonical = JSON.stringify({
    tables: [...input.tables].sort(),
    source_space_id: input.sourceSpaceId ?? null,
    destination_space_id: input.destinationSpaceId ?? null,

    // Present ONLY when true, so the hash of a non-identity selection is byte-identical to what
    // this function produced before the field existed. Approvals already pending when this shipped
    // keep verifying; adding the key unconditionally would have recomputed every stored fingerprint
    // to a new value and silently made every outstanding approval unusable.
    ...(input.includeIdentity ? { include_identity: true } : {}),
  });

  return createHash('sha256').update(canonical).digest('hex');
}

@Injectable()
export class RestoreApprovalsService {
  private readonly logger = new Logger(RestoreApprovalsService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Raises a request for organization B to accept a restore from organization A.
   *
   * Everything that can be known to be impossible is refused here, before an owner is asked to look
   * at it: an unsupported table set, a target with nobody able to decide, a missing destination
   * space. An owner's attention is not the place to discover that the engine was never going to do
   * this.
   */
  async create(
    requestingOrganizationId: string,
    userId: string,
    input: CreateApprovalRequestInput,
  ): Promise<{ id: string }> {
    if (input.targetOrganizationId === requestingOrganizationId) {
      throw new BadRequestException(
        'That is the organization you are already working in, so no approval is needed.',
      );
    }

    if (!input.tables.length) {
      throw new BadRequestException('Choose at least one table to restore.');
    }

    const supported = supportedTablesFor(input.destinationSpaceId);

    const unsupported = input.tables.filter((table) => !supported.has(table));

    if (unsupported.length) {
      // Only the names that were refused. This used to append the whole supported set, which was
      // readable when that set was thirteen tables and is a wall of ~176 names now that it is
      // derived from the registry — in a toast, that buries the four words the operator needs.
      throw new BadRequestException(
        `${unsupported
          .sort()
          .join(
            ', ',
          )} cannot be restored into another organization. Untick them and try again, or restore ` +
          'this archive into your own organization instead.',
      );
    }

    // Identity tables are structurally re-keyable, so `CROSS_ORG_SUPPORTED_TABLES` above lets them
    // through — it is derived from `remapSpecFor`, which asks whether a row CAN be moved, not
    // whether it should be. Users, roles and memberships answer yes to the first question and no to
    // the second: carrying them across would make org A's people members of org B.
    //
    // Refused at the approval gate as well as before the plan, because this is where an owner is
    // asked to authorise something, and an approval that could never be honoured is worse than a
    // refusal — it reads as permission.
    const identityTables = input.tables.filter(
      (table) => tableEntry(table)?.tier === 'identity',
    );

    // Refused only when the request has NOT asked for identity. Asking for it is not permission to
    // have it — it puts the question to the owner of the receiving organization, whose approval is
    // the control. The flag is part of the fingerprint below, so an approval granted without it can
    // never be consumed by a run that carries memberships.
    if (identityTables.length && !input.includeIdentity) {
      throw new BadRequestException(
        `${identityTables
          .sort()
          .join(
            ', ',
          )} hold users, roles and memberships. Ask for them explicitly, or untick them and try again.`,
      );
    }

    // A cross-organization restore rewrites every row's space, because the archived one belongs to
    // the organization the rows came from and does not exist in the destination. Without a space to
    // point at there is nowhere coherent to put them.
    if (!input.destinationSpaceId) {
      throw new BadRequestException(
        'Choose the space in the other organization these rows should land in.',
      );
    }

    await this.assertCallerBelongsTo(userId, input.targetOrganizationId);
    await this.assertSpaceBelongsTo(
      input.destinationSpaceId,
      input.targetOrganizationId,
    );

    const owners = await this.activeOwnersOf(input.targetOrganizationId);

    if (!owners.length) {
      throw new BadRequestException(
        'That organization has no active owner, so there is nobody who can approve this restore.',
      );
    }

    const snapshot = await this.buildSnapshot(
      requestingOrganizationId,
      input.targetId,
      input.artifactId,
      input.tables,
    );

    const selection = {
      tables: input.tables,
      source_space_id: input.sourceSpaceId ?? null,
      destination_space_id: input.destinationSpaceId,
      note: input.note ?? null,
    };

    const { data, error } = (await this.db
      .from(REQUESTS_TABLE)
      .insert({
        requesting_organization_id: requestingOrganizationId,
        target_organization_id: input.targetOrganizationId,
        requested_by: userId,
        target_id: input.targetId,
        artifact_id: input.artifactId,
        selection,
        selection_fingerprint: fingerprintSelection({
          tables: input.tables,
          sourceSpaceId: input.sourceSpaceId,
          destinationSpaceId: input.destinationSpaceId,
          includeIdentity: input.includeIdentity,
        }),
        include_identity: Boolean(input.includeIdentity),
        request_snapshot: snapshot,
        status: 'pending',
      })
      .select('id')
      .single()) as unknown as {
      data: { id: string } | null;
      error: { code?: string; message: string } | null;
    };

    if (error || !data) {
      // The partial unique index on (requesting org, target org, artifact) WHERE pending.
      if (error?.code === '23505') {
        throw new BadRequestException(
          'You have already asked that organization about this archive. Wait for their answer, or cancel it first.',
        );
      }

      throw new BadRequestException(
        error?.message ?? 'The approval request could not be created.',
      );
    }

    await this.notifyOwners(
      input.targetOrganizationId,
      owners,
      data.id,
      snapshot,
    );

    return { id: data.id };
  }

  /** Requests aimed at this organization — what its owners have to decide. */
  async listIncoming(
    organizationId: string,
    limit = 50,
  ): Promise<RestoreApprovalRequestRow[]> {
    const { data } = (await this.db
      .from(REQUESTS_TABLE)
      .select('*')
      .eq('target_organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(limit)) as unknown as {
      data: RestoreApprovalRequestRow[] | null;
    };

    return data ?? [];
  }

  /** Requests this organization has raised, and where they got to. */
  async listOutgoing(
    organizationId: string,
    limit = 50,
  ): Promise<RestoreApprovalRequestRow[]> {
    const { data } = (await this.db
      .from(REQUESTS_TABLE)
      .select('*')
      .eq('requesting_organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(limit)) as unknown as {
      data: RestoreApprovalRequestRow[] | null;
    };

    return data ?? [];
  }

  /**
   * Approves or rejects a request aimed at this organization.
   *
   * Self-approval is allowed and recorded rather than prevented: someone who owns both
   * organizations already holds the authority on both sides, and requiring a second person to
   * authorise what they could do themselves is friction rather than control. `self_approved` makes
   * it visible in the history instead of silent.
   */
  async decide(
    organizationId: string,
    userId: string,
    id: string,
    approve: boolean,
    note?: string,
  ): Promise<RestoreApprovalRequestRow> {
    const request = await this.getForTarget(organizationId, id);

    if (request.status !== 'pending') {
      throw new BadRequestException(
        `This request is already ${request.status}, so there is nothing to decide.`,
      );
    }

    if (new Date(request.expires_at).getTime() <= Date.now()) {
      await this.markExpired(id);

      throw new BadRequestException(
        'This request has expired. Ask the other organization to raise a new one.',
      );
    }

    const { data, error } = (await this.db
      .from(REQUESTS_TABLE)
      .update({
        status: approve ? 'approved' : 'rejected',
        decided_by: userId,
        decided_by_organization_id: organizationId,
        decided_at: new Date().toISOString(),
        decision_note: note ?? null,
        self_approved: approve && request.requested_by === userId,
      })
      .eq('id', id)
      // Re-asserted so two owners deciding at once cannot both win.
      .eq('status', 'pending')
      .select('*')
      .maybeSingle()) as unknown as {
      data: RestoreApprovalRequestRow | null;
      error: { message: string } | null;
    };

    if (error) {
      // The trigger raises `insufficient_privilege` when the decider is not an active owner.
      throw new ForbiddenException(
        'You are not able to decide this restore for this organization.',
      );
    }

    if (!data) {
      throw new BadRequestException(
        'Someone else answered this request first.',
      );
    }

    await this.notifyRequester(data);

    return data;
  }

  /** The requester giving up on an unanswered ask. Needs nobody's permission. */
  async cancel(
    organizationId: string,
    id: string,
  ): Promise<{ detail: string }> {
    const { data } = (await this.db
      .from(REQUESTS_TABLE)
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('requesting_organization_id', organizationId)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()) as unknown as { data: { id: string } | null };

    if (!data) {
      throw new BadRequestException(
        'That request is not pending, so there is nothing to cancel.',
      );
    }

    return { detail: 'The request was withdrawn.' };
  }

  /**
   * The approval a restore may proceed on, or null.
   *
   * Everything is re-checked at use rather than trusted from the moment of approval: an owner may
   * have approved days ago, and membership, expiry and the selection can all have moved since.
   */
  async findUsableApproval(
    requestingOrganizationId: string,
    targetOrganizationId: string,
    artifactId: string,
    fingerprint: string,
  ): Promise<RestoreApprovalRequestRow | null> {
    const { data } = (await this.db
      .from(REQUESTS_TABLE)
      .select('*')
      .eq('requesting_organization_id', requestingOrganizationId)
      .eq('target_organization_id', targetOrganizationId)
      .eq('artifact_id', artifactId)
      .eq('selection_fingerprint', fingerprint)
      .eq('status', 'approved')
      .order('decided_at', { ascending: false })
      .limit(1)
      .maybeSingle()) as unknown as {
      data: RestoreApprovalRequestRow | null;
    };

    if (!data) {
      return null;
    }

    if (new Date(data.expires_at).getTime() <= Date.now()) {
      await this.markExpired(data.id);

      return null;
    }

    return data;
  }

  /**
   * Binds an approval to the run that used it, so it cannot authorise a second restore.
   *
   * Conditional on the row still being `approved`, so two runs racing for the same approval end
   * with exactly one of them holding it.
   */
  async consume(id: string, runId: string): Promise<boolean> {
    const { data } = (await this.db
      .from(REQUESTS_TABLE)
      .update({ status: 'consumed', consumed_by_run_id: runId })
      .eq('id', id)
      .eq('status', 'approved')
      .select('id')
      .maybeSingle()) as unknown as { data: { id: string } | null };

    return Boolean(data);
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private async getForTarget(
    organizationId: string,
    id: string,
  ): Promise<RestoreApprovalRequestRow> {
    const { data } = (await this.db
      .from(REQUESTS_TABLE)
      .select('*')
      .eq('id', id)
      .eq('target_organization_id', organizationId)
      .maybeSingle()) as unknown as {
      data: RestoreApprovalRequestRow | null;
    };

    if (!data) {
      throw new NotFoundException('That restore request was not found.');
    }

    return data;
  }

  private async markExpired(id: string): Promise<void> {
    await this.db
      .from(REQUESTS_TABLE)
      .update({ status: 'expired' })
      .eq('id', id)
      .eq('status', 'pending');
  }

  private async assertCallerBelongsTo(
    userId: string,
    organizationId: string,
  ): Promise<void> {
    const { data } = (await this.db
      .from(MEMBERS_TABLE)
      .select('organization_id')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as unknown as {
      data: { organization_id: string } | null;
    };

    // Deliberately the same answer as "no such organization": a caller who is not a member learns
    // nothing about whether it exists.
    if (!data) {
      throw new NotFoundException(
        'That organization is not one you belong to.',
      );
    }
  }

  private async assertSpaceBelongsTo(
    spaceId: string,
    organizationId: string,
  ): Promise<void> {
    const { data } = (await this.db
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as unknown as { data: { id: string } | null };

    if (!data) {
      throw new BadRequestException(
        'That space is not in the organization you are asking to restore into.',
      );
    }
  }

  /**
   * Owners who could actually answer.
   *
   * Deactivated owners are excluded: routing consent to an account nobody signs into is the same as
   * having no control at all, and it would leave the requester waiting on a decision that can never
   * come.
   */
  private async activeOwnersOf(organizationId: string): Promise<string[]> {
    const { data } = (await this.db
      .from(MEMBERS_TABLE)
      .select('user_id, users!inner(is_active)')
      .eq('organization_id', organizationId)
      .eq('role', 'owner')
      .eq('users.is_active', true)) as unknown as {
      data: { user_id: string }[] | null;
    };

    return (data ?? []).map((row) => row.user_id);
  }

  /**
   * What the approver is shown.
   *
   * Captured now, not joined later: `backup_artifacts` is scoped by organization, so the target
   * organization genuinely cannot read the source archive's row. Kept narrow on purpose — this is
   * one tenant's data being put in front of another, so it carries what is needed to make a
   * decision and nothing more.
   */
  private async buildSnapshot(
    requestingOrganizationId: string,
    targetId: string,
    artifactId: string,
    tables: string[],
  ): Promise<Record<string, unknown>> {
    const { data: artifact } = (await this.db
      .from(ARTIFACTS_TABLE)
      .select('id, remote_path, byte_size, is_encrypted, created_at')
      .eq('id', artifactId)
      .eq('organization_id', requestingOrganizationId)
      .eq('target_id', targetId)
      .is('deleted_at', null)
      .maybeSingle()) as unknown as {
      data: {
        remote_path: string | null;
        byte_size: number | null;
        is_encrypted: boolean | null;
        created_at: string | null;
      } | null;
    };

    if (!artifact) {
      throw new NotFoundException('Archive not found');
    }

    const { data: organization } = (await this.db
      .from(ORGANIZATIONS_TABLE)
      .select('name, slug')
      .eq('id', requestingOrganizationId)
      .maybeSingle()) as unknown as {
      data: { name: string; slug: string } | null;
    };

    return {
      // Only the file name, never the full remote path — the path describes the requesting
      // organization's storage layout and the approver has no use for it.
      archive_name: artifact.remote_path?.split('/').pop() ?? null,
      archive_created_at: artifact.created_at,
      archive_byte_size: artifact.byte_size,
      archive_is_encrypted: artifact.is_encrypted,
      tables,
      requesting_organization_name: organization?.name ?? null,
      requesting_organization_slug: organization?.slug ?? null,
    };
  }

  /**
   * Tells the target organization's owners there is something to decide.
   *
   * `organization_id` is the RECIPIENT's organization, not the requester's — the notifications list
   * filters by the reader's session organization, so a row stamped with the wrong one is invisible
   * to the very person it was written for.
   *
   * The requester is NOT filtered out here, unlike the module's other fan-out: when someone owns
   * both organizations they are a legitimate approver of their own request, and dropping them would
   * leave the request with no notification at all.
   */
  private async notifyOwners(
    targetOrganizationId: string,
    owners: string[],
    requestId: string,
    snapshot: Record<string, unknown>,
  ): Promise<void> {
    // The snapshot is untyped jsonb, so `??` alone is not enough: a non-string under this key
    // stringifies to '[object Object]' in the body an owner actually reads.
    const requester = snapshot.requesting_organization_name;

    const from =
      typeof requester === 'string' && requester.trim()
        ? requester
        : 'Another organization';

    const rows = owners.map((userId) => ({
      organization_id: targetOrganizationId,
      user_id: userId,
      type: 'restore_approval_requested',
      title: 'A restore is waiting for your approval',
      body: `${from} has asked to restore a backup into your organization.`,
      reference_type: 'restore_approval_request',
      reference_id: requestId,
      // Lands on the Restore tab, where the incoming queue with its Approve/Reject buttons is. A
      // notification an owner cannot act on from is only half a notification.
      metadata: { link: RESTORE_SECTION_LINK },
      // Decided from that screen, not from the bell: the notification action handler only knows how
      // to accept space invitations.
      action_status: 'none',
    }));

    const { error } = (await this.db
      .from(NOTIFICATIONS_TABLE)
      .insert(rows)) as unknown as { error: { message: string } | null };

    // Failing to announce a request must not fail the request — it is still in the owner's list.
    if (error) {
      this.logger.warn(
        `Could not notify owners of ${targetOrganizationId}: ${error.message}`,
      );
    }
  }

  /** Tells the requester what was decided, in their own organization's notifications. */
  private async notifyRequester(
    request: RestoreApprovalRequestRow,
  ): Promise<void> {
    if (!request.requested_by) {
      return;
    }

    const approved = request.status === 'approved';

    const { error } = (await this.db.from(NOTIFICATIONS_TABLE).insert({
      organization_id: request.requesting_organization_id,
      user_id: request.requested_by,
      type: 'restore_approval_decided',
      title: approved
        ? 'Your restore request was approved'
        : 'Your restore request was rejected',
      body:
        request.decision_note ??
        (approved
          ? 'You can now run the restore you asked about.'
          : 'The other organization did not accept this restore.'),
      reference_type: 'restore_approval_request',
      reference_id: request.id,
      // Same destination: an approved request grows a Restore button in the outgoing list there,
      // which is the next thing the requester has to do.
      metadata: { link: RESTORE_SECTION_LINK },
      action_status: 'none',
    })) as unknown as { error: { message: string } | null };

    if (error) {
      this.logger.warn(
        `Could not notify the requester of ${request.id}: ${error.message}`,
      );
    }
  }
}
