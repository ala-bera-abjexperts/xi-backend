/**
 * @fileoverview Robert's tenant settings, budgets and usage (XE-T353, ADM-03): the
 * switches and token caps of `agent_settings`, this month's usage against the cap,
 * the usage dashboard, and the delivery of the 80% / 100% budget alerts.
 * RLS is inert, so every query filters `organization_id` itself.
 * @module src/chat-agent/agent-settings.service
 */

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { fetchAllRows } from '../common/utils/fetch-all-rows';
import { MailService } from '../mail/mail.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { ROBERT_NAME, RUN_RESERVE_TOKENS } from './agent.constants';
import type {
  AgentUsageQueryDto,
  UpdateAgentSettingsDto,
} from './dto/agent.dto';

export interface AgentSettings {
  enabled: boolean;
  allowInDms: boolean;
  /** Tokens per UTC month for the whole tenant; null = no cap. */
  monthlyTokenCap: number | null;
  /** Tokens per UTC day for one person; null = no cap. */
  userDailyTokenCap: number | null;
  storePrompts: boolean;
}

export interface AgentSettingsView extends AgentSettings {
  /** Tokens reserved for one run; a cap below it is refused. */
  reservePerRun: number;
  usage: {
    month: { used: number; cap: number | null; resetsAt: string };
    alert80At: string | null;
    alert100At: string | null;
  };
}

export interface AgentUsageView {
  byDay: { date: string; tokens: number }[];
  byUser: { userId: string; name: string; tokens: number; runs: number }[];
  byModel: {
    provider: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    runs: number;
  }[];
  byFeature: { feature: string; tokens: number; runs: number }[];
}

interface SettingsRow {
  enabled: boolean;
  allow_in_dms: boolean;
  monthly_token_cap: number | null;
  user_daily_token_cap: number | null;
  store_prompts: boolean;
}

interface UsageLogRow {
  user_id: string;
  operation_type: string;
  tokens_used: number | null;
  created_at: string;
  user: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  } | null;
}

interface RunUsageRow {
  provider: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
}

const SETTINGS_COLUMNS =
  'enabled, allow_in_dms, monthly_token_cap, user_daily_token_cap, store_prompts';

const DAY_MS = 24 * 60 * 60_000;
/** The longest period the usage dashboard may ask for. */
const MAX_USAGE_DAYS = 366;

/** Where a Robert manager changes the budget (the AI tab of the tenant settings). */
const AI_SETTINGS_PATH = '/tenant-config?tab=configuration';

// ponytail: English only, like every bell title this backend writes; move both to
// mail/i18n when notification titles are localised.
const BUDGET_ALERT: Record<80 | 100, { title: string; body: string }> = {
  80: {
    title: "Robert has used 80% of this month's AI budget",
    body: 'Robert keeps working until the monthly limit is reached. You can raise the limit in the AI settings.',
  },
  100: {
    title: "Robert's AI budget for this month is used up",
    body: 'New requests to Robert are refused until the budget resets next month or the limit is raised in the AI settings.',
  },
};

const PROVIDER_PROBLEM_TITLE =
  "Robert can't use your AI provider. Check the AI key in the AI settings.";

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

@Injectable()
export class AgentSettingsService {
  private readonly logger = new Logger(AgentSettingsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
    private readonly notificationsBroadcast: NotificationsBroadcastService,
    private readonly mail: MailService,
    private readonly configService: ConfigService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** The settings of an organization. No row = enabled, allowed in DMs, no caps. */
  async read(organizationId: string): Promise<AgentSettings> {
    const { data, error } = await this.client
      .from('agent_settings')
      .select(SETTINGS_COLUMNS)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error)
      throw new InternalServerErrorException('Could not load Robert settings');

    const row = data as SettingsRow | null;

    return {
      enabled: row?.enabled ?? true,
      allowInDms: row?.allow_in_dms ?? true,
      monthlyTokenCap: row?.monthly_token_cap ?? null,
      userDailyTokenCap: row?.user_daily_token_cap ?? null,
      storePrompts: row?.store_prompts ?? false,
    };
  }

  /** GET /chat/agent/settings: the settings plus this UTC month's usage against the cap. */
  async get(user: RequestUser): Promise<AgentSettingsView> {
    const now = new Date();
    const month = `${now.toISOString().slice(0, 7)}-01`;
    const [settings, counter] = await Promise.all([
      this.read(user.organizationId),
      this.client
        .from('agent_usage_counters')
        .select('used_tokens, alert80_at, alert100_at')
        .eq('organization_id', user.organizationId)
        .eq('scope', 'org_month')
        .eq('subject_id', user.organizationId)
        .eq('period_start', month)
        .maybeSingle(),
    ]);

    if (counter.error)
      throw new InternalServerErrorException('Could not load Robert usage');

    const row = counter.data as {
      used_tokens: number;
      alert80_at: string | null;
      alert100_at: string | null;
    } | null;

    return {
      ...settings,
      reservePerRun: RUN_RESERVE_TOKENS,
      usage: {
        month: {
          used: Number(row?.used_tokens ?? 0),
          cap: settings.monthlyTokenCap,
          // A new month is a new counter row: nothing is reset, the period just ends.
          resetsAt: new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
          ).toISOString(),
        },
        alert80At: row?.alert80_at ?? null,
        alert100At: row?.alert100_at ?? null,
      },
    };
  }

  /**
   * PUT /chat/agent/settings. The DTO has already refused a cap below one run's
   * reservation. Writes `settings.changed` to the Robert audit trail.
   */
  async update(
    user: RequestUser,
    dto: UpdateAgentSettingsDto,
  ): Promise<AgentSettingsView> {
    const values: SettingsRow = {
      enabled: dto.enabled,
      allow_in_dms: dto.allowInDms,
      monthly_token_cap: dto.monthlyTokenCap,
      user_daily_token_cap: dto.userDailyTokenCap,
      store_prompts: dto.storePrompts,
    };

    // ponytail: two statements, the audit row first, so a change can never land
    // without its row; a save that fails leaves a row for a change that did not
    // happen. One database function would close that gap.
    const audit = await this.client.from('agent_audit_events').insert({
      organization_id: user.organizationId,
      event: 'settings.changed',
      actor_id: user.userId,
      // Booleans and numbers only, as everywhere in this table.
      data: values,
    });

    if (audit.error)
      throw new InternalServerErrorException('Could not save Robert settings');

    const { error } = await this.client.from('agent_settings').upsert(
      {
        organization_id: user.organizationId,
        ...values,
        updated_by: user.userId,
      },
      { onConflict: 'organization_id' },
    );

    if (error)
      throw new InternalServerErrorException('Could not save Robert settings');

    return this.get(user);
  }

  /**
   * GET /chat/agent/usage: Robert's tokens in the organization in a period of whole
   * UTC days. By day, by user and by feature come from the `robert_run` rows of
   * `ai_usage_logs` (the connection test and the other AI features write there too
   * and are left out); by model comes from `agent_runs`, the only place that knows
   * input from output tokens.
   *
   * @throws BadRequestException when the period is reversed or longer than a year
   */
  async usage(
    user: RequestUser,
    query: AgentUsageQueryDto,
  ): Promise<AgentUsageView> {
    const start = Date.parse(`${query.from}T00:00:00Z`);
    const end = Date.parse(`${query.to}T00:00:00Z`) + DAY_MS;

    if (end <= start) {
      throw new BadRequestException('"from" must not be after "to"');
    }
    if ((end - start) / DAY_MS > MAX_USAGE_DAYS) {
      throw new BadRequestException(
        `The period may span at most ${MAX_USAGE_DAYS} days`,
      );
    }

    const since = new Date(start).toISOString();
    const until = new Date(end).toISOString();

    // ponytail: summed in JavaScript over paged reads (at most 100,000 rows each),
    // as GET /ai-config/usage does; one SQL function with GROUP BY when a tenant
    // outgrows that.
    const [logs, runs] = await Promise.all([
      fetchAllRows<UsageLogRow>((from, to) =>
        this.client
          .from('ai_usage_logs')
          .select(
            'user_id, operation_type, tokens_used, created_at, user:users!ai_usage_logs_user_id_fkey(first_name, last_name, email)',
          )
          .eq('organization_id', user.organizationId)
          // The type agent_finalize_run and agent_reap_runs write.
          .eq('operation_type', 'robert_run')
          .gte('created_at', since)
          .lt('created_at', until)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
          // The embedded user is one row (many-to-one), not the list the
          // select string is typed as.
          .returns<UsageLogRow[]>(),
      ),
      fetchAllRows<RunUsageRow>((from, to) =>
        this.client
          .from('agent_runs')
          .select('provider, model, tokens_in, tokens_out')
          .eq('organization_id', user.organizationId)
          // A run that never reached the model has no model and spent nothing.
          .gt('model_calls', 0)
          .gte('created_at', since)
          .lt('created_at', until)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ]);

    // Every day of the period, also the ones without usage.
    const byDay = new Map<string, number>();
    for (let day = start; day < end; day += DAY_MS) {
      byDay.set(new Date(day).toISOString().slice(0, 10), 0);
    }
    const byUser = new Map<string, AgentUsageView['byUser'][number]>();
    const byFeature = new Map<string, AgentUsageView['byFeature'][number]>();

    for (const row of logs.rows) {
      const tokens = Number(row.tokens_used ?? 0);
      // The UTC day, whatever offset the timestamp is written with.
      const date = new Date(row.created_at).toISOString().slice(0, 10);

      byDay.set(date, (byDay.get(date) ?? 0) + tokens);

      const person = byUser.get(row.user_id) ?? {
        userId: row.user_id,
        name:
          `${row.user?.first_name ?? ''} ${row.user?.last_name ?? ''}`.trim() ||
          row.user?.email ||
          'Unknown user',
        tokens: 0,
        runs: 0,
      };
      person.tokens += tokens;
      person.runs += 1;
      byUser.set(row.user_id, person);

      const feature = byFeature.get(row.operation_type) ?? {
        feature: row.operation_type,
        tokens: 0,
        runs: 0,
      };
      feature.tokens += tokens;
      feature.runs += 1;
      byFeature.set(row.operation_type, feature);
    }

    const byModel = new Map<string, AgentUsageView['byModel'][number]>();

    for (const row of runs.rows) {
      // A run that was cut off (timeout, lost worker) never stored its model.
      const provider = row.provider ?? 'unknown';
      const model = row.model ?? 'unknown';
      const entry = byModel.get(`${provider}\n${model}`) ?? {
        provider,
        model,
        tokensIn: 0,
        tokensOut: 0,
        runs: 0,
      };
      entry.tokensIn += Number(row.tokens_in);
      entry.tokensOut += Number(row.tokens_out);
      entry.runs += 1;
      byModel.set(`${provider}\n${model}`, entry);
    }

    return {
      byDay: [...byDay].map(([date, tokens]) => ({ date, tokens })),
      byUser: [...byUser.values()].sort((a, b) => b.tokens - a.tokens),
      byModel: [...byModel.values()].sort(
        (a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut),
      ),
      byFeature: [...byFeature.values()].sort((a, b) => b.tokens - a.tokens),
    };
  }

  /**
   * Tells the organization's Robert managers that 80% or 100% of the monthly budget
   * is reached: one bell entry and one email each, with no chat content. The
   * database decides "once" (`alert80` of agent_record_model_call, `alert100` of
   * agent_start_run); this only delivers. Never throws: an alert that cannot be
   * delivered must not fail the run that caused it.
   */
  async notifyBudgetAlert(
    organizationId: string,
    threshold: 80 | 100,
  ): Promise<void> {
    try {
      const managers = await this.robertManagers(organizationId);
      if (managers.length === 0) return;

      const { title, body } = BUDGET_ALERT[threshold];
      await this.ring(organizationId, managers, 'robert_budget', title, {
        threshold,
      });

      const { data: users } = await this.client
        .from('users')
        .select('id, email, first_name, language')
        .in('id', managers);
      const appUrl = (
        this.configService.get<string>('appUrl') || 'http://localhost:3000'
      ).replace(/\/+$/, '');

      for (const recipient of (users ?? []) as {
        id: string;
        email: string | null;
        first_name: string | null;
        language: string | null;
      }[]) {
        if (!recipient.email) continue;

        // One bad address must not keep the alert from the other managers.
        try {
          await this.mail.sendNotification(
            recipient.email,
            {
              title,
              subject: title,
              eyebrow: ROBERT_NAME,
              body,
              ctaUrl: `${appUrl}${AI_SETTINGS_PATH}`,
              ctaLabel: 'Open AI settings',
              recipientName: recipient.first_name ?? undefined,
            },
            { organizationId, locale: recipient.language },
          );
        } catch (err) {
          this.logger.error(
            `Budget alert email to user ${recipient.id} failed: ${errorText(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `Budget alert (${threshold}%) for organization ${organizationId} was not delivered: ${errorText(err)}`,
      );
    }
  }

  /**
   * Tells the organization's Robert managers that Robert cannot use the AI provider
   * (the key is wrong, expired or out of credit): one bell entry each, no email and
   * no technical detail. At most once per 24 hours per organization. Never throws:
   * the failed run has already got its own notice.
   */
  async notifyProviderProblem(organizationId: string): Promise<void> {
    try {
      // ponytail: read-then-write, so two runs failing in the same instant can both
      // ring; a unique daily key in the database when that double entry matters.
      const recent = await this.client
        .from('notifications')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('type', 'robert_provider')
        .gte('created_at', new Date(Date.now() - DAY_MS).toISOString())
        .limit(1);

      if (recent.error) throw new Error(recent.error.message);
      if ((recent.data ?? []).length > 0) return;

      const managers = await this.robertManagers(organizationId);
      if (managers.length === 0) return;

      await this.ring(
        organizationId,
        managers,
        'robert_provider',
        PROVIDER_PROBLEM_TITLE,
        {},
      );
    } catch (err) {
      this.logger.error(
        `Provider problem notice for organization ${organizationId} was not delivered: ${errorText(err)}`,
      );
    }
  }

  /** One bell entry per user, linking to the AI settings, broadcast live. */
  private async ring(
    organizationId: string,
    userIds: string[],
    type: string,
    title: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const inserted = await this.client
      .from('notifications')
      .insert(
        userIds.map((userId) => ({
          organization_id: organizationId,
          user_id: userId,
          type,
          title,
          body: null,
          is_read: false,
          action_status: 'none',
          metadata: { link: AI_SETTINGS_PATH, ...metadata },
        })),
      )
      .select('id, user_id, type, title, created_at, metadata');

    if (inserted.error) throw new Error(inserted.error.message);

    for (const row of (inserted.data ?? []) as Record<string, unknown>[]) {
      void this.notificationsBroadcast.broadcastNotification(row);
    }
  }

  /**
   * The people of an organization who hold `can_manage_robert`.
   * ponytail: only owners, admins and holders of a custom role are asked (the first
   * 1,000 rows of each); a base-role override that hands the key to every member or
   * viewer is not followed. Ask every member when a tenant really does that.
   */
  private async robertManagers(organizationId: string): Promise<string[]> {
    const [admins, roleHolders] = await Promise.all([
      this.client
        .from('organization_members')
        .select('user_id')
        .eq('organization_id', organizationId)
        .in('role', ['owner', 'admin']),
      this.client
        .from('user_role_assignments')
        .select('user_id')
        .eq('organization_id', organizationId),
    ]);

    if (admins.error) throw new Error(admins.error.message);
    if (roleHolders.error) throw new Error(roleHolders.error.message);

    const candidates = [
      ...new Set(
        [
          ...((admins.data ?? []) as { user_id: string }[]),
          ...((roleHolders.data ?? []) as { user_id: string }[]),
        ].map((row) => row.user_id),
      ),
    ];
    // Effective permissions are cached per user for a few seconds.
    const holds = await Promise.all(
      candidates.map((userId) =>
        this.permissions.checkPermission(
          userId,
          organizationId,
          'can_manage_robert',
        ),
      ),
    );

    return candidates.filter((_, index) => holds[index]);
  }
}
