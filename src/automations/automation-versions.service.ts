// Automation versions — save, load, and compare automation definition versions.

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AutomationsService } from './automations.service';
import { AutomationScheduleService } from './automation-schedule.service';
import {
  AutomationMailboxPollerService,
  MIN_POLL_INTERVAL_SECONDS,
} from './automation-mailbox-poller.service';
import { AutomationEventSubscriptionService } from './automation-event-subscription.service';
import { ActionRegistryService } from './actions/action-registry.service';
import { CronExpressionParser } from 'cron-parser';
import type {
  IAutomation,
  IAutomationVersion,
  IAutomationVersionSummary,
  IAutomationDefinition,
} from './interfaces/automation.interface';
import type { SaveDraftDto } from './dto/save-draft.dto';

function computeNextRun(
  cronExpression: string,
  timezone: string,
  after: Date,
): Date {
  const interval = CronExpressionParser.parse(cronExpression, {
    currentDate: after,
    tz: timezone,
  });
  return interval.next().toDate();
}

@Injectable()
export class AutomationVersionsService {
  private readonly logger = new Logger(AutomationVersionsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly automationsService: AutomationsService,
    private readonly scheduleService: AutomationScheduleService,
    private readonly subscriptionService: AutomationEventSubscriptionService,
    private readonly actionRegistry: ActionRegistryService,
    // Optional so existing unit-test constructions keep compiling; DI always
    // supplies it. Same pattern as AutomationsService.entitlementsService.
    @Optional()
    private readonly mailboxPollerService?: AutomationMailboxPollerService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async listVersions(
    automationId: string,
  ): Promise<IAutomationVersionSummary[]> {
    const { data, error } = await this.db
      .from('automation_versions')
      .select(
        'id,automation_id,space_id,version_number,trigger_kind,is_draft,is_published,published_at,created_at,created_by',
      )
      .eq('automation_id', automationId)
      .order('version_number', { ascending: false });

    if (error) {
      this.logger.error(`listVersions failed: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to list automation versions',
      );
    }

    return data ?? [];
  }

  async getVersionById(
    id: string,
    automationId?: string,
  ): Promise<IAutomationVersion> {
    let query = this.db.from('automation_versions').select('*').eq('id', id);

    if (automationId) {
      query = query.eq('automation_id', automationId);
    }

    const result = await query.single();

    if (result.error || !result.data) {
      throw new NotFoundException('Automation version not found');
    }

    return result.data as IAutomationVersion;
  }

  async getDraft(automationId: string): Promise<IAutomationVersion | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.db
      .from('automation_versions')
      .select('*')
      .eq('automation_id', automationId)
      .eq('is_draft', true)
      .order('version_number', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      this.logger.error(`getDraft failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to get draft version');
    }

    return data as IAutomationVersion | null;
  }

  private async nextVersionNumber(automationId: string): Promise<number> {
    // Use MAX to handle gaps (deleted versions) correctly
    const { data, error } = await this.db
      .from('automation_versions')
      .select('version_number')
      .eq('automation_id', automationId)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error)
      throw new InternalServerErrorException(
        'Failed to compute next version number',
      );

    return (
      ((data as { version_number: number } | null)?.version_number ?? 0) + 1
    );
  }

  async createDraft(
    automationId: string,
    definition: IAutomationDefinition,
    triggerKind: string,
    triggerConfig: Record<string, unknown>,
    ctx: { userId: string; spaceId: string },
  ): Promise<IAutomationVersion> {
    const versionNumber = await this.nextVersionNumber(automationId);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.db
      .from('automation_versions')
      .insert({
        automation_id: automationId,
        space_id: ctx.spaceId,
        version_number: versionNumber,
        definition,
        trigger_kind: triggerKind,
        trigger_config: triggerConfig,
        is_draft: true,
        is_published: false,
        created_by: ctx.userId,
      })
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(
        `createDraft failed: ${error?.message} | code: ${error?.code} | details: ${error?.details} | hint: ${error?.hint}`,
      );
      // Bubble raw Supabase error for 23505 (duplicate key) so getOrCreateDraft
      // can catch it and fall back to the draft the winning request already created.
      if (error?.code === '23505') throw error;
      throw new InternalServerErrorException(
        `Failed to create draft version: ${error?.message ?? 'unknown error'}`,
      );
    }

    return data as IAutomationVersion;
  }

  async getOrCreateDraft(
    automationId: string,
    ctx: { userId: string; spaceId: string },
  ): Promise<IAutomationVersion> {
    const existing = await this.getDraft(automationId);

    if (existing) return existing;

    // After publish the previous draft has is_draft: false — seed the new draft
    // from the last published version so nodes are preserved instead of cleared.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: published } = await this.db
      .from('automation_versions')
      .select('*')
      .eq('automation_id', automationId)
      .eq('is_published', true)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    const source = published as IAutomationVersion | null;

    try {
      return await this.createDraft(
        automationId,
        source?.definition ?? { nodes: [], edges: [] },
        source?.trigger_kind ?? '',
        source?.trigger_config ?? {},
        ctx,
      );
    } catch (err: unknown) {
      // Concurrent request won the race and already created the draft — fetch it
      const pgErr = err as { code?: string };
      if (pgErr?.code === '23505') {
        const draft = await this.getDraft(automationId);
        if (draft) return draft;
      }
      throw err;
    }
  }

  async saveDraft(
    automationId: string,
    dto: SaveDraftDto,
  ): Promise<IAutomationVersion> {
    const draft = await this.getDraft(automationId);

    if (!draft) throw new NotFoundException('No draft found');

    const patch = {
      definition: (dto.definition ?? draft.definition) as IAutomationDefinition,
      trigger_kind: dto.trigger_kind ?? draft.trigger_kind,
      trigger_config: dto.trigger_config ?? draft.trigger_config,
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.db
      .from('automation_versions')
      .update(patch)
      .eq('id', draft.id)
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(`saveDraft failed: ${error?.message}`);
      throw new InternalServerErrorException('Failed to save draft');
    }

    return data as IAutomationVersion;
  }

  async publish(
    automationId: string,
    ctx: { userId: string; spaceId: string },
  ): Promise<IAutomation> {
    const draft = await this.getOrCreateDraft(automationId, ctx);

    const definition = draft.definition;
    const nodes = definition.nodes ?? [];

    if (nodes.length === 0) {
      throw new BadRequestException(
        'Automation must have at least one node before publishing',
      );
    }

    const hasTrigger = nodes.some((n) => n.type === 'trigger');

    if (!hasTrigger) {
      throw new BadRequestException(
        'Automation must have a trigger node before publishing',
      );
    }

    // Validate trigger kind early — prevents a broken publish where the trigger
    // node has no data.kind set, which would create a subscription with an
    // empty event_kind that the tick can never match.
    const triggerNodeEarly = nodes.find((n) => n.type === 'trigger');
    const effectiveTriggerKindEarly =
      triggerNodeEarly?.data?.kind ?? draft.trigger_kind ?? '';

    if (!effectiveTriggerKindEarly) {
      throw new BadRequestException(
        'Trigger node has no event configured — select a trigger type before publishing',
      );
    }

    // Reject action nodes whose integration handler isn't implemented — otherwise the
    // automation goes LIVE but every run throws "Action handler not registered" at dispatch
    // (a silent runtime failure). Mirrors the palette, which no longer offers these nodes.
    // Defensive `if (this.actionRegistry)` so mocked unit tests without the registry are unaffected.
    const unregisteredActions = !this.actionRegistry
      ? []
      : [
          ...new Set(
            nodes
              .filter(
                (n) =>
                  typeof n.data?.kind === 'string' &&
                  n.data.kind.startsWith('integration.') &&
                  !this.actionRegistry.has(n.data.kind),
              )
              .map((n) => n.data!.kind as string),
          ),
        ];

    if (unregisteredActions.length > 0) {
      throw new BadRequestException(
        `These integration actions are not available yet: ${unregisteredActions.join(
          ', ',
        )}. Remove them before publishing.`,
      );
    }

    // Unpublish old published version
    const { data: oldPublished } = await this.db
      .from('automation_versions')
      .select('id')
      .eq('automation_id', automationId)
      .eq('is_published', true)
      .order('version_number', { ascending: false })
      .limit(1)
      .single();

    if (oldPublished && oldPublished.id !== draft.id) {
      await this.db
        .from('automation_versions')
        .update({ is_published: false })
        .eq('id', oldPublished.id);
    }

    // Collect ALL trigger nodes — automations may have more than one trigger
    // (e.g. "Asset created" AND "Process relationship changed" side-by-side).
    // Subscriptions are created for every trigger so each one independently
    // fires the run; effectiveTriggerKindEarly is already validated above.
    const triggerNodes = nodes.filter((n) => n.type === 'trigger');

    // Build merged config map BEFORE publishing so we can write trigger_config
    // to the version row in the same update that flips is_published = true.
    // The DB trigger trg_sync_automation_event_subscription reads trigger_config
    // from NEW — without this it would create the subscription with empty filters.
    const mergedConfigByKindEarly = new Map<string, Record<string, unknown>>();

    for (const n of triggerNodes) {
      const k = (n.data?.kind as string) ?? '';

      if (!k) continue;

      const nodeConfig = (n.data?.config as Record<string, unknown>) ?? {};
      const prev = mergedConfigByKindEarly.get(k) ?? {};

      mergedConfigByKindEarly.set(k, { ...nodeConfig, ...prev });
    }

    // Validate the mailbox trigger BEFORE anything is published. The wiring loop
    // further down runs *after* is_published flips, so throwing there would leave
    // the automation published but unwired — a silently dead trigger.
    const mailboxConfig = mergedConfigByKindEarly.get('mailbox.email_received');

    if (mailboxConfig && !mailboxConfig.connectionId) {
      throw new BadRequestException(
        'Select a mailbox connection before publishing this automation',
      );
    }

    // Deactivate ALL existing subscriptions/schedules BEFORE publishing so the
    // DB trigger fires into a clean state (no window where the newly-created
    // subscription gets deactivated by a subsequent deactivateByAutomation call).
    await Promise.all([
      this.subscriptionService.deactivateByAutomation(automationId),
      this.scheduleService.deactivate(automationId),
      // Also stop the mailbox poller: if this republish switches the trigger away
      // from mailbox, the old poller row would otherwise keep reading the mailbox
      // for an automation that is no longer a mailbox automation. The wiring loop
      // below re-activates it when the mailbox trigger is still present.
      this.mailboxPollerService?.deactivate(automationId) ?? Promise.resolve(),
    ]);

    // Publish new version — include trigger_kind + trigger_config so the DB
    // trigger reads the correct values from NEW and creates the subscription
    // with the right event_kind and filters in one atomic step.
    await this.db
      .from('automation_versions')
      .update({
        is_published: true,
        is_draft: false,
        published_at: new Date().toISOString(),
        trigger_kind: effectiveTriggerKindEarly,
        trigger_config:
          mergedConfigByKindEarly.get(effectiveTriggerKindEarly) ?? {},
      })
      .eq('id', draft.id);

    await this.automationsService.setPublishedVersion(automationId, draft.id);
    await this.automationsService.setStatus(automationId, 'published');

    // Register each trigger node independently.
    const automation = await this.automationsService.getById(automationId);

    // Re-use the config map built before publishing — same data, no need to rebuild.
    for (const [kind, mergedConfig] of mergedConfigByKindEarly) {
      if (kind === 'schedule.cron') {
        // Schedule trigger: upsert automation_schedules row
        const cron =
          (mergedConfig.cron as string) ??
          (draft.trigger_config as Record<string, string>)?.cron;
        const tz =
          (mergedConfig.timezone as string) ??
          (draft.trigger_config as Record<string, string>)?.timezone ??
          'UTC';

        if (cron) {
          await this.scheduleService.upsert({
            automation_id: automationId,
            space_id: ctx.spaceId,
            cron_expression: cron,
            timezone: tz,
            next_run_at: computeNextRun(cron, tz, new Date()).toISOString(),
            is_active: true,
          });
        }
      } else if (kind === 'mailbox.email_received') {
        // Inbound mailbox trigger: upsert the poll row. Without this branch the
        // automation publishes cleanly and then never fires — no schedule row,
        // no subscription row, no error.
        const connectionId =
          (mergedConfig.connectionId as string) ??
          (draft.trigger_config as Record<string, string>)?.connectionId;

        if (!connectionId) {
          throw new BadRequestException(
            'Select a mailbox connection before publishing this automation',
          );
        }

        const interval = Number(
          (mergedConfig.pollIntervalSeconds as number) ??
            MIN_POLL_INTERVAL_SECONDS,
        );

        await this.mailboxPollerService?.upsert({
          automation_id: automationId,
          space_id: ctx.spaceId,
          organization_id: automation.organization_id,
          connection_id: connectionId,
          folder: (mergedConfig.folder as string) || 'inbox',
          poll_interval_seconds: Number.isFinite(interval)
            ? interval
            : MIN_POLL_INTERVAL_SECONDS,
          // Only mail arriving after publish is ingested, so connecting a
          // mailbox with history cannot backfill thousands of tickets.
          watermark_at: new Date().toISOString(),
          is_active: true,
        });

        // The poller only fetches mail and writes an outbox row; the tick's
        // existing relay turns that into a run. That relay matches on a
        // subscription, so this row is what actually makes the trigger fire.
        await this.subscriptionService.upsert({
          automation_id: automationId,
          space_id: ctx.spaceId,
          organization_id: automation.organization_id,
          event_kind: kind,
          filters: {},
          is_active: true,
        });
      } else if (
        kind.startsWith('app.') ||
        kind.startsWith('webhook.') ||
        kind.startsWith('integration.')
      ) {
        // App / webhook / integration event trigger: upsert a subscription row
        // so the tick's outbox relay can match incoming events.
        await this.subscriptionService.upsert({
          automation_id: automationId,
          space_id: ctx.spaceId,
          organization_id: automation.organization_id,
          event_kind: kind,
          filters: mergedConfig,
          is_active: true,
        });
      } else {
        // Nothing wired this kind to a firing mechanism. Publishing still
        // succeeds (unchanged behaviour) but a dead trigger is now visible in
        // the logs instead of failing silently.
        this.logger.warn(
          `publish: trigger kind "${kind}" matched no wiring branch — automation ${automationId} will never fire`,
        );
      }
    }

    // Always generate webhook_token for every published automation.
    // The token uniquely identifies the automation for inbound webhooks
    // and is harmless for non-webhook trigger types.
    await this.automationsService.ensureWebhookToken(automationId, ctx.userId);

    return this.automationsService.getById(automationId);
  }

  async cloneDraft(
    versionId: string,
    ctx: { userId: string },
    automationId?: string,
  ): Promise<IAutomationVersion> {
    const source = await this.getVersionById(versionId, automationId);
    const versionNumber = await this.nextVersionNumber(source.automation_id);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.db
      .from('automation_versions')
      .insert({
        automation_id: source.automation_id,
        space_id: source.space_id,
        version_number: versionNumber,
        definition: source.definition,
        trigger_kind: source.trigger_kind,
        trigger_config: source.trigger_config,
        is_draft: true,
        is_published: false,
        created_by: ctx.userId,
      })
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(`cloneDraft failed: ${error?.message}`);
      throw new InternalServerErrorException('Failed to clone draft version');
    }

    // Archive any existing draft(s) so only one draft exists at a time.
    // The .neq guard prevents accidentally archiving the draft we just inserted.
    await this.db
      .from('automation_versions')
      .update({ is_draft: false })
      .eq('automation_id', source.automation_id)
      .eq('is_draft', true)
      .neq('id', data.id);

    // Point the automation at the new draft so the editor opens it immediately.
    await this.db
      .from('automations')
      .update({
        current_version_id: data.id,
        updated_at: new Date().toISOString(),
        updated_by: ctx.userId,
      })
      .eq('id', source.automation_id);

    return data as IAutomationVersion;
  }
}
