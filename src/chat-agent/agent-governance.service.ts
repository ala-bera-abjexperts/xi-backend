import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PermissionsService } from '../permissions/permissions.service';
import {
  normalizeSpacePermissions,
  SPACE_PERMISSION_COLUMN_KEYS,
  SPACE_ROLE_BASE_PERMISSIONS,
} from '../permissions/models/space-permissions.model';
import { CreateProcessDto } from '../processes/dto/create-process.dto';
import { ProcessesService } from '../processes/processes.service';
import { CreateSpaceDto } from '../spaces/dto/create-space.dto';
import { SpaceMemberRulesService } from '../spaces/space-member-rules.service';
import { SpacesService } from '../spaces/spaces.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AgentRunsRepository } from './agent-runs.repository';
import {
  roleRank,
  type AgentMemberKind,
  type AgentSpaceRole,
} from './pipeline/agent-kinds';

/** The person asking, as the guarded writes need them. */
export interface AgentActor {
  userId: string;
  organizationId: string;
}

/** A stable reason the card can name; the write did not happen. */
export class AgentGovernanceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AgentGovernanceError';
  }
}

export interface AgentMemberChange {
  kind: AgentMemberKind;
  spaceId: string;
  userId: string;
  role?: AgentSpaceRole | null;
  grant?: string[];
  revoke?: string[];
}

const PROCESS_KEY_TRIES = 3;

const isInvalid = async (dto: object): Promise<boolean> =>
  (await validate(dto)).length > 0;

const flatKey = (key: string) => (key.startsWith('can_') ? key.slice(4) : key);

/**
 * Every write of Robert's that changes spaces, their members or processes. SpacesService and
 * ProcessesService check nothing themselves (the route guards do), so nothing here reaches them
 * before the same questions were asked about the person who confirmed.
 */
@Injectable()
export class AgentGovernanceService {
  private readonly logger = new Logger(AgentGovernanceService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
    private readonly spaces: SpacesService,
    private readonly processes: ProcessesService,
    private readonly runs: AgentRunsRepository,
    private readonly audit: AuditLogsService,
    private readonly rules: SpaceMemberRulesService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ---------------------------------------------------------------------------
  // Questions (asked for the card and again right before each write)
  // ---------------------------------------------------------------------------

  canCreateSpaces(actor: AgentActor): Promise<boolean> {
    return this.permissions.checkPermission(
      actor.userId,
      actor.organizationId,
      'can_create_spaces',
    );
  }

  /** The space, in this organization, open for changes. Everything starts here. */
  private async openSpace(
    actor: AgentActor,
    spaceId: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', actor.organizationId)
      .eq('is_archived', false)
      .is('deleting_at', null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  }

  /** Org role and space role of one person; the higher one is their rank. */
  private standing(organizationId: string, spaceId: string, userId: string) {
    return this.rules.standing(organizationId, spaceId, userId);
  }

  /** Why this person may not make this change, or null: the same rules as the human routes. */
  async memberProblem(actor: AgentActor, change: AgentMemberChange): Promise<string | null> {
    if (!(await this.openSpace(actor, change.spaceId))) return 'space_unavailable';
    return this.rules.problem(actor, change);
  }

  /** Whether the permission survives a revoke through the person's role; the card says so. */
  async keepsThroughRole(
    organizationId: string,
    spaceId: string,
    userId: string,
    keys: string[],
  ): Promise<string[]> {
    const kept: string[] = [];
    const { orgPower, role } = await this.standing(
      organizationId,
      spaceId,
      userId,
    );
    if (orgPower) return keys;
    const base = SPACE_ROLE_BASE_PERMISSIONS[role ?? 'member'] ?? {};
    for (const key of keys) if (base[flatKey(key)] === true) kept.push(key);
    return kept;
  }

  /** Org owners and admins keep every space through their org role, whatever a space row says. */
  async keepsAccessAfterRemoval(
    organizationId: string,
    userId: string,
  ): Promise<boolean> {
    return this.permissions.isAdminOrOwner(userId, organizationId);
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /** Whether the object an action reserved exists (a retried Confirm adopts it). */
  private async rowExists(
    table: string,
    organizationId: string,
    id: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from(table)
      .select('id')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  }

  async createSpace(
    actor: AgentActor,
    id: string,
    plan: {
      name: string;
      key: string;
      description: string | null;
      enableWiki: boolean;
      enablePlans?: boolean;
    },
  ): Promise<{ adopted: boolean }> {
    if (await this.rowExists('spaces', actor.organizationId, id)) {
      await this.finishSpace(actor, id, plan, true);
      return { adopted: true };
    }
    if (!(await this.canCreateSpaces(actor)))
      throw new AgentGovernanceError('no_create_space');

    const dto = plainToInstance(CreateSpaceDto, {
      name: plan.name,
      key: plan.key,
      ...(plan.description && { description: plan.description }),
    });
    if (await isInvalid(dto)) throw new AgentGovernanceError('invalid_input');

    try {
      await this.spaces.createSpace(actor.organizationId, actor.userId, dto, {
        id,
      });
    } catch (err) {
      if (
        await this.rowExists('spaces', actor.organizationId, id).catch(
          () => false,
        )
      ) {
        await this.finishSpace(actor, id, plan, true);
        return { adopted: true };
      }
      if ((err as { status?: number }).status === 409)
        throw new AgentGovernanceError('name_taken');
      throw err;
    }

    await this.finishSpace(actor, id, plan, false);
    return { adopted: false };
  }

  /**
   * What follows the space row: its creator as owner, the modules asked for, and a fresh
   * permission cache (the tasks and pages of this Confirm come next, and a person's spaces are
   * cached for 10 s). After a crash the row can stand without the rest; an adopted space (a
   * retry, or the sweep) gets it here (audit 2026-11-10). Idempotent; never throws.
   */
  async finishSpace(
    actor: AgentActor,
    id: string,
    plan: { enableWiki: boolean; enablePlans?: boolean },
    adopted: boolean,
  ): Promise<void> {
    if (adopted) {
      try {
        const { data, error } = await this.client
          .from('space_members')
          .select('id')
          .eq('space_id', id)
          .eq('user_id', actor.userId)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) {
          // As SpacesService.createSpace adds its creator.
          const { error: insertError } = await this.client.from('space_members').insert({
            space_id: id,
            member_type: 'user',
            user_id: actor.userId,
            space_role: 'owner',
            added_by: actor.userId,
            is_active: true,
          });
          if (insertError) throw new Error(insertError.message);
        }
      } catch (err) {
        this.logger.warn(`Robert space ${id}: owner not repaired: ${String(err)}`);
      }
    }
    this.permissions.bustOrg(actor.organizationId);

    const modules = [
      ...(plan.enableWiki ? ['wiki'] : []),
      // 1.22: a plan of this request goes in it.
      ...(plan.enablePlans ? ['plans'] : []),
    ];
    if (modules.length) {
      try {
        await this.spaces.updateSpaceModules(
          id,
          actor.userId,
          actor.organizationId,
          modules.map((module_type) => ({ module_type, is_enabled: true })),
        );
      } catch (err) {
        // The space stands; its pages and plans then report that the module is off.
        this.logger.warn(
          `Robert space ${id}: ${modules.join(', ')} not enabled: ${String(err)}`,
        );
      }
    }
  }

  async createProcess(
    actor: AgentActor,
    id: string,
    spaceId: string,
    plan: {
      title: string;
      description: string | null;
      requestType: string;
      assigneeId: string | null;
      scores: Record<string, number>;
      /** The process above: one of the same request, already created by this Confirm, or an existing one. */
      parentId?: string;
      hierarchyLevelId?: string | null;
    },
  ): Promise<{ adopted: boolean }> {
    if (await this.rowExists('business_processes', actor.organizationId, id))
      return { adopted: true };
    if (!(await this.openSpace(actor, spaceId)))
      throw new AgentGovernanceError('space_unavailable');
    if (!(await this.canCreateProcessIn(actor, spaceId)))
      throw new AgentGovernanceError('no_create_process');

    const dto = plainToInstance(CreateProcessDto, {
      space_id: spaceId,
      title: plan.title,
      request_type: plan.requestType,
      ...(plan.description && { description: plan.description }),
      ...(plan.assigneeId && { assigned_to: plan.assigneeId }),
      ...(plan.parentId && { parent_id: plan.parentId }),
      ...(plan.hierarchyLevelId && { hierarchy_level_id: plan.hierarchyLevelId }),
      ...plan.scores,
    });
    if (await isInvalid(dto)) throw new AgentGovernanceError('invalid_input');

    // The process key is the newest one plus one, so two at once can pick the same.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.processes.create(actor.organizationId, actor.userId, dto, {
          id,
        });
        return { adopted: false };
      } catch (err) {
        if (
          await this.rowExists(
            'business_processes',
            actor.organizationId,
            id,
          ).catch(() => false)
        )
          return { adopted: true };
        // Two took the same key, or the gateway hiccuped. The reserved id makes another try safe.
        if (
          attempt >= PROCESS_KEY_TRIES ||
          !/duplicate key|upstream server|fetch failed|socket hang up|ECONNRESET/i.test(
            String((err as Error).message),
          )
        )
          throw err;
      }
    }
  }

  /** Same rule as the resolver's card: a member holding the key, or an org owner or admin. */
  private async canCreateProcessIn(
    actor: AgentActor,
    spaceId: string,
  ): Promise<boolean> {
    if (
      await this.permissions.isAdminOrOwner(actor.userId, actor.organizationId)
    )
      return true;
    const resolved = await this.permissions.getUserSpacePermissions(
      actor.userId,
      actor.organizationId,
      spaceId,
    );
    return resolved.isMember && resolved.permissions.create_processes === true;
  }

  /** One change to one member. Applied already counts as done: a retried Confirm is not an error. */
  async changeMember(
    actor: AgentActor,
    change: AgentMemberChange,
  ): Promise<{ adopted: boolean }> {
    const { organizationId } = actor;
    const problem = await this.memberProblem(actor, change);
    if (problem) throw new AgentGovernanceError(problem);

    const adopted =
      change.kind === 'space_member_add'
        ? await this.addMember(actor, change)
        : await this.writeMember(actor, change);

    this.permissions.bustOrg(organizationId);

    if (change.kind === 'space_member_remove' && !adopted)
      await this.cancelTheirProposals(actor, change);
    return { adopted };
  }

  private async addMember(
    actor: AgentActor,
    change: AgentMemberChange,
  ): Promise<boolean> {
    const { organizationId } = actor;
    const here = await this.standing(
      organizationId,
      change.spaceId,
      change.userId,
    );
    if (here.active) {
      // A retry after a crash finds its own row.
      if (here.role === (change.role ?? 'member')) return true;
      throw new AgentGovernanceError('already_member');
    }
    const [person, account] = await Promise.all([
      this.client
        .from('organization_members')
        .select('user_id')
        .eq('organization_id', organizationId)
        .eq('user_id', change.userId)
        .maybeSingle(),
      this.client.from('users').select('is_active').eq('id', change.userId).maybeSingle(),
    ]);
    if (person.error || account.error) throw new Error('Could not load the person');
    if (!person.data || (account.data as { is_active?: boolean | null } | null)?.is_active === false)
      throw new AgentGovernanceError('not_in_organization');

    const grant = (change.grant ?? []).map(flatKey);
    await this.spaces.addSpaceMember(
      change.spaceId,
      organizationId,
      actor.userId,
      {
        member_type: 'user',
        user_id: change.userId,
        space_role: change.role ?? 'member',
        ...(grant.length && {
          permissions: normalizeSpacePermissions(
            Object.fromEntries(grant.map((key) => [key, true])),
          ),
        }),
      },
    );
    return false;
  }

  private async writeMember(
    actor: AgentActor,
    change: AgentMemberChange,
  ): Promise<boolean> {
    const op =
      change.kind === 'space_member_role'
        ? 'role'
        : change.kind === 'space_member_remove'
          ? 'remove'
          : 'flags';
    const { data, error } = await this.client.rpc('agent_space_member_write', {
      p_organization_id: actor.organizationId,
      p_space_id: change.spaceId,
      p_user_id: change.userId,
      p_op: op,
      p_role: change.role ?? null,
      p_grant: (change.grant ?? []).map(flatKey),
      p_revoke: (change.revoke ?? []).map(flatKey),
    });
    if (error) throw new Error(error.message);
    const out = data as { ok: boolean; code?: string; noop?: boolean };
    if (!out.ok) throw new AgentGovernanceError(out.code ?? 'internal');
    if (out.noop) return true;

    void this.audit.logAction(
      actor.organizationId,
      actor.userId,
      'space',
      change.spaceId,
      'update',
      {
        action: `robert_${op}_member`,
        user_id: change.userId,
        ...(change.role && { space_role: change.role }),
        ...(change.grant?.length && { granted: change.grant }),
        ...(change.revoke?.length && { revoked: change.revoke }),
      },
    );
    return false;
  }

  /** What they proposed in this space can no longer be theirs to confirm (SEC-11). */
  private async cancelTheirProposals(
    actor: AgentActor,
    change: AgentMemberChange,
  ): Promise<void> {
    if (await this.keepsAccessAfterRemoval(actor.organizationId, change.userId))
      return;
    try {
      const { data, error } = await this.client
        .from('agent_actions')
        .select('id, agent_runs!inner(invoker_id)')
        .eq('organization_id', actor.organizationId)
        .eq('target_space_id', change.spaceId)
        .in('status', ['proposed', 'failed'])
        .eq('agent_runs.invoker_id', change.userId);
      if (error) throw new Error(error.message);
      const ids = ((data ?? []) as { id: string }[]).map((row) => row.id);
      if (ids.length)
        await this.runs.cancelActions(
          actor.organizationId,
          'requester_no_access',
          { actionIds: ids },
        );
    } catch (err) {
      // Their Confirm is checked again anyway; this only clears the card sooner.
      this.logger.warn(
        `Open proposals of a removed member not cancelled: ${String(err)}`,
      );
    }
  }

  /** The sweep asks after a hung Confirm: did this member change reach the database? */
  async memberChangeApplied(
    organizationId: string,
    change: AgentMemberChange,
  ): Promise<boolean> {
    const { active, role } = await this.standing(
      organizationId,
      change.spaceId,
      change.userId,
    );
    if (change.kind === 'space_member_add') return active;
    if (change.kind === 'space_member_remove') return !active;
    if (change.kind === 'space_member_role')
      return active && role === change.role;
    return false;
  }
}
