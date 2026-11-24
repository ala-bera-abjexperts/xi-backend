import { Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

import { encryptApiKey } from '../lib/crypto/encryption';
import { TenantAiError, TenantAiService } from './tenant-ai.service';
import type { GenerateJsonRequest } from './tenant-ai.service';

const KEY = 'sk-test-SECRET-key-123';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['a'],
  properties: { a: { type: 'string' } },
};

function request(
  overrides: Partial<GenerateJsonRequest> = {},
): GenerateJsonRequest {
  return {
    provider: 'openai',
    apiKey: KEY,
    model: 'gpt-4o-mini',
    system: 'system text',
    prompt: 'prompt text',
    schema: SCHEMA,
    schemaName: 'test_answer',
    schemaDescription: 'A test answer',
    timeoutMs: 5_000,
    ...overrides,
  };
}

/** A provider answer as fetch hands it over. */
function answer(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () =>
      Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
}

/** A usable answer of each provider, with 11 prompt and 7 completion tokens. */
function goodAnswer(provider: string): unknown {
  if (provider === 'anthropic') {
    return {
      content: [{ type: 'tool_use', input: { a: 'x' } }],
      usage: { input_tokens: 11, output_tokens: 7 },
    };
  }

  if (provider === 'google') {
    return {
      candidates: [
        { content: { parts: [{ text: '{"a":"x"}' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
    };
  }

  return {
    choices: [{ message: { content: '{"a":"x"}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  };
}

describe('TenantAiService', () => {
  const service = new TenantAiService();
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  /** The error generateJson rejects with. */
  const failure = (req: GenerateJsonRequest): Promise<TenantAiError> =>
    service.generateJson(req).then(
      () => {
        throw new Error('expected generateJson to fail');
      },
      (err: unknown) => err as TenantAiError,
    );

  const respond = (status: number, body: unknown) =>
    fetchMock.mockResolvedValue(answer(status, body));

  /** A provider that never answers: the call ends only when its signal aborts. */
  const hang = () =>
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;

          // Rebuilt as an Error of this realm: Node's own DOMException is not an `instanceof
          // Error` inside the Jest sandbox, which it is at runtime.
          const fail = () => {
            const reason = signal.reason as { name: string; message: string };

            reject(
              Object.assign(new Error(reason.message), { name: reason.name }),
            );
          };

          if (signal.aborted) fail();
          else signal.addEventListener('abort', fail);
        }),
    );

  const sentBody = (): Record<string, unknown> =>
    JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<
      string,
      unknown
    >;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    process.env['AZURE_RESOURCE_NAME'] = 'test-resource';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env['AZURE_RESOURCE_NAME'];
  });

  it('returns the answer with the tokens the provider reported', async () => {
    respond(200, goodAnswer('openai'));

    await expect(service.generateJson(request())).resolves.toEqual({
      data: { a: 'x' },
      promptTokens: 11,
      completionTokens: 7,
      model: 'gpt-4o-mini',
    });
  });

  it('counts zero tokens, and claims none on an error, when the provider reports no usage', async () => {
    respond(200, { choices: [{ message: { content: '{"a":"x"}' } }] });

    await expect(service.generateJson(request())).resolves.toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
    });

    respond(200, { choices: [{ message: { refusal: 'No.' } }] });

    const err = await failure(request());

    expect(err.kind).toBe('refused');
    expect(err.promptTokens).toBeUndefined();
    expect(err.completionTokens).toBeUndefined();
  });

  describe('caller signal and timeout', () => {
    it('reports an aborted caller signal as cancelled, never as a timeout', async () => {
      const controller = new AbortController();

      hang();

      // A long timeout: were the caller's signal not passed on, this test would hang and fail.
      const pending = failure(
        request({ signal: controller.signal, timeoutMs: 60_000 }),
      );

      controller.abort();

      const err = await pending;

      expect(err).toBeInstanceOf(TenantAiError);
      expect(err.kind).toBe('cancelled');
      expect(err.message).not.toMatch(/timed out/);
    });

    it('reports a signal aborted before the call, or with its own reason, as cancelled', async () => {
      const early = new AbortController();
      const reasoned = new AbortController();

      hang();
      early.abort();

      expect((await failure(request({ signal: early.signal }))).kind).toBe(
        'cancelled',
      );

      const pending = failure(
        request({ signal: reasoned.signal, timeoutMs: 60_000 }),
      );

      reasoned.abort(new Error('the user pressed Stop'));

      expect((await pending).kind).toBe('cancelled');
    });

    it('reports the timeout as timeout, with and without a caller signal', async () => {
      hang();

      for (const signal of [undefined, new AbortController().signal]) {
        const err = await failure(request({ timeoutMs: 20, signal }));

        expect(err).toBeInstanceOf(TenantAiError);
        expect(err.kind).toBe('timeout');
        expect(err.message).toBe(
          'AI request timed out after 0 s — it will be retried.',
        );
      }
    });
  });

  describe('maxOutputTokens', () => {
    // [provider, where the limit goes, the body keys sent today]
    const cases: [string, string[], string[]][] = [
      [
        'anthropic',
        ['max_tokens'],
        [
          'model',
          'max_tokens',
          'temperature',
          'system',
          'tools',
          'tool_choice',
          'messages',
        ],
      ],
      [
        'openai',
        ['max_completion_tokens'],
        ['model', 'response_format', 'messages'],
      ],
      [
        'azure_openai',
        ['max_completion_tokens'],
        ['model', 'response_format', 'messages'],
      ],
      [
        'google',
        ['generationConfig', 'maxOutputTokens'],
        ['systemInstruction', 'contents', 'generationConfig'],
      ],
      [
        'mistral',
        ['max_tokens'],
        ['model', 'temperature', 'response_format', 'messages'],
      ],
    ];

    const at = (body: unknown, path: string[]): unknown =>
      path.reduce(
        (value, key) => (value as Record<string, unknown> | undefined)?.[key],
        body,
      );

    it.each(cases)(
      '%s gets the limit in its own field',
      async (provider, path) => {
        respond(200, goodAnswer(provider));

        await service.generateJson(request({ provider, maxOutputTokens: 321 }));

        expect(at(sentBody(), path)).toBe(321);
        expect(JSON.stringify(sentBody()).match(/321/g)).toHaveLength(1);
      },
    );

    it.each(cases)(
      '%s is sent nothing new without a limit',
      async (provider, path, keys) => {
        respond(200, goodAnswer(provider));

        await service.generateJson(request({ provider }));

        const body = sentBody();

        expect(Object.keys(body)).toEqual(keys);

        // Anthropic requires a limit, so it keeps the one it always had.
        expect(at(body, path)).toBe(
          provider === 'anthropic' ? 8192 : undefined,
        );

        if (provider === 'google') {
          expect(Object.keys(body.generationConfig as object)).toEqual([
            'temperature',
            'responseMimeType',
            'responseSchema',
          ]);
        }
      },
    );
  });

  describe('error kinds', () => {
    const rejected = '(400) The AI provider rejected the request: ';
    const rateLimited =
      '(429) The AI provider rate-limited the request — it will be retried.';

    // [provider, status, body, kind, message exactly as before the typed error]
    const statuses: [string, number, unknown, string, string][] = [
      [
        'openai',
        401,
        { error: { message: 'Incorrect API key provided' } },
        'auth',
        '(401) The AI provider rejected the API key (Incorrect API key provided)',
      ],
      [
        'openai',
        403,
        { error: { message: 'Country not supported' } },
        'auth',
        '(401) The AI provider rejected the API key (Country not supported)',
      ],
      [
        'openai',
        404,
        { error: { message: 'The model does not exist' } },
        'model_not_found',
        '(404) The AI model "gpt-4o-mini" was not found for openai — set a Model override on the node.',
      ],
      [
        'openai',
        429,
        { error: { message: 'Rate limit reached for requests' } },
        'rate_limited',
        rateLimited,
      ],
      [
        'openai',
        429,
        { error: { message: 'Check your plan.', code: 'insufficient_quota' } },
        'quota',
        rateLimited,
      ],
      [
        // Gemini words a per-minute limit like an exhausted quota, so it stays a rate limit.
        'google',
        429,
        { error: { message: 'You exceeded your current quota.' } },
        'rate_limited',
        rateLimited,
      ],
      [
        'openai',
        500,
        'oops',
        'provider_down',
        'AI provider openai error 500 — it will be retried.',
      ],
      [
        'anthropic',
        529,
        { error: { message: 'Overloaded' } },
        'provider_down',
        'AI provider anthropic error 529 — it will be retried.',
      ],
      [
        'openai',
        408,
        '',
        'provider_down',
        'AI provider openai error 408 — it will be retried.',
      ],
      [
        'anthropic',
        413,
        { error: { message: 'Request too large' } },
        'too_large',
        `${rejected}Request too large`,
      ],
      [
        'openai',
        400,
        { error: { message: 'Too long.', code: 'context_length_exceeded' } },
        'too_large',
        `${rejected}Too long.`,
      ],
      [
        'anthropic',
        400,
        { error: { message: 'prompt is too long: 210000 tokens > 200000' } },
        'too_large',
        `${rejected}prompt is too long: 210000 tokens > 200000`,
      ],
      [
        'anthropic',
        400,
        { error: { message: 'Your credit balance is too low.' } },
        'quota',
        `${rejected}Your credit balance is too low.`,
      ],
      [
        'google',
        400,
        {
          error: { message: 'API key not valid. Please pass a valid API key.' },
        },
        'auth',
        `${rejected}API key not valid. Please pass a valid API key.`,
      ],
      [
        'openai',
        400,
        { error: { message: 'Invalid schema for response_format' } },
        'bad_request',
        `${rejected}Invalid schema for response_format`,
      ],
    ];

    it.each(statuses)(
      '%s HTTP %i %j is %s',
      async (provider, status, body, kind, message) => {
        respond(status, body);

        const err = await failure(request({ provider }));

        expect(err).toBeInstanceOf(TenantAiError);
        expect(err).toMatchObject({ kind, status, message });

        // An error answer carries no usage, so nothing is claimed as spent.
        expect(err.promptTokens).toBeUndefined();
        expect(err.completionTokens).toBeUndefined();
      },
    );

    it('reports a refusal as refused, with the tokens it cost', async () => {
      respond(200, {
        choices: [{ message: { refusal: 'I cannot help with that.' } }],
        usage: { prompt_tokens: 40, completion_tokens: 9 },
      });

      expect(await failure(request())).toMatchObject({
        kind: 'refused',
        message:
          '(422) The AI refused to read this document: I cannot help with that.',
        promptTokens: 40,
        completionTokens: 9,
      });

      respond(200, {
        promptFeedback: { blockReason: 'SAFETY' },
        usageMetadata: { promptTokenCount: 30 },
      });

      expect(await failure(request({ provider: 'google' }))).toMatchObject({
        kind: 'refused',
        message: '(422) The AI could not read this document (blocked: SAFETY).',
        promptTokens: 30,
        completionTokens: 0,
      });
    });

    it('reports an unparsable answer as invalid_output', async () => {
      const unusable =
        '(422) The model could not produce the requested JSON structure for this document.';

      for (const content of ['Sure! Here you go.', '[1, 2]']) {
        respond(200, {
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 12, completion_tokens: 5 },
        });

        expect(await failure(request())).toMatchObject({
          kind: 'invalid_output',
          message: unusable,
          promptTokens: 12,
          completionTokens: 5,
        });
      }

      respond(200, '<html>gateway</html>');

      const notJson = await failure(request());

      expect(notJson).toMatchObject({
        kind: 'invalid_output',
        message: 'AI returned an invalid result — it will be retried.',
      });
      expect(notJson.promptTokens).toBeUndefined();
    });

    it('reports a cut-off answer as too_large, with the tokens it cost', async () => {
      const cutOff =
        '(422) The AI answer was cut off at its length limit — the document is too long for one answer.';

      respond(200, {
        choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 50, completion_tokens: 200 },
      });

      expect(await failure(request())).toMatchObject({
        kind: 'too_large',
        message: cutOff,
        promptTokens: 50,
        completionTokens: 200,
      });

      respond(200, {
        stop_reason: 'max_tokens',
        content: [],
        usage: { input_tokens: 60, output_tokens: 300 },
      });

      expect(await failure(request({ provider: 'anthropic' }))).toMatchObject({
        kind: 'too_large',
        message: cutOff,
        promptTokens: 60,
        completionTokens: 300,
      });
    });

    it('reports an unreachable provider as provider_down', async () => {
      fetchMock.mockRejectedValue(
        new TypeError('fetch failed', {
          cause: new Error('getaddrinfo ENOTFOUND api.openai.com'),
        }),
      );

      expect(await failure(request())).toMatchObject({
        kind: 'provider_down',
        message:
          'AI provider unreachable: fetch failed: getaddrinfo ENOTFOUND api.openai.com — it will be retried.',
      });
    });

    it('types the failures raised before any request is sent', async () => {
      expect(await failure(request({ provider: 'acme' }))).toMatchObject({
        kind: 'bad_request',
        message: '(400) Unsupported AI provider: acme',
      });

      delete process.env['AZURE_RESOURCE_NAME'];

      expect(
        await failure(request({ provider: 'azure_openai' })),
      ).toMatchObject({
        kind: 'not_configured',
        message:
          '(400) Azure OpenAI requires the AZURE_RESOURCE_NAME server setting.',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('never puts the key into an error message or a log line', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const messages: string[] = [];

    // The provider and fetch both echo the key without the blanks typed around it.
    for (const apiKey of [KEY, `  ${KEY}\n`]) {
      for (const status of [400, 401, 403, 404, 413, 429, 500]) {
        respond(status, {
          error: { message: `Incorrect API key provided: ${KEY}.` },
        });
        messages.push((await failure(request({ apiKey }))).message);
      }

      fetchMock.mockRejectedValue(
        new TypeError(
          `Headers.append: "Bearer ${KEY}" is an invalid header value.`,
        ),
      );
      messages.push((await failure(request({ apiKey }))).message);
    }

    expect(messages).toHaveLength(16);
    expect(messages.join('\n')).not.toContain(KEY);
    expect(messages[0]).toContain('Incorrect API key provided: ***.');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    expect(warn).toHaveBeenCalled();
  });

  describe('resolveConfig', () => {
    const savedSecret = process.env['AI_ENCRYPTION_SECRET'];
    let select: jest.Mock;

    function clientWith(row: Record<string, unknown> | null) {
      select = jest.fn().mockReturnValue({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
        }),
      });

      return { from: () => ({ select }) } as unknown as SupabaseClient;
    }

    function storedRow(extra: Record<string, unknown> = {}) {
      const { encrypted, iv, tag } = encryptApiKey(KEY);

      return {
        provider_name: 'openai',
        encrypted_api_key: encrypted,
        encryption_iv: iv,
        encryption_tag: tag,
        is_active: true,
        ...extra,
      };
    }

    const rejection = (row: Record<string, unknown> | null) =>
      service.resolveConfig(clientWith(row), 'org-1').then(
        () => {
          throw new Error('expected resolveConfig to fail');
        },
        (err: unknown) => err as TenantAiError,
      );

    beforeAll(() => {
      process.env['AI_ENCRYPTION_SECRET'] = 'a'.repeat(64);
    });

    afterAll(() => {
      if (savedSecret === undefined) delete process.env['AI_ENCRYPTION_SECRET'];
      else process.env['AI_ENCRYPTION_SECRET'] = savedSecret;
    });

    it('returns the saved model next to the provider and the key', async () => {
      await expect(
        service.resolveConfig(clientWith(storedRow({ model: 'gpt-4.1' })), 'o'),
      ).resolves.toEqual({ provider: 'openai', apiKey: KEY, model: 'gpt-4.1' });
    });

    it('works on a database without the model column and never names it in the select', async () => {
      await expect(
        service.resolveConfig(clientWith(storedRow()), 'org-1'),
      ).resolves.toEqual({ provider: 'openai', apiKey: KEY, model: null });

      expect(select).toHaveBeenCalledTimes(1);
      expect(select).toHaveBeenCalledWith(expect.not.stringMatching(/model/));

      await expect(
        service.resolveConfig(clientWith(storedRow({ model: null })), 'org-1'),
      ).resolves.toMatchObject({ model: null });
    });

    it('types a missing, disabled or unreadable configuration and keeps the message', async () => {
      expect(await rejection(null)).toMatchObject({
        kind: 'not_configured',
        message:
          '(400) No AI provider is configured for this organization — add one in Tenant Config → AI.',
      });
      expect(await rejection(storedRow({ is_active: false }))).toMatchObject({
        kind: 'not_configured',
        message:
          "(400) The organization's AI provider is disabled (Tenant Config → AI).",
      });

      const unreadable = await rejection(
        storedRow({ encryption_tag: '00'.repeat(16) }),
      );

      expect(unreadable).toBeInstanceOf(TenantAiError);
      expect(unreadable).toMatchObject({
        kind: 'auth',
        message:
          '(400) The stored AI API key cannot be decrypted — re-enter it in Tenant Config → AI.',
      });
    });

    // A key saved with a line break inside it: fetch refuses the header and quotes it whole.
    it('listModels keeps the saved key out of its log line and its answer', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');

      fetchMock.mockRejectedValue(
        new TypeError(
          `Headers.append: "Bearer ${KEY}" is an invalid header value.`,
        ),
      );

      const listed = await service.listModels(clientWith(storedRow()), 'org-1');

      expect(listed).toMatchObject({ provider: 'openai', models: [] });
      expect(JSON.stringify(listed)).not.toContain(KEY);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    });
  });
});
