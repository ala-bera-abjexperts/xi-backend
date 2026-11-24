/**
 * @fileoverview Service that creates, stops, lists, and inspects Super-Admin
 * impersonation sessions in `public.impersonation_sessions`. All DB access uses
 * the service-role client (RLS-bypassing) because impersonation rows are
 * platform-internal — RLS on the table is defense-in-depth only.
 *
 * The raw session token is generated here and returned to the controller ONCE
 * (to be written as an HttpOnly cookie). Only its sha256 hash (`token_hash`) is
 * persisted; the raw value is never logged.
 *
 * @module src/impersonation/impersonation.service
 * @author Prince Jadiya
 */

import * as crypto from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { StartImpersonationDto } from './dto/start-impersonation.dto';
import type { ImpersonationHistoryQueryDto } from './dto/impersonation-history-query.dto';

/** UUID of the platform "super tenant" — impersonation inside it is forbidden. */
const SUPER_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Hard ceiling (minutes) on any impersonation session, mirrors DB CHECK. */
const MAX_DURATION_MINUTES = 30;

/** Default session duration (minutes) when the caller omits one. */
const DEFAULT_DURATION_MINUTES = 30;

/** Postgres unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = '23505';

/** Name of the partial unique index that enforces ≤1 active session per SA. */
const ONE_ACTIVE_PER_ADMIN_IDX =
  'impersonation_sessions_one_active_per_admin_idx';

/**
 * Exact column set of `public.impersonation_sessions`. Supabase admin-client
 * results are `any`; every read is cast to this interface (or `EnrichedSessionRow`)
 * so downstream member access stays type-safe under `no-unsafe-*`.
 */
export interface ImpersonationSessionRow {
  id: string;
  super_admin_user_id: string;
  super_admin_auth_user_id: string;
  target_user_id: string;
  target_organization_id: string;
  target_membership_role: 'owner' | 'admin' | 'member' | 'viewer';
  reason: string;
  write_access: boolean;
  ip_address: string | null;
  user_agent: string | null;
  token_hash: string;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  ended_reason: string | null;
}

/**
 * A session row enriched with the human-readable SA / target / organization
 * fields needed by the admin history table. Joined-in columns are nullable
 * because the FK rows use `ON DELETE SET NULL` and may have been removed.
 */
export interface EnrichedSessionRow extends ImpersonationSessionRow {
  super_admin_email: string | null;
  super_admin_name: string | null;
  target_user_email: string | null;
  target_user_name: string | null;
  target_organization_name: string | null;
  target_organization_slug: string | null;
}

/**
 * Compact envelope describing the active impersonation session for a given SA,
 * consumed by Phase 4's bootstrap to render the impersonation banner.
 */
export interface ImpersonationEnvelope {
  sessionId: string;
  reason: string;
  writeAccess: boolean;
  expiresAt: string;
  startedAt: string;
  realUser: { id: string; email: string };
  targetUser: {
    id: string;
    email: string;
    name: string | null;
    organizationId: string;
    organizationName: string | null;
    organizationSlug: string | null;
    membershipRole: 'owner' | 'admin' | 'member' | 'viewer';
  };
}

/** Minimal `users` shape read for target validation and enrichment. */
interface TargetUserLookupRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: string | null;
  is_active: boolean | null;
  auth_user_id: string | null;
}

/** Minimal `organizations` shape read for target validation and slug resolution. */
interface TargetOrgLookupRow {
  id: string;
  name: string | null;
  slug: string | null;
  is_active: boolean | null;
}

/** Minimal `organization_members` shape read for the membership check. */
interface MembershipLookupRow {
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

/** Joined `users` shape (SA or target) as returned by the history embed. */
interface JoinedUserRow {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}

/** Joined `organizations` shape as returned by the history embed. */
interface JoinedOrgRow {
  name: string | null;
  slug: string | null;
}

/** Raw history row before flattening the embedded joins. */
interface HistoryJoinRow extends ImpersonationSessionRow {
  super_admin: JoinedUserRow | JoinedUserRow[] | null;
  target_user: JoinedUserRow | JoinedUserRow[] | null;
  target_organization: JoinedOrgRow | JoinedOrgRow[] | null;
}

@Injectable()
export class ImpersonationService {
  private readonly logger = new Logger(ImpersonationService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Starts a new impersonation session.
   *
   * Validates the target, snapshots the membership role, auto-stops any
   * in-flight session for the SA, inserts the row, and returns the raw token
   * (cookie value) plus the slug/name/email the controller needs for the
   * redirect. On any validation failure it writes a `rejected` row first so the
   * attempt is auditable, then throws.
   *
   * @param superAdminUserId - `public.users.id` of the calling SA
   * @param superAdminAuthUserId - `auth.users.id` of the calling SA (forensic)
   * @param superAdminEmail - SA email (forensic; not persisted on the row)
   * @param dto - Validated request body
   * @param req - Forensic request metadata (ip, user-agent)
   * @returns The raw token, expiry, inserted row, and target descriptors
   * @throws {BadRequestException} On self-impersonation, super-tenant, missing/inactive target, or non-membership
   * @throws {ForbiddenException} When the target is another Super Admin
   * @throws {ConflictException} When a concurrent insert wins the unique index race
   */
  async start(
    superAdminUserId: string,
    superAdminAuthUserId: string,
    superAdminEmail: string,
    dto: StartImpersonationDto,
    req: { ip?: string; userAgent?: string },
  ): Promise<{
    token: string;
    expiresAt: string;
    session: ImpersonationSessionRow;
    targetSlug: string;
    targetTenantName: string;
    targetUserEmail: string;
  }> {
    // R2 — cannot impersonate yourself.
    if (dto.targetUserId === superAdminUserId) {
      throw new BadRequestException('Cannot impersonate yourself');
    }

    // R3 — cannot impersonate inside the platform super tenant.
    if (dto.tenantId === SUPER_TENANT_ID) {
      throw new BadRequestException(
        'Cannot impersonate inside the super tenant',
      );
    }

    // Load target user.
    const userResult = await this.client
      .from('users')
      .select('id, email, first_name, last_name, role, is_active, auth_user_id')
      .eq('id', dto.targetUserId)
      .maybeSingle();
    const targetUser = userResult.data as TargetUserLookupRow | null;

    // R4 — reject impersonating another SA (public.users.role OR auth app_metadata).
    if (targetUser) {
      let authIsSuperAdmin = false;

      if (targetUser.auth_user_id) {
        const authResult = await this.client.auth.admin.getUserById(
          targetUser.auth_user_id,
        );
        const appMetadata = authResult.data?.user?.app_metadata as
          | Record<string, unknown>
          | undefined;

        authIsSuperAdmin =
          appMetadata?.role === 'SUPER_ADMIN' ||
          appMetadata?.is_super_admin === true;
      }

      if (targetUser.role === 'SUPER_ADMIN' || authIsSuperAdmin) {
        throw new ForbiddenException('Cannot impersonate another Super Admin');
      }
    }

    // R5 — target user must exist and be active.
    if (!targetUser || targetUser.is_active !== true) {
      await this.writeRejectedRow(
        superAdminUserId,
        superAdminAuthUserId,
        dto,
        req,
        'member',
      );
      throw new BadRequestException('Target user not found / inactive');
    }

    // R6 — target tenant must exist and be active.
    const orgResult = await this.client
      .from('organizations')
      .select('id, name, slug, is_active')
      .eq('id', dto.tenantId)
      .maybeSingle();
    const targetOrg = orgResult.data as TargetOrgLookupRow | null;

    if (!targetOrg || targetOrg.is_active !== true) {
      await this.writeRejectedRow(
        superAdminUserId,
        superAdminAuthUserId,
        dto,
        req,
        'member',
      );
      throw new BadRequestException('Target user not found / inactive');
    }

    // R7 — target must be a member of the tenant; snapshot the role.
    const membershipResult = await this.client
      .from('organization_members')
      .select('role')
      .eq('user_id', dto.targetUserId)
      .eq('organization_id', dto.tenantId)
      .maybeSingle();
    const membership = membershipResult.data as MembershipLookupRow | null;

    if (!membership) {
      await this.writeRejectedRow(
        superAdminUserId,
        superAdminAuthUserId,
        dto,
        req,
        'member',
      );
      throw new BadRequestException('User is not a member of this tenant');
    }

    // R8 — best-effort auto-stop any in-flight session for this SA.
    try {
      await this.stopActiveForSuperAdmin(superAdminUserId, 'switched');
    } catch (err) {
      this.logger.warn(
        `Auto-stop of in-flight session failed for SA ${superAdminUserId}; proceeding with start`,
      );
      this.logger.debug(err);
    }

    // R1 — generate token; persist ONLY the sha256 hash.
    const raw = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');

    // R9 — duration capped at 30 min.
    const durationMinutes = Math.min(
      dto.durationMinutes ?? DEFAULT_DURATION_MINUTES,
      MAX_DURATION_MINUTES,
    );
    const startedAt = new Date();
    const expiresAtDate = new Date(
      startedAt.getTime() + durationMinutes * 60_000,
    );
    const expiresAt = expiresAtDate.toISOString();

    // R10 — insert; on unique violation map to 409.
    const insertResult = await this.client
      .from('impersonation_sessions')
      .insert({
        super_admin_user_id: superAdminUserId,
        super_admin_auth_user_id: superAdminAuthUserId,
        target_user_id: dto.targetUserId,
        target_organization_id: dto.tenantId,
        target_membership_role: membership.role,
        reason: dto.reason,
        write_access: dto.writeAccess ?? false,
        ip_address: req.ip ?? null,
        user_agent: req.userAgent ?? null,
        token_hash: tokenHash,
        started_at: startedAt.toISOString(),
        expires_at: expiresAt,
      })
      .select('*')
      .single();

    if (insertResult.error) {
      const code = insertResult.error.code;
      const message = insertResult.error.message ?? '';

      if (
        code === PG_UNIQUE_VIOLATION ||
        message.includes(ONE_ACTIVE_PER_ADMIN_IDX)
      ) {
        throw new ConflictException(
          'Another impersonation session is already active. Try again.',
        );
      }

      throw new BadRequestException(
        `Failed to start impersonation session: ${message}`,
      );
    }

    const row = insertResult.data as ImpersonationSessionRow;

    // R12 — audit on success; failure MUST NOT fail start.
    try {
      await this.auditLogs.logAction(
        dto.tenantId,
        superAdminUserId,
        'impersonation_session',
        row.id,
        'create',
        {
          reason: dto.reason,
          write_access: dto.writeAccess ?? false,
          duration_minutes: durationMinutes,
          target_user_id: dto.targetUserId,
        },
      );
    } catch (err) {
      this.logger.error('Failed to write impersonation start audit log', err);
    }

    // R11 — resolve target tenant slug/name for the controller.
    return {
      token: raw,
      expiresAt,
      session: row,
      targetSlug: targetOrg.slug ?? '',
      targetTenantName: targetOrg.name ?? '',
      targetUserEmail: targetUser.email,
    };
  }

  /**
   * Ends a session by id if still active. Idempotent: a second call (or a call
   * on an already-ended row) is a no-op. Audits on a real state change.
   *
   * @param sessionId - `impersonation_sessions.id`
   * @param reason - The `ended_reason` to record
   */
  async stop(
    sessionId: string,
    reason: 'user_stopped' | 'signed_out' | 'switched' | 'admin_panel_visit',
  ): Promise<void> {
    // R13 — only update rows that are still active; return the affected row.
    const result = await this.client
      .from('impersonation_sessions')
      .update({ ended_at: new Date().toISOString(), ended_reason: reason })
      .eq('id', sessionId)
      .is('ended_at', null)
      .select('*');

    const rows = (result.data ?? []) as unknown as ImpersonationSessionRow[];

    if (rows.length === 0) {
      // Idempotent no-op — already ended or not found.
      return;
    }

    const row = rows[0];

    try {
      await this.auditLogs.logAction(
        row.target_organization_id,
        row.super_admin_user_id,
        'impersonation_session',
        row.id,
        'update',
        { ended_reason: reason },
      );
    } catch (err) {
      this.logger.error('Failed to write impersonation stop audit log', err);
    }
  }

  /**
   * Resolves a raw token to its active session (by sha256 hash) and stops it.
   *
   * @param rawToken - The raw cookie value
   * @param reason - The `ended_reason` to record
   * @returns Whether a session was stopped and its id (if any)
   */
  async stopByToken(
    rawToken: string,
    reason: 'user_stopped' | 'signed_out' | 'switched' | 'admin_panel_visit',
  ): Promise<{ stopped: boolean; sessionId?: string }> {
    // R14 — hash, find active row, delegate to stop().
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');

    const result = await this.client
      .from('impersonation_sessions')
      .select('id')
      .eq('token_hash', tokenHash)
      .is('ended_at', null)
      .maybeSingle();

    const row = result.data as { id: string } | null;

    if (!row) {
      return { stopped: false };
    }

    await this.stop(row.id, reason);

    return { stopped: true, sessionId: row.id };
  }

  /**
   * Stops whatever active session the SA currently owns (≤1 by the partial
   * unique index). Used to clear in-flight state before switching tenants or on
   * admin-panel visits.
   *
   * @param superAdminUserId - `public.users.id` of the SA
   * @param reason - The `ended_reason` to record
   * @returns Number of rows ended (0 or 1)
   */
  async stopActiveForSuperAdmin(
    superAdminUserId: string,
    reason: 'switched' | 'admin_panel_visit' | 'signed_out',
  ): Promise<number> {
    // R15 — update active rows for this SA; the partial unique index ⇒ ≤1.
    const result = await this.client
      .from('impersonation_sessions')
      .update({ ended_at: new Date().toISOString(), ended_reason: reason })
      .eq('super_admin_user_id', superAdminUserId)
      .is('ended_at', null)
      .select('*');

    const rows = (result.data ?? []) as unknown as ImpersonationSessionRow[];

    for (const row of rows) {
      try {
        await this.auditLogs.logAction(
          row.target_organization_id,
          row.super_admin_user_id,
          'impersonation_session',
          row.id,
          'update',
          { ended_reason: reason },
        );
      } catch (err) {
        this.logger.error('Failed to write impersonation stop audit log', err);
      }
    }

    return rows.length;
  }

  /**
   * Returns the SA's single active, non-expired session (newest first), or null.
   *
   * @param superAdminUserId - `public.users.id` of the SA
   * @returns The active session row or null
   */
  async getActiveForSuperAdmin(
    superAdminUserId: string,
  ): Promise<ImpersonationSessionRow | null> {
    // R16 — active + not expired.
    const result = await this.client
      .from('impersonation_sessions')
      .select('*')
      .eq('super_admin_user_id', superAdminUserId)
      .is('ended_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return (result.data as ImpersonationSessionRow | null) ?? null;
  }

  /**
   * Loads a single session row by id.
   *
   * @param sessionId - `impersonation_sessions.id`
   * @returns The row or null
   */
  async getById(sessionId: string): Promise<ImpersonationSessionRow | null> {
    const result = await this.client
      .from('impersonation_sessions')
      .select('*')
      .eq('id', sessionId)
      .maybeSingle();

    return (result.data as ImpersonationSessionRow | null) ?? null;
  }

  /**
   * Lists impersonation sessions (newest first) with SA / target / org names,
   * filtered and paginated per the query DTO.
   *
   * @param query - Validated history filters
   * @returns Page of enriched rows plus total count
   */
  async listHistory(
    query: ImpersonationHistoryQueryDto,
  ): Promise<{ data: EnrichedSessionRow[]; total: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // R17 — join SA + target users and the target organization.
    let builder = this.client.from('impersonation_sessions').select(
      `*,
         super_admin:users!impersonation_sessions_super_admin_user_id_fkey ( email, first_name, last_name ),
         target_user:users!impersonation_sessions_target_user_id_fkey ( email, first_name, last_name ),
         target_organization:organizations!impersonation_sessions_target_organization_id_fkey ( name, slug )`,
      { count: 'exact' },
    );

    if (query.tenantId) {
      builder = builder.eq('target_organization_id', query.tenantId);
    }
    if (query.targetUserId) {
      builder = builder.eq('target_user_id', query.targetUserId);
    }
    if (query.superAdminUserId) {
      builder = builder.eq('super_admin_user_id', query.superAdminUserId);
    }
    if (query.activeOnly) {
      builder = builder.is('ended_at', null);
    }

    const result = await builder
      .order('started_at', { ascending: false })
      .range(from, to);

    const rows = (result.data ?? []) as unknown as HistoryJoinRow[];
    const data = rows.map((row) => this.flattenHistoryRow(row));

    return { data, total: result.count ?? 0 };
  }

  /**
   * Builds the bootstrap envelope for the SA's active session (Phase 4 consumer).
   *
   * @param superAdminUserId - `public.users.id` of the SA
   * @returns The envelope, or null when no active session exists
   */
  async getEnvelopeForSuperAdmin(
    superAdminUserId: string,
  ): Promise<ImpersonationEnvelope | null> {
    // R18 — active session + names; null when none.
    const session = await this.getActiveForSuperAdmin(superAdminUserId);

    if (!session) return null;

    const saResult = await this.client
      .from('users')
      .select('email, first_name, last_name')
      .eq('id', session.super_admin_user_id)
      .maybeSingle();
    const sa = saResult.data as JoinedUserRow | null;

    const targetResult = await this.client
      .from('users')
      .select('email, first_name, last_name')
      .eq('id', session.target_user_id)
      .maybeSingle();
    const target = targetResult.data as JoinedUserRow | null;

    const orgResult = await this.client
      .from('organizations')
      .select('name, slug')
      .eq('id', session.target_organization_id)
      .maybeSingle();
    const org = orgResult.data as JoinedOrgRow | null;

    return {
      sessionId: session.id,
      reason: session.reason,
      writeAccess: session.write_access,
      expiresAt: session.expires_at,
      startedAt: session.started_at,
      realUser: {
        id: session.super_admin_user_id,
        email: sa?.email ?? '',
      },
      targetUser: {
        id: session.target_user_id,
        email: target?.email ?? '',
        name: this.composeName(target?.first_name, target?.last_name),
        organizationId: session.target_organization_id,
        organizationName: org?.name ?? null,
        organizationSlug: org?.slug ?? null,
        membershipRole: session.target_membership_role,
      },
    };
  }

  /**
   * Writes a `rejected` row (a failed start attempt) so the attempt is
   * auditable. `started_at` and `ended_at` are both `now()`.
   *
   * @private
   */
  private async writeRejectedRow(
    superAdminUserId: string,
    superAdminAuthUserId: string,
    dto: StartImpersonationDto,
    req: { ip?: string; userAgent?: string },
    membershipRole: 'owner' | 'admin' | 'member' | 'viewer',
  ): Promise<void> {
    // A rejected row never carries a usable token, but token_hash is NOT NULL,
    // so store the hash of a throwaway random value.
    const throwawayHash = crypto
      .createHash('sha256')
      .update(crypto.randomBytes(32).toString('base64url'))
      .digest('hex');
    const now = new Date().toISOString();
    // expires_at must be > started_at (CHECK constraint) even for rejects.
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const insertResult = await this.client
      .from('impersonation_sessions')
      .insert({
        super_admin_user_id: superAdminUserId,
        super_admin_auth_user_id: superAdminAuthUserId,
        target_user_id: dto.targetUserId,
        target_organization_id: dto.tenantId,
        target_membership_role: membershipRole,
        reason: dto.reason,
        write_access: dto.writeAccess ?? false,
        ip_address: req.ip ?? null,
        user_agent: req.userAgent ?? null,
        token_hash: throwawayHash,
        started_at: now,
        expires_at: expiresAt,
        ended_at: now,
        ended_reason: 'rejected',
      });

    if (insertResult.error) {
      this.logger.warn(
        `Failed to write rejected impersonation row: ${insertResult.error.message}`,
      );
    }
  }

  /**
   * Flattens an embedded history row (Supabase returns embeds as object or
   * single-element array depending on relationship cardinality).
   *
   * @private
   */
  private flattenHistoryRow(row: HistoryJoinRow): EnrichedSessionRow {
    const sa = this.firstOrSelf(row.super_admin);
    const target = this.firstOrSelf(row.target_user);
    const org = this.firstOrSelf(row.target_organization);

    return {
      id: row.id,
      super_admin_user_id: row.super_admin_user_id,
      super_admin_auth_user_id: row.super_admin_auth_user_id,
      target_user_id: row.target_user_id,
      target_organization_id: row.target_organization_id,
      target_membership_role: row.target_membership_role,
      reason: row.reason,
      write_access: row.write_access,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      token_hash: row.token_hash,
      started_at: row.started_at,
      expires_at: row.expires_at,
      ended_at: row.ended_at,
      ended_reason: row.ended_reason,
      super_admin_email: sa?.email ?? null,
      super_admin_name: this.composeName(sa?.first_name, sa?.last_name),
      target_user_email: target?.email ?? null,
      target_user_name: this.composeName(target?.first_name, target?.last_name),
      target_organization_name: org?.name ?? null,
      target_organization_slug: org?.slug ?? null,
    };
  }

  /**
   * Returns the first element when given an array, the value itself otherwise.
   *
   * @private
   */
  private firstOrSelf<T>(value: T | T[] | null): T | null {
    if (Array.isArray(value)) return value[0] ?? null;

    return value;
  }

  /**
   * Joins first/last name into a single display name, or null when both blank.
   *
   * @private
   */
  private composeName(
    first: string | null | undefined,
    last: string | null | undefined,
  ): string | null {
    const name = [first, last].filter(Boolean).join(' ').trim();

    return name.length > 0 ? name : null;
  }
}
