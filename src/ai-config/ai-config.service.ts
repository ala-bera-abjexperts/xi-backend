import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  errorMessage,
  TenantAiError,
  TenantAiService,
} from '../ai-automation/tenant-ai.service';
import type { TenantAiConfig } from '../ai-automation/tenant-ai.service';
import {
  AGENT_PLAN_CALL,
  agentPlanSchema,
} from '../chat-agent/pipeline/agent-schemas';
import type { SaveAiConfigDto } from './dto/save-ai-config.dto';
import type { TestAiConfigDto } from './dto/test-ai-config.dto';

const CONFIG_TABLE = 'ai_provider_configs';
const USAGE_TABLE = 'ai_usage_logs';

// Offered first in the model picker, best fit for Robert first. Only the entries the provider
// really lists for the saved key are returned, so a retired name drops out by itself. Azure has
// none: there the model is a deployment name the admin types.
const RECOMMENDED_MODELS: Record<string, string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-4o', 'gpt-5-mini'],
  anthropic: ['claude-sonnet-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
  google: ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  mistral: ['mistral-small-latest', 'mistral-medium-latest'],
  azure_openai: [],
};

// Anthropic lists a model under its dated snapshot ("claude-haiku-4-5-20251001").
const isModelOrSnapshot = (id: string, name: string): boolean =>
  id === name ||
  (id.startsWith(`${name}-`) && /^\d{8}$/.test(id.slice(name.length + 1)));

const TEST_TIMEOUT_MS = 30_000;

// Room for a reasoning model to think before its short answer; any other model uses about 60.
const TEST_MAX_OUTPUT_TOKENS = 1_000;

const TEST_SYSTEM = 'This is a connection test. Do exactly what is asked.';
const TEST_PROMPT =
  'Answer with reply "ok", both languages "en", context action "ok" with n and since null, no intents, more_items false and unsupported "none".';

const WRONG_STRUCTURE =
  'The model did not answer in the structure Robert needs — choose another model.';

const TEST_STEPS = ['key', 'model', 'structuredOutput'] as const;

export interface AiConfigCheck {
  ok: boolean;
  message?: string;
}

export type AiConfigTestResult = Record<
  (typeof TEST_STEPS)[number],
  AiConfigCheck
>;

/** The checks before the failed one passed; the ones after it were never reached. */
function failedAt(
  step: (typeof TEST_STEPS)[number],
  message: string,
): AiConfigTestResult {
  const failed = TEST_STEPS.indexOf(step);

  return Object.fromEntries(
    TEST_STEPS.map((name, index) => [
      name,
      index < failed
        ? { ok: true }
        : { ok: false, message: index === failed ? message : 'Not tested.' },
    ]),
  ) as AiConfigTestResult;
}

@Injectable()
export class AiConfigService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
    private readonly tenantAi: TenantAiService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ---- Encryption helpers ------------------------------------------------

  private getEncryptionKey(): Buffer {
    const secret = process.env['AI_ENCRYPTION_SECRET'];
    if (!secret || secret.length !== 64) {
      throw new InternalServerErrorException(
        'AI_ENCRYPTION_SECRET env var must be a 64-char hex string',
      );
    }
    return Buffer.from(secret, 'hex');
  }

  private encryptKey(plainText: string): {
    encrypted: string;
    iv: string;
    tag: string;
  } {
    const key = this.getEncryptionKey();
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted =
      cipher.update(plainText, 'utf8', 'hex') + cipher.final('hex');
    const tag = cipher.getAuthTag();
    return { encrypted, iv: iv.toString('hex'), tag: tag.toString('hex') };
  }

  private decryptKey(encrypted: string, iv: string, tag: string): string {
    const key = this.getEncryptionKey();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
  }

  private maskKey(plainText: string): string {
    if (plainText.length <= 8) return '••••••••';
    return plainText.slice(0, 4) + '••••••••' + plainText.slice(-4);
  }

  // ---- Config endpoints --------------------------------------------------

  // '*' and not a column list: `model` is newer than the table and must not be named in a select
  // until every database has it.
  private async findRow(
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(CONFIG_TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);

    return (data as Record<string, unknown> | null) ?? null;
  }

  private maskStoredKey(row: Record<string, unknown>): string {
    try {
      return this.maskKey(
        this.decryptKey(
          row['encrypted_api_key'] as string,
          row['encryption_iv'] as string,
          row['encryption_tag'] as string,
        ),
      );
    } catch {
      return '••••••••';
    }
  }

  /** What every route returns for a saved configuration: the key masked, never the stored one. */
  private toView(
    row: Record<string, unknown>,
    masked_key: string,
  ): Record<string, unknown> {
    return {
      data: {
        is_configured: true,
        provider_name: row['provider_name'],
        masked_key,
        model: row['model'] ?? null,
        is_active: row['is_active'],
        configured_by: row['configured_by'],
        updated_at: row['updated_at'],
      },
    };
  }

  async getConfig(organizationId: string): Promise<Record<string, unknown>> {
    const row = await this.findRow(organizationId);

    if (!row) return { data: { is_configured: false } };

    return this.toView(row, this.maskStoredKey(row));
  }

  async saveConfig(
    organizationId: string,
    userId: string,
    dto: SaveAiConfigDto,
  ): Promise<Record<string, unknown>> {
    const existing = await this.findRow(organizationId);
    const sameProvider = existing?.['provider_name'] === dto.provider_name;

    if (dto.api_key == null) {
      // The stored key belongs to the stored provider and must never travel to another vendor.
      if (!existing || !sameProvider) {
        throw new BadRequestException(
          'An API key is required to set up or change the AI provider.',
        );
      }

      return this.saveModelOnly(organizationId, userId, existing, dto.model);
    }

    // A model that was not sent is not mentioned, so this save also works before the column exists.
    // One exception: a saved model belongs to its provider and must not follow a new one.
    let model = dto.model;

    if (model === undefined && !sameProvider && existing?.['model'] != null)
      model = null;

    const { encrypted, iv, tag } = this.encryptKey(dto.api_key);
    const configInput = { ...(dto as unknown as Record<string, unknown>) };
    delete configInput['organizationId'];

    const aiConfigResult = (await this.client
      .from(CONFIG_TABLE)
      .upsert(
        {
          organization_id: organizationId,
          provider_name: configInput.provider_name,
          encrypted_api_key: encrypted,
          encryption_iv: iv,
          encryption_tag: tag,
          is_active: true,
          configured_by: userId,
          updated_at: new Date().toISOString(),
          ...(model === undefined ? {} : { model }),
        },
        { onConflict: 'organization_id' },
      )
      .select()
      .single()) as {
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    };
    const { data, error } = aiConfigResult;

    if (error) throw new InternalServerErrorException(error.message);
    const row = data as Record<string, unknown>;

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'ai_provider_config',
      organizationId,
      'update',
      {
        provider_name: configInput.provider_name,
        action: 'configured',
        ...(model === undefined ? {} : { model }),
      },
    );

    return this.toView(row, this.maskKey(dto.api_key));
  }

  private async saveModelOnly(
    organizationId: string,
    userId: string,
    existing: Record<string, unknown>,
    model: string | null | undefined,
  ): Promise<Record<string, unknown>> {
    const maskedKey = this.maskStoredKey(existing);

    if (model === undefined || model === (existing['model'] ?? null))
      return this.toView(existing, maskedKey);

    // The model and nothing else: the three key columns are not part of this UPDATE, so the stored
    // key cannot change. updated_at is set by the table's trigger.
    const result = (await this.client
      .from(CONFIG_TABLE)
      .update({ model })
      .eq('organization_id', organizationId)
      .select()
      .single()) as {
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    };

    if (result.error)
      throw new InternalServerErrorException(result.error.message);

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'ai_provider_config',
      organizationId,
      'update',
      {
        provider_name: existing['provider_name'],
        action: 'model_changed',
        model,
      },
    );

    return this.toView(result.data as Record<string, unknown>, maskedKey);
  }

  /** The saved provider's live model list, plus the ones of it we recommend for Robert. */
  async getModels(organizationId: string) {
    const listed = await this.tenantAi.listModels(
      this.client as SupabaseClient,
      organizationId,
    );
    const wanted = RECOMMENDED_MODELS[listed.provider ?? ''] ?? [];

    return {
      ...listed,
      recommended: wanted.flatMap((name) =>
        listed.models.filter((id) => isModelOrSnapshot(id, name)),
      ),
    };
  }

  /**
   * "Test connection": ONE small call with Robert's real plan schema, read as three answers — does
   * the key work, does the model exist, does it return the structure. Unsaved values win; what is
   * missing comes from the saved configuration. Never throws for a provider problem.
   */
  async testConnection(
    organizationId: string,
    userId: string,
    dto: TestAiConfigDto,
  ): Promise<AiConfigTestResult> {
    const client = this.client as SupabaseClient;
    let saved: TenantAiConfig | null = null;
    let notSaved = '';

    try {
      saved = await this.tenantAi.resolveConfig(client, organizationId);
    } catch (err) {
      notSaved = errorMessage(err).replace(/^\(\d{3}\)\s*/, '');
    }

    const provider = dto.provider_name ?? saved?.provider;
    const sameProvider = provider === saved?.provider;

    // The stored key belongs to the stored provider and must never travel to another vendor.
    const apiKey =
      dto.api_key?.trim() || (saved && sameProvider ? saved.apiKey : '');

    if (!provider || !apiKey) {
      return failedAt(
        'key',
        saved ? 'Enter the API key of this provider to test it.' : notSaved,
      );
    }

    const model = this.tenantAi.resolveModel(
      provider,
      dto.model ?? (sameProvider ? saved?.model : null),
    );
    const logUsage = (tokens: number, status: string) =>
      this.tenantAi.logUsage(client, {
        organizationId,
        userId,
        provider,
        model,
        operationType: 'ai_connection_test',
        tokens,
        metadata: { status },
      });

    try {
      const result = await this.tenantAi.generateJson({
        provider,
        apiKey,
        model,
        system: TEST_SYSTEM,
        prompt: TEST_PROMPT,
        ...AGENT_PLAN_CALL,
        timeoutMs: TEST_TIMEOUT_MS,
        maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
      });

      await logUsage(result.promptTokens + result.completionTokens, 'ok');

      return agentPlanSchema.safeParse(result.data).success
        ? {
            key: { ok: true },
            model: { ok: true },
            structuredOutput: { ok: true },
          }
        : failedAt('structuredOutput', WRONG_STRUCTURE);
    } catch (err) {
      const failure = err instanceof TenantAiError ? err : null;

      // The provider billed an answer that could not be used.
      if (failure?.promptTokens !== undefined) {
        await logUsage(
          failure.promptTokens + (failure.completionTokens ?? 0),
          failure.kind,
        );
      }

      // TenantAiService has already taken the key out of the provider's own words.
      const detail = errorMessage(err).replace(/^\(\d{3}\)\s*/, '');

      switch (failure?.kind) {
        case 'auth':
          return failedAt('key', 'The provider rejected this API key.');

        case 'quota':
          return failedAt(
            'key',
            'The provider account of this key has no quota or credit left.',
          );

        case 'rate_limited':
          return failedAt(
            'key',
            'The provider is rate-limiting this key — try again in a minute.',
          );

        case 'not_configured':
          return failedAt('key', detail);

        case 'model_not_found':
          return failedAt(
            'model',
            `${provider} does not know the model "${model}".`,
          );

        case 'refused':
        case 'invalid_output':
          return failedAt('structuredOutput', WRONG_STRUCTURE);

        case 'too_large':
          // Cut off at the test's own output limit: the provider took the schema and was answering.
          if (failure.status === undefined) {
            return {
              key: { ok: true },
              model: { ok: true },
              structuredOutput: {
                ok: true,
                message:
                  'The model accepted the structure; its test answer was cut short.',
              },
            };
          }

          return failedAt('structuredOutput', detail);

        // ponytail: Mistral answers an unknown model with a 400, which lands here and not on the
        // model check; its text names the model. Match that text if it confuses admins.
        case 'bad_request':
          return failedAt('structuredOutput', detail);

        default:
          return failedAt(
            'key',
            'The provider could not be reached — try again.',
          );
      }
    }
  }

  async deleteConfig(
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const { data: existing, error: findError } = await this.client
      .from(CONFIG_TABLE)
      .select('id')
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (findError) throw new InternalServerErrorException(findError.message);
    if (!existing) throw new NotFoundException('AI provider config not found');

    const { error } = await this.client
      .from(CONFIG_TABLE)
      .delete()
      .eq('organization_id', organizationId);

    if (error) throw new InternalServerErrorException(error.message);
    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'ai_provider_config',
      organizationId,
      'delete',
      { action: 'removed' },
    );

    return { data: { success: true } };
  }

  // ---- Usage stats -------------------------------------------------------

  async getUsageStats(
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const [totalStats, byUser, byOperation, dailyUsage, recentLogs] =
      await Promise.all([
        this.getTotalStats(organizationId),
        this.getByUser(organizationId),
        this.getByOperation(organizationId),
        this.getDailyUsage(organizationId),
        this.getRecentLogs(organizationId),
      ]);

    return {
      data: {
        total_operations: totalStats.total_operations,
        total_tokens: totalStats.total_tokens,
        by_user: byUser,
        by_operation: byOperation,
        daily_usage: dailyUsage,
        recent_logs: recentLogs,
      },
    };
  }

  private async getTotalStats(
    organizationId: string,
  ): Promise<{ total_operations: number; total_tokens: number }> {
    const { data, error, count } = await this.client
      .from(USAGE_TABLE)
      .select('tokens_used', { count: 'exact' })
      .eq('organization_id', organizationId)
      .limit(10000);

    if (error) throw new InternalServerErrorException(error.message);
    const rows = (data ?? []) as { tokens_used: number }[];
    const total_tokens = rows.reduce((sum, r) => sum + (r.tokens_used ?? 0), 0);
    return { total_operations: count ?? 0, total_tokens };
  }

  private async getByUser(organizationId: string): Promise<unknown[]> {
    const { data, error } = await this.client
      .from(USAGE_TABLE)
      .select(
        'user_id, tokens_used, user:users!ai_usage_logs_user_id_fkey(first_name, last_name, email)',
      )
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(10000);

    if (error) throw new InternalServerErrorException(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];

    const byUser = new Map<
      string,
      {
        user_id: string;
        user_name: string | undefined;
        user_email: string | undefined;
        operation_count: number;
        tokens_used: number;
      }
    >();

    for (const row of rows) {
      const userId = row['user_id'] as string;
      const userObj = row['user'] as Record<string, unknown> | null;
      if (!byUser.has(userId)) {
        const firstName = (userObj?.['first_name'] as string | undefined) ?? '';
        const lastName = (userObj?.['last_name'] as string | undefined) ?? '';
        byUser.set(userId, {
          user_id: userId,
          user_name: `${firstName} ${lastName}`.trim(),
          user_email: (userObj?.['email'] as string | undefined) ?? '',
          operation_count: 0,
          tokens_used: 0,
        });
      }
      const entry = byUser.get(userId)!;
      entry.operation_count += 1;
      entry.tokens_used += (row['tokens_used'] as number) ?? 0;
    }

    return [...byUser.values()].sort(
      (a, b) => b.operation_count - a.operation_count,
    );
  }

  private async getByOperation(organizationId: string): Promise<unknown[]> {
    const { data, error } = await this.client
      .from(USAGE_TABLE)
      .select('operation_type, tokens_used')
      .eq('organization_id', organizationId)
      .limit(10000);

    if (error) throw new InternalServerErrorException(error.message);
    const rows = (data ?? []) as {
      operation_type: string;
      tokens_used: number;
    }[];

    const byOp = new Map<
      string,
      { operation_type: string; count: number; tokens_used: number }
    >();
    for (const row of rows) {
      const op = row.operation_type;
      if (!byOp.has(op))
        byOp.set(op, { operation_type: op, count: 0, tokens_used: 0 });
      const entry = byOp.get(op)!;
      entry.count += 1;
      entry.tokens_used += row.tokens_used ?? 0;
    }

    return [...byOp.values()].sort((a, b) => b.count - a.count);
  }

  private async getDailyUsage(organizationId: string): Promise<unknown[]> {
    const days = 14;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const { data, error } = await this.client
      .from(USAGE_TABLE)
      .select('created_at, tokens_used')
      .eq('organization_id', organizationId)
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: true })
      .limit(10000);

    if (error) throw new InternalServerErrorException(error.message);
    const rows = (data ?? []) as { created_at: string; tokens_used: number }[];

    // Match the legacy Next route: today plus the previous 14 dates.
    const daily = new Map<
      string,
      { date: string; operations: number; tokens: number }
    >();
    for (let i = days; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      daily.set(dateStr, { date: dateStr, operations: 0, tokens: 0 });
    }

    for (const row of rows) {
      const dateStr = row.created_at.slice(0, 10);
      const entry = daily.get(dateStr);
      if (entry) {
        entry.operations += 1;
        entry.tokens += row.tokens_used ?? 0;
      }
    }

    return [...daily.values()];
  }

  private async getRecentLogs(organizationId: string): Promise<unknown[]> {
    const { data, error } = await this.client
      .from(USAGE_TABLE)
      .select(
        'id, operation_type, provider_name, tokens_used, created_at, user:users!ai_usage_logs_user_id_fkey(first_name, last_name, email)',
      )
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw new InternalServerErrorException(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];

    return rows.map((row) => {
      const userObj = row['user'] as Record<string, unknown> | null;
      const firstName = (userObj?.['first_name'] as string | undefined) ?? '';
      const lastName = (userObj?.['last_name'] as string | undefined) ?? '';
      return {
        id: row['id'],
        user_name: `${firstName} ${lastName}`.trim() || '-',
        user_email: (userObj?.['email'] as string | undefined) ?? '-',
        operation_type: row['operation_type'],
        provider_name: row['provider_name'],
        tokens_used: row['tokens_used'],
        created_at: row['created_at'],
      };
    });
  }
}
