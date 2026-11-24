import { BadRequestException, Logger } from '@nestjs/common';

import {
  TenantAiError,
  TenantAiService,
} from '../ai-automation/tenant-ai.service';
import { AGENT_PLAN_JSON_SCHEMA } from '../chat-agent/pipeline/agent-schemas';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import { encryptApiKey } from '../lib/crypto/encryption';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AiConfigService } from './ai-config.service';
import { AiProvider } from './dto/save-ai-config.dto';

const ORG = 'org-1';
const USER = 'user-1';
const SAVED_KEY = 'sk-saved-SECRET-key-1234';
const NEW_KEY = 'sk-fresh-SECRET-key-9876';

type Row = Record<string, unknown>;

/** A plan answer that passes Robert's zod schema, as the model would send it. */
const PLAN_ANSWER = {
  reply: 'ok',
  reply_language: 'en',
  object_language: 'en',
  context: { action: 'ok', n: null, since: null },
  intents: [],
  more_items: false,
  unsupported: 'none',
};

describe('AiConfigService', () => {
  const savedSecret = process.env['AI_ENCRYPTION_SECRET'];

  beforeAll(() => {
    process.env['AI_ENCRYPTION_SECRET'] = 'a'.repeat(64);
  });

  afterAll(() => {
    if (savedSecret === undefined) delete process.env['AI_ENCRYPTION_SECRET'];
    else process.env['AI_ENCRYPTION_SECRET'] = savedSecret;
  });

  afterEach(() => jest.restoreAllMocks());

  /** The stored row; `extra` adds the model column, which older databases do not have. */
  function storedRow(extra: Row = {}): Row {
    const { encrypted, iv, tag } = encryptApiKey(SAVED_KEY);

    return {
      id: 'config-1',
      organization_id: ORG,
      provider_name: 'openai',
      encrypted_api_key: encrypted,
      encryption_iv: iv,
      encryption_tag: tag,
      is_active: true,
      configured_by: 'user-0',
      updated_at: '2026-10-01T00:00:00Z',
      ...extra,
    };
  }

  function setup(existing: Row | null) {
    const written = (payload: Row) => ({
      select: () => ({
        single: () =>
          Promise.resolve({ data: { ...existing, ...payload }, error: null }),
      }),
    });
    const select = jest.fn(() => ({
      eq: () => ({
        maybeSingle: () => Promise.resolve({ data: existing, error: null }),
      }),
    }));
    const upsert = jest.fn((payload: Row) => written(payload));
    const updateEq = jest.fn();
    const update = jest.fn((payload: Row) => ({
      eq: updateEq.mockReturnValue(written(payload)),
    }));
    const from = jest.fn(() => ({ select, upsert, update }));
    const audit = { logAction: jest.fn().mockResolvedValue(undefined) };
    const tenantAi = new TenantAiService();
    const service = new AiConfigService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      audit as unknown as AuditLogsService,
      tenantAi,
    );

    return { service, tenantAi, audit, from, select, upsert, update, updateEq };
  }

  describe('saveConfig', () => {
    it('with a key saves as before and does not mention the model', async () => {
      const { service, upsert, update, audit } = setup(null);

      const result = await service.saveConfig(ORG, USER, {
        provider_name: AiProvider.OPENAI,
        api_key: NEW_KEY,
      });
      const [payload, options] = upsert.mock.calls[0] as unknown as [Row, Row];

      expect(Object.keys(payload)).toEqual([
        'organization_id',
        'provider_name',
        'encrypted_api_key',
        'encryption_iv',
        'encryption_tag',
        'is_active',
        'configured_by',
        'updated_at',
      ]);
      expect(payload).toMatchObject({
        organization_id: ORG,
        provider_name: 'openai',
        is_active: true,
        configured_by: USER,
      });
      expect(options).toEqual({ onConflict: 'organization_id' });
      expect(update).not.toHaveBeenCalled();
      expect(result).toEqual({
        data: {
          is_configured: true,
          provider_name: 'openai',
          masked_key: 'sk-f••••••••9876',
          model: null,
          is_active: true,
          configured_by: USER,
          updated_at: payload['updated_at'],
        },
      });
      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        USER,
        'ai_provider_config',
        ORG,
        'update',
        { provider_name: 'openai', action: 'configured' },
      );
    });

    it('with a key and a model saves both and audits the model, never the key', async () => {
      const { service, upsert, audit } = setup(storedRow());

      const result = await service.saveConfig(ORG, USER, {
        provider_name: AiProvider.OPENAI,
        api_key: NEW_KEY,
        model: 'gpt-4.1',
      });

      expect(upsert.mock.calls[0][0]).toMatchObject({ model: 'gpt-4.1' });
      expect(result['data']).toMatchObject({ model: 'gpt-4.1' });
      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        USER,
        'ai_provider_config',
        ORG,
        'update',
        { provider_name: 'openai', action: 'configured', model: 'gpt-4.1' },
      );
      expect(
        JSON.stringify([audit.logAction.mock.calls, result]),
      ).not.toContain(NEW_KEY);
    });

    it('without a key writes the model and nothing else — the key columns are not in the UPDATE', async () => {
      const existing = storedRow({ model: 'gpt-4o-mini' });
      const { service, upsert, update, updateEq, audit } = setup(existing);

      const result = await service.saveConfig(ORG, USER, {
        provider_name: AiProvider.OPENAI,
        model: 'gpt-4.1',
      });

      expect(upsert).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][0]).toEqual({ model: 'gpt-4.1' });
      expect(updateEq).toHaveBeenCalledWith('organization_id', ORG);
      expect(result).toEqual({
        data: {
          is_configured: true,
          provider_name: 'openai',
          masked_key: 'sk-s••••••••1234',
          model: 'gpt-4.1',
          is_active: true,
          configured_by: 'user-0',
          updated_at: '2026-10-01T00:00:00Z',
        },
      });
      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        USER,
        'ai_provider_config',
        ORG,
        'update',
        { provider_name: 'openai', action: 'model_changed', model: 'gpt-4.1' },
      );
    });

    it('without a key can put the model back to the provider default', async () => {
      const { service, update } = setup(storedRow({ model: 'gpt-4.1' }));

      const result = await service.saveConfig(ORG, USER, {
        provider_name: AiProvider.OPENAI,
        model: null,
      });

      expect(update.mock.calls[0][0]).toEqual({ model: null });
      expect(result['data']).toMatchObject({ model: null });
    });

    it('without a key and without a change writes and audits nothing', async () => {
      // No model column here: a save that does not change the model must not mention it.
      const { service, upsert, update, audit } = setup(storedRow());

      for (const model of [undefined, null]) {
        const result = await service.saveConfig(ORG, USER, {
          provider_name: AiProvider.OPENAI,
          model,
        });

        expect(result['data']).toMatchObject({
          provider_name: 'openai',
          masked_key: 'sk-s••••••••1234',
          model: null,
        });
      }

      expect(upsert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('refuses a provider change without a key, so a stored key never reaches another vendor', async () => {
      const { service, upsert, update, audit } = setup(storedRow());

      await expect(
        service.saveConfig(ORG, USER, {
          provider_name: AiProvider.ANTHROPIC,
          model: 'claude-sonnet-5',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(upsert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('refuses a first save without a key', async () => {
      const { service, upsert, update } = setup(null);

      await expect(
        service.saveConfig(ORG, USER, { provider_name: AiProvider.OPENAI }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(upsert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('drops the saved model when the provider changes, and keeps it otherwise', async () => {
      const changed = setup(storedRow({ model: 'gpt-4.1' }));

      await changed.service.saveConfig(ORG, USER, {
        provider_name: AiProvider.ANTHROPIC,
        api_key: NEW_KEY,
      });

      expect(changed.upsert.mock.calls[0][0]).toMatchObject({
        provider_name: 'anthropic',
        model: null,
      });

      const same = setup(storedRow({ model: 'gpt-4.1' }));

      await same.service.saveConfig(ORG, USER, {
        provider_name: AiProvider.OPENAI,
        api_key: NEW_KEY,
      });

      expect(same.upsert.mock.calls[0][0]).not.toHaveProperty('model');
    });
  });

  describe('getConfig', () => {
    it('returns the model and the masked key, never a stored key column', async () => {
      const row = storedRow({ model: 'gpt-4.1' });
      const { service, select } = setup(row);

      const result = await service.getConfig(ORG);

      expect(result).toEqual({
        data: {
          is_configured: true,
          provider_name: 'openai',
          masked_key: 'sk-s••••••••1234',
          model: 'gpt-4.1',
          is_active: true,
          configured_by: 'user-0',
          updated_at: '2026-10-01T00:00:00Z',
        },
      });

      const wire = JSON.stringify(result);

      for (const secret of [
        SAVED_KEY,
        row['encrypted_api_key'],
        row['encryption_iv'],
        row['encryption_tag'],
      ])
        expect(wire).not.toContain(secret);

      expect(select).toHaveBeenCalledWith('*');
    });

    it('works on a database without the model column', async () => {
      const { service } = setup(storedRow());

      expect((await service.getConfig(ORG))['data']).toMatchObject({
        is_configured: true,
        model: null,
      });
      expect(await setup(null).service.getConfig(ORG)).toEqual({
        data: { is_configured: false },
      });
    });
  });

  describe('getModels', () => {
    it('adds the recommended models the provider really lists, snapshots included', async () => {
      const { service, tenantAi } = setup(storedRow());

      jest.spyOn(tenantAi, 'listModels').mockResolvedValue({
        provider: 'anthropic',
        defaultModel: 'claude-sonnet-5',
        models: [
          'claude-3-haiku',
          'claude-haiku-4-5-20251001',
          'claude-sonnet-5',
        ],
        error: null,
      });

      await expect(service.getModels(ORG)).resolves.toEqual({
        provider: 'anthropic',
        defaultModel: 'claude-sonnet-5',
        models: [
          'claude-3-haiku',
          'claude-haiku-4-5-20251001',
          'claude-sonnet-5',
        ],
        recommended: ['claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        error: null,
      });

      jest.spyOn(tenantAi, 'listModels').mockResolvedValue({
        provider: 'openai',
        defaultModel: 'gpt-4o-mini',
        models: ['gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-mini', 'o3'],
        error: null,
      });

      expect((await service.getModels(ORG)).recommended).toEqual([
        'gpt-4o-mini',
        'gpt-4o',
      ]);
    });

    it('returns empty lists for Azure and when nothing is configured', async () => {
      const { service, tenantAi } = setup(storedRow());

      jest.spyOn(tenantAi, 'listModels').mockResolvedValue({
        provider: 'azure_openai',
        defaultModel: 'gpt-4o-mini',
        models: [],
        error: null,
      });

      await expect(service.getModels(ORG)).resolves.toMatchObject({
        provider: 'azure_openai',
        models: [],
        recommended: [],
      });

      jest.spyOn(tenantAi, 'listModels').mockResolvedValue({
        provider: null,
        defaultModel: null,
        models: [],
        error: 'No AI provider is configured for this organization.',
      });

      await expect(service.getModels(ORG)).resolves.toEqual({
        provider: null,
        defaultModel: null,
        models: [],
        recommended: [],
        error: 'No AI provider is configured for this organization.',
      });
    });
  });

  describe('testConnection', () => {
    const allOk = {
      key: { ok: true },
      model: { ok: true },
      structuredOutput: { ok: true },
    };
    const notTested = { ok: false, message: 'Not tested.' };

    /** A service whose saved configuration is `saved` and whose usage log is a spy. */
    function testSetup(
      saved: {
        provider: string;
        apiKey: string;
        model: string | null;
      } | null = {
        provider: 'openai',
        apiKey: SAVED_KEY,
        model: 'gpt-4.1',
      },
    ) {
      const ctx = setup(null);
      const resolveConfig = jest.spyOn(ctx.tenantAi, 'resolveConfig');
      const logUsage = jest
        .spyOn(ctx.tenantAi, 'logUsage')
        .mockResolvedValue(undefined);

      if (saved) resolveConfig.mockResolvedValue(saved);
      else
        resolveConfig.mockRejectedValue(
          new TenantAiError('not_configured', '(400) No AI provider yet.'),
        );

      return { ...ctx, logUsage };
    }

    const respond = (status: number, body: unknown) =>
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: status === 200,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
      } as Response);

    it('makes ONE small call with the real Robert plan schema and logs its usage', async () => {
      const { service, logUsage } = testSetup();
      const fetchMock = respond(200, {
        choices: [{ message: { content: JSON.stringify(PLAN_ANSWER) } }],
        usage: { prompt_tokens: 900, completion_tokens: 40 },
      });

      await expect(
        service.testConnection(ORG, USER, {
          provider_name: AiProvider.OPENAI,
          api_key: NEW_KEY,
          model: 'gpt-4o-mini',
        }),
      ).resolves.toEqual(allOk);

      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as {
        model: string;
        max_completion_tokens: number;
        response_format: { json_schema: unknown };
      };

      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        `Bearer ${NEW_KEY}`,
      );
      expect(body.model).toBe('gpt-4o-mini');
      expect(body.response_format.json_schema).toEqual({
        name: 'robert_plan',
        strict: true,
        schema: JSON.parse(JSON.stringify(AGENT_PLAN_JSON_SCHEMA)) as unknown,
      });
      expect(body.max_completion_tokens).toBe(1_000);
      expect(logUsage).toHaveBeenCalledTimes(1);
      expect(logUsage.mock.calls[0][1]).toEqual({
        organizationId: ORG,
        userId: USER,
        provider: 'openai',
        model: 'gpt-4o-mini',
        operationType: 'ai_connection_test',
        tokens: 940,
        metadata: { status: 'ok' },
      });
    });

    it('reports a wrong key as key not ok — no error, and no key in the answer or the logs', async () => {
      const { service, logUsage } = testSetup();
      const logs = (['log', 'warn', 'error'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level),
      );

      respond(401, {
        error: { message: `Incorrect API key provided: ${NEW_KEY}.` },
      });

      const result = await service.testConnection(ORG, USER, {
        provider_name: AiProvider.OPENAI,
        api_key: NEW_KEY,
      });

      expect(result).toEqual({
        key: { ok: false, message: 'The provider rejected this API key.' },
        model: notTested,
        structuredOutput: notTested,
      });
      expect(JSON.stringify(result)).not.toContain(NEW_KEY);
      expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain(
        NEW_KEY,
      );
      expect(logs[1]).toHaveBeenCalled();
      expect(logUsage).not.toHaveBeenCalled();
    });

    it('keeps the key out of a provider text it passes on', async () => {
      const { service } = testSetup();

      respond(400, {
        error: { message: `Bad request made with key ${NEW_KEY}` },
      });

      const result = await service.testConnection(ORG, USER, {
        provider_name: AiProvider.OPENAI,
        api_key: `  ${NEW_KEY} `,
      });

      expect(result.structuredOutput).toEqual({
        ok: false,
        message:
          'The AI provider rejected the request: Bad request made with key ***',
      });
      expect(JSON.stringify(result)).not.toContain(NEW_KEY);
    });

    it('falls back to the saved provider, key and model for what is missing', async () => {
      const { service, tenantAi } = testSetup();
      const generateJson = jest
        .spyOn(tenantAi, 'generateJson')
        .mockResolvedValue({
          data: PLAN_ANSWER,
          promptTokens: 1,
          completionTokens: 1,
          model: 'x',
        });

      await expect(service.testConnection(ORG, USER, {})).resolves.toEqual(
        allOk,
      );
      await service.testConnection(ORG, USER, { model: 'gpt-5-mini' });
      await service.testConnection(ORG, USER, { api_key: NEW_KEY });

      expect(
        generateJson.mock.calls.map(([req]) => [
          req.provider,
          req.apiKey,
          req.model,
        ]),
      ).toEqual([
        ['openai', SAVED_KEY, 'gpt-4.1'],
        ['openai', SAVED_KEY, 'gpt-5-mini'],
        ['openai', NEW_KEY, 'gpt-4.1'],
      ]);
    });

    it('never sends the saved key to another provider, nor its model', async () => {
      const { service, tenantAi } = testSetup();
      const generateJson = jest
        .spyOn(tenantAi, 'generateJson')
        .mockResolvedValue({
          data: PLAN_ANSWER,
          promptTokens: 1,
          completionTokens: 1,
          model: 'x',
        });
      const fetchMock = jest.spyOn(global, 'fetch');

      await expect(
        service.testConnection(ORG, USER, {
          provider_name: AiProvider.MISTRAL,
        }),
      ).resolves.toEqual({
        key: {
          ok: false,
          message: 'Enter the API key of this provider to test it.',
        },
        model: notTested,
        structuredOutput: notTested,
      });
      expect(generateJson).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      await service.testConnection(ORG, USER, {
        provider_name: AiProvider.MISTRAL,
        api_key: NEW_KEY,
      });

      expect(generateJson.mock.calls[0][0]).toMatchObject({
        provider: 'mistral',
        apiKey: NEW_KEY,
        model: 'mistral-small-latest',
      });
    });

    it('reports a missing configuration as key not ok when no key is sent', async () => {
      const { service, tenantAi } = testSetup(null);
      const generateJson = jest.spyOn(tenantAi, 'generateJson');

      await expect(service.testConnection(ORG, USER, {})).resolves.toEqual({
        key: { ok: false, message: 'No AI provider yet.' },
        model: notTested,
        structuredOutput: notTested,
      });
      expect(generateJson).not.toHaveBeenCalled();
    });

    it('reports an answer in the wrong structure as structured output not ok', async () => {
      const { service, tenantAi } = testSetup();

      jest.spyOn(tenantAi, 'generateJson').mockResolvedValue({
        data: { reply: 'ok' },
        promptTokens: 5,
        completionTokens: 5,
        model: 'x',
      });

      const result = await service.testConnection(ORG, USER, {});

      expect(result.key).toEqual({ ok: true });
      expect(result.model).toEqual({ ok: true });
      expect(result.structuredOutput.ok).toBe(false);
    });

    // [what generateJson throws, the checks that are not ok]
    const failures: [string, Error, string][] = [
      [
        'a rejected key',
        new TenantAiError('auth', '(401) x', 401),
        'key,model,structuredOutput',
      ],
      [
        'an exhausted quota',
        new TenantAiError('quota', '(429) x', 429),
        'key,model,structuredOutput',
      ],
      [
        'a rate limit',
        new TenantAiError('rate_limited', '(429) x', 429),
        'key,model,structuredOutput',
      ],
      [
        'an unreachable provider',
        new TenantAiError('provider_down', 'x'),
        'key,model,structuredOutput',
      ],
      [
        'a timeout',
        new TenantAiError('timeout', 'x'),
        'key,model,structuredOutput',
      ],
      ['an unexpected error', new Error('boom'), 'key,model,structuredOutput'],
      [
        'an unknown model',
        new TenantAiError('model_not_found', '(404) x', 404),
        'model,structuredOutput',
      ],
      [
        'a rejected schema',
        new TenantAiError('bad_request', '(400) x', 400),
        'structuredOutput',
      ],
      [
        'a refusal',
        new TenantAiError('refused', '(422) x'),
        'structuredOutput',
      ],
      [
        'an unparsable answer',
        new TenantAiError('invalid_output', '(422) x'),
        'structuredOutput',
      ],
      ['a cut-off answer', new TenantAiError('too_large', '(422) x'), ''],
    ];

    it.each(failures)(
      'reports %s on the right check instead of throwing',
      async (_name, error, notOk) => {
        const { service, tenantAi, logUsage } = testSetup();

        jest.spyOn(tenantAi, 'generateJson').mockRejectedValue(error);

        const result = await service.testConnection(ORG, USER, {});

        expect(Object.keys(result)).toEqual([
          'key',
          'model',
          'structuredOutput',
        ]);
        expect(
          Object.entries(result)
            .filter(([, check]) => !check.ok)
            .map(([name]) => name)
            .join(','),
        ).toBe(notOk);
        expect(logUsage).not.toHaveBeenCalled();
      },
    );

    it('logs the usage of a failed call the provider billed', async () => {
      const { service, tenantAi, logUsage } = testSetup();

      jest.spyOn(tenantAi, 'generateJson').mockRejectedValue(
        Object.assign(new TenantAiError('refused', '(422) x'), {
          promptTokens: 900,
          completionTokens: 12,
        }),
      );

      await service.testConnection(ORG, USER, {});

      expect(logUsage.mock.calls[0][1]).toMatchObject({
        operationType: 'ai_connection_test',
        provider: 'openai',
        model: 'gpt-4.1',
        tokens: 912,
        metadata: { status: 'refused' },
      });
    });
  });
});
