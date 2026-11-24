// Automation CRUD — create, read, update, delete, publish, and archive automations.

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { EntitlementsService } from '../licensing/entitlements.service';
import { AutomationEventSubscriptionService } from './automation-event-subscription.service';
import { AutomationScheduleService } from './automation-schedule.service';
import { AutomationMailboxPollerService } from './automation-mailbox-poller.service';
import type {
  IAutomation,
  AutomationStatus,
} from './interfaces/automation.interface';
import type { CreateAutomationDto } from './dto/create-automation.dto';
import type { UpdateAutomationDto } from './dto/update-automation.dto';

@Injectable()
export class AutomationsService {
  private readonly logger = new Logger(AutomationsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly subscriptionService: AutomationEventSubscriptionService,
    private readonly scheduleService: AutomationScheduleService,
    // Optional so existing unit-test constructions keep compiling; DI always
    // supplies it (AutomationsModule imports LicensingModule).
    @Optional() private readonly entitlementsService?: EntitlementsService,
    // Optional for the same reason. Without this, pausing or archiving a
    // mailbox automation would leave it polling and creating tickets.
    @Optional()
    private readonly mailboxPollerService?: AutomationMailboxPollerService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async validateSpaceExists(spaceId: string): Promise<void> {
    const { data, error } = await this.db
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .maybeSingle();

    if (error || !data) {
      throw new NotFoundException('Space not found');
    }
  }

  async validateAutomationBelongsToSpace(
    automationId: string,
    spaceId: string,
  ): Promise<void> {
    const automation = await this.getById(automationId);

    if (automation.space_id !== spaceId) {
      throw new BadRequestException(
        'Automation does not belong to the specified space',
      );
    }
  }

  async listForSpace(
    spaceId: string,
    archived = false,
  ): Promise<IAutomation[]> {
    const { data, error } = await this.db
      .from('automations')
      .select('*')
      .eq('space_id', spaceId)
      .eq('is_archived', archived)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`listForSpace failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to list automations');
    }

    const automations = (data ?? []) as IAutomation[];

    // Enrich each row with its effective trigger (published version if live, else the current draft) and
    // the number of trigger nodes in that version's graph. Both live on automation_versions, not
    // automations — one batched lookup, never per-row.
    const effectiveVersionId = (a: IAutomation): string | null =>
      a.published_version_id ?? a.current_version_id;
    const versionIds = [
      ...new Set(
        automations.map(effectiveVersionId).filter((v): v is string => !!v),
      ),
    ];

    if (versionIds.length === 0) {
      return automations.map((a) => ({
        ...a,
        trigger_kind: null,
        trigger_node_count: 0,
        action_count: 0,
      }));
    }

    const metaByVersion = new Map<
      string,
      {
        trigger_kind: string | null;
        trigger_node_count: number;
        action_count: number;
      }
    >();
    const { data: vRows, error: vErr } = await this.db
      .from('automation_versions')
      .select('id, trigger_kind, definition')
      .in('id', versionIds);

    if (vErr) {
      // Fail-soft: never break listing because trigger enrichment failed — degrade gracefully.
      this.logger.warn(
        `listForSpace trigger enrichment failed: ${vErr.message}`,
      );
    } else {
      const rows = (vRows ?? []) as Array<{
        id: string;
        trigger_kind: string | null;
        definition: { nodes?: Array<{ type?: string }> } | null;
      }>;

      rows.forEach((r) => {
        const nodes = r.definition?.nodes ?? [];

        metaByVersion.set(r.id, {
          trigger_kind: r.trigger_kind,
          // Trigger nodes are identified by node.type === 'trigger' (same rule the DAG engine /
          // version validation use). An automation may have more than one trigger entry point.
          trigger_node_count: nodes.filter((n) => n.type === 'trigger').length,
          // Everything that is not a trigger is a workflow step (action / control node).
          action_count: nodes.filter((n) => n.type !== 'trigger').length,
        });
      });
    }

    return automations.map((a) => {
      const vid = effectiveVersionId(a);
      const meta = vid ? metaByVersion.get(vid) : undefined;

      return {
        ...a,
        trigger_kind: meta?.trigger_kind ?? null,
        trigger_node_count: meta?.trigger_node_count ?? 0,
        action_count: meta?.action_count ?? 0,
      };
    });
  }

  async getById(id: string, organizationId?: string): Promise<IAutomation> {
    // SECURITY (H1): optional org scope. HTTP callers pass user.organizationId so
    // a cross-tenant id yields a clean 404; internal worker/publish callers omit
    // it and keep their existing service_role behavior.
    let q = this.db.from('automations').select('*').eq('id', id);

    if (organizationId) q = q.eq('organization_id', organizationId);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await q.single();

    if (error || !data) {
      if (error?.code === 'PGRST116')
        throw new NotFoundException('Automation not found');
      this.logger.error(`getById failed: ${error?.message}`);
      throw new NotFoundException('Automation not found');
    }

    return data as IAutomation;
  }

  async create(
    dto: CreateAutomationDto,
    ctx: { userId: string; organizationId: string },
  ): Promise<IAutomation> {
    // Warn-only plan-limit check: logs a breach, never refuses. See
    // EntitlementsService.checkLimit for why this is not a block yet.
    await this.entitlementsService?.checkLimit(
      ctx.organizationId,
      'limit_automations',
      async () => {
        const { count } = await this.db
          .from('automations')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', ctx.organizationId);

        return count ?? 0;
      },
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.db
      .from('automations')
      .insert({
        space_id: dto.space_id,
        organization_id: ctx.organizationId,
        name: dto.name,
        description: dto.description ?? null,
        icon: dto.icon ?? null,
        created_by: ctx.userId,
      })
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(`create failed: ${error?.message}`);
      throw new InternalServerErrorException('Failed to create automation');
    }

    return data as IAutomation;
  }

  async update(
    id: string,
    dto: UpdateAutomationDto,
    userId: string,
    organizationId?: string,
  ): Promise<IAutomation> {
    // SECURITY (H1): scope the update by org so a cross-tenant PUT matches 0 rows
    // → PGRST116 → NotFound (handled below).
    let q = this.db
      .from('automations')
      .update({
        ...dto,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (organizationId) q = q.eq('organization_id', organizationId);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await q.select('*').single();

    if (error?.code === 'PGRST116') {
      throw new NotFoundException('Automation not found');
    }
    if (error || !data) {
      this.logger.error(`update failed: ${error?.message}`);
      throw new InternalServerErrorException('Failed to update automation');
    }

    return data as IAutomation;
  }

  async archive(id: string, organizationId?: string): Promise<void> {
    await this.getById(id, organizationId);

    const { error } = await this.db
      .from('automations')
      .update({ is_archived: true, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      this.logger.error(`archive failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to archive automation');
    }

    await Promise.all([
      this.subscriptionService.deleteByAutomation(id),
      this.scheduleService.deactivate(id),
      this.mailboxPollerService?.deleteByAutomation(id) ?? Promise.resolve(),
    ]);
  }

  async pause(id: string, organizationId?: string): Promise<IAutomation> {
    const automation = await this.setStatus(id, 'paused', organizationId);

    await Promise.all([
      this.subscriptionService.deactivateByAutomation(id),
      this.scheduleService.deactivate(id),
      this.mailboxPollerService?.deactivate(id) ?? Promise.resolve(),
    ]);

    return automation;
  }

  async resume(id: string, organizationId?: string): Promise<IAutomation> {
    const automation = await this.setStatus(id, 'published', organizationId);

    await Promise.all([
      this.subscriptionService.activateByAutomation(id),
      this.scheduleService.activate(id).catch(() => {
        // No schedule exists for this automation (non-cron trigger) — safe to ignore.
      }),
      // Same contract: throws when the automation has no poller. Resuming also
      // re-stamps the watermark, so a long pause does not ingest the backlog.
      this.mailboxPollerService?.activate(id).catch(() => {
        // No mailbox poller for this automation — safe to ignore.
      }) ?? Promise.resolve(),
    ]);

    return automation;
  }

  async restore(id: string, organizationId?: string): Promise<{ id: string }> {
    await this.getById(id, organizationId);

    const { error } = await this.db
      .from('automations')
      .update({ is_archived: false, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      this.logger.error(`restore failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to restore automation');
    }

    return { id };
  }

  async permanentDelete(id: string, organizationId?: string): Promise<void> {
    // Ensure the automation exists and is org-scoped (throws NotFound otherwise).
    // Permanent delete is allowed from any state (not archived-only) so the list can offer
    // Delete in every tab; the UI guards it with an irreversible-action confirm dialog.
    await this.getById(id, organizationId);

    // Delete run steps first — FK dependency on automation_runs
    const { data: runs } = await this.db
      .from('automation_runs')
      .select('id')
      .eq('automation_id', id);

    if (runs && runs.length > 0) {
      const runIds = runs.map((r: { id: string }) => r.id);

      await this.db.from('automation_run_steps').delete().in('run_id', runIds);
    }

    // Delete all child records in parallel, then the automation itself
    await Promise.all([
      this.db.from('automation_runs').delete().eq('automation_id', id),
      this.db.from('automation_versions').delete().eq('automation_id', id),
      this.db
        .from('automation_webhook_deliveries')
        .delete()
        .eq('automation_id', id),
      this.subscriptionService.deleteByAutomation(id),
      this.db.from('automation_schedules').delete().eq('automation_id', id),
    ]);

    const { error } = await this.db.from('automations').delete().eq('id', id);

    if (error) {
      this.logger.error(`permanentDelete failed: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to permanently delete automation',
      );
    }
  }

  async setStatus(
    id: string,
    status: AutomationStatus,
    organizationId?: string,
  ): Promise<IAutomation> {
    let q = this.db
      .from('automations')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (organizationId) q = q.eq('organization_id', organizationId);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await q.select('*').single();

    if (error?.code === 'PGRST116') {
      throw new NotFoundException('Automation not found');
    }
    if (error || !data) {
      this.logger.error(`setStatus failed: ${error?.message}`);
      throw new InternalServerErrorException(
        'Failed to update automation status',
      );
    }

    return data as IAutomation;
  }

  async setPublishedVersion(
    id: string,
    versionId: string | null,
  ): Promise<IAutomation> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.db
      .from('automations')
      .update({
        published_version_id: versionId,
        current_version_id: versionId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(`setPublishedVersion failed: ${error?.message}`);
      throw new InternalServerErrorException(
        'Failed to update published version',
      );
    }

    return data as IAutomation;
  }

  async ensureWebhookToken(id: string, userId: string): Promise<void> {
    const automation = await this.getById(id);

    if (!automation.webhook_token) {
      const token = randomBytes(32).toString('base64url');
      const { error } = await this.db
        .from('automations')
        .update({
          webhook_token: token,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id);

      if (error) {
        this.logger.error(`ensureWebhookToken failed: ${error.message}`);
        throw new InternalServerErrorException(
          'Failed to generate webhook token',
        );
      }
    }
  }

  async findByWebhookToken(token: string): Promise<IAutomation | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.db
      .from('automations')
      .select('*')
      .eq('webhook_token', token)
      .eq('status', 'published')
      .maybeSingle();

    if (error) {
      this.logger.error(`findByWebhookToken failed: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to lookup automation by webhook token',
      );
    }

    return (data as IAutomation) ?? null;
  }

  async cloneAutomation(
    id: string,
    ctx: { userId: string; organizationId: string },
  ): Promise<IAutomation> {
    // SECURITY (H1): the clone SOURCE must be in the caller's org (org from ctx).
    const source = await this.getById(id, ctx.organizationId);

    return this.create(
      {
        space_id: source.space_id,
        name: `${source.name} (copy)`,
        description: source.description ?? undefined,
        icon: source.icon ?? undefined,
      },
      ctx,
    );
  }

  async listPermissions(automationId: string): Promise<unknown[]> {
    const { data, error } = await this.db
      .from('automation_permissions')
      .select(
        'id, user_id, permission_level, created_at, user:users(id, first_name, last_name, email, avatar_url)',
      )
      .eq('automation_id', automationId)
      .order('created_at', { ascending: true });

    if (error) throw new InternalServerErrorException(error.message);

    return data ?? [];
  }

  async grantPermission(
    automationId: string,
    body: { user_id: string; permission_level: string },
  ): Promise<unknown> {
    const { data, error } = await this.db
      .from('automation_permissions')
      .upsert(
        {
          automation_id: automationId,
          user_id: body.user_id,
          permission_level: body.permission_level,
        },
        { onConflict: 'automation_id,user_id' },
      )
      .select('id, user_id, permission_level, created_at')
      .single();

    if (error) throw new InternalServerErrorException(error.message);

    return data;
  }

  async revokePermission(permId: string, automationId?: string): Promise<void> {
    let dq = this.db.from('automation_permissions').delete().eq('id', permId);

    // SECURITY (H1): also bind to the parent automation so a foreign permId under
    // a route whose :id the caller owns cannot delete cross-automation rows.
    if (automationId) dq = dq.eq('automation_id', automationId);

    const { error } = await dq;

    if (error) throw new InternalServerErrorException(error.message);
  }

  async getSpaceConfig(
    spaceId: string,
  ): Promise<{ max_concurrent_runs: number | null }> {
    const { data, error } = await this.db
      .from('spaces')
      .select('settings')
      .eq('id', spaceId)
      .single();

    if (error || !data) throw new NotFoundException('Space not found');

    const cfg = data.settings?.automation_config ?? {};

    return { max_concurrent_runs: cfg.max_concurrent_runs ?? null };
  }

  async updateSpaceConfig(
    spaceId: string,
    input: { max_concurrent_runs?: number | null },
  ): Promise<{ max_concurrent_runs: number | null }> {
    const { data: existing, error: readErr } = await this.db
      .from('spaces')
      .select('settings')
      .eq('id', spaceId)
      .single();

    if (readErr || !existing) throw new NotFoundException('Space not found');

    const settings = (existing.settings as Record<string, unknown>) ?? {};
    const currentCfg =
      (settings.automation_config as Record<string, unknown>) ?? {};
    const newCfg = { ...currentCfg, ...input };

    const { error } = await this.db
      .from('spaces')
      .update({ settings: { ...settings, automation_config: newCfg } })
      .eq('id', spaceId);

    if (error)
      throw new InternalServerErrorException('Failed to update space config');

    return {
      max_concurrent_runs:
        (newCfg.max_concurrent_runs as number | null) ?? null,
    };
  }
}
