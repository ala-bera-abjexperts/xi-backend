/**
 * @fileoverview Calls the organization's own AI provider (Tenant Config → AI) for one structured
 * JSON answer about a file. Endpoints, headers and the Azure env mirror the wiki/plan AI services,
 * whose helpers are private.
 *
 * Messages are written for the automation worker: the FIRST "(ddd)" in a message decides — a 4xx
 * other than 429 fails the step at once, anything else is retried.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

import { decryptApiKey } from '../lib/crypto/encryption';

// Aliases where the provider has one, so a retired model version cannot break runs.
// mistral-large cannot read documents; mistral-small reads PDFs and images.
const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  azure_openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-5',
  google: 'gemini-flash-latest',
  mistral: 'mistral-small-latest',
};

// Tried in order when the node keeps the default and the model is busy, rate-limited or retired.
const DEFAULT_FALLBACK_MODELS: Record<string, string[]> = {
  google: ['gemini-flash-lite-latest'],
};

const PROVIDER_MESSAGE_MAX = 300;

// Gemini ends a candidate with one of these when it refuses the content.
const GEMINI_BLOCKED = new Set([
  'SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
]);

export type JsonSchema = Record<string, unknown>;

export interface TenantAiConfig {
  provider: string;
  apiKey: string;
  // The model saved in Tenant Config → AI; null means the provider default.
  model: string | null;
}

/** The model picker's data: the tenant's provider, its default and the models it offers. */
export interface TenantAiModels {
  provider: string | null;
  defaultModel: string | null;
  models: string[];
  error: string | null;
}

export interface AiFile {
  base64: string;
  mimeType: string;
  fileName: string;
}

export interface GenerateJsonRequest {
  provider: string;
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  // Absent when the document was turned into text first — a spreadsheet, which no provider reads.
  file?: AiFile;
  schema: JsonSchema;
  schemaName: string;
  schemaDescription: string;
  timeoutMs: number;
  // Aborting it ends the call as "cancelled", never as a timeout.
  signal?: AbortSignal;
  // Absent leaves the provider's own limit (Anthropic, which requires one: 8192).
  maxOutputTokens?: number;
}

export interface GenerateJsonResult {
  data: unknown;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export interface AiUsageEntry {
  organizationId: string;
  userId: string | null;
  provider: string;
  model: string;
  operationType: string;
  tokens: number;
  metadata: Record<string, unknown>;
}

interface ProviderCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type Json = Record<string, unknown>;

export type TenantAiErrorKind =
  | 'auth'
  | 'model_not_found'
  | 'rate_limited'
  | 'quota'
  | 'provider_down'
  | 'timeout'
  | 'cancelled'
  | 'too_large'
  | 'refused'
  | 'invalid_output'
  | 'bad_request'
  | 'not_configured';

/**
 * What generateJson and resolveConfig throw. The message is the one the plain Error carried before
 * (the automation worker reads its "(ddd)"); callers outside that worker branch on `kind`.
 */
export class TenantAiError extends Error {
  // What the provider billed for an answer that could not be used; unset when it reported nothing.
  promptTokens?: number;
  completionTokens?: number;

  constructor(
    readonly kind: TenantAiErrorKind,
    message: string,
    // The provider's HTTP status, when it answered with an error.
    readonly status?: number,
  ) {
    super(message);
  }
}

// ponytail: only wordings that always mean "nothing left to spend" (OpenAI/Azure insufficient_quota,
// Anthropic's credit balance). Gemini words a per-minute limit the same way as an exhausted quota,
// so it stays rate_limited; read its QuotaFailure details if the two must be told apart.
const QUOTA_EXHAUSTED =
  /insufficient_quota|exceeded your current quota|credit balance/i;

const CONTEXT_TOO_LONG =
  /context[ _]length|maximum context|prompt is too long|too many tokens|token count.{0,40}exceeds|too large for model/i;

/** A "(404)" inside file names or provider text would be read as the step's status code. */
export function neutraliseStatusCodes(text: string): string {
  return text.replace(/\((\d{3})\)/g, '[$1]');
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clip(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, PROVIDER_MESSAGE_MAX);
}

// A cut-off answer fails the same way on every retry.
function cutOff(): Error {
  return new TenantAiError(
    'too_large',
    '(422) The AI answer was cut off at its length limit — the document is too long for one answer.',
  );
}

function invalidResult(): Error {
  return new TenantAiError(
    'invalid_output',
    'AI returned an invalid result — it will be retried.',
  );
}

// A model that answers with non-JSON, or with JSON that is not an object, answers the same way on
// every retry — so this one is permanent and must not be billed three times.
function invalidAnswer(): Error {
  return new TenantAiError(
    'invalid_output',
    '(422) The model could not produce the requested JSON structure for this document.',
  );
}

function withoutKey(text: string, apiKey: string): string {
  // Trimmed: fetch and providers echo the key without the blanks around it.
  const key = apiKey.trim();

  return key ? text.split(key).join('***') : text;
}

/** Token counts of an answer; null when the provider sent none. */
function readUsage(
  provider: string,
  body: Json,
): { promptTokens: number; completionTokens: number } | null {
  const usage = asRecord(
    provider === 'google' ? body.usageMetadata : body.usage,
  );

  if (!usage) return null;

  if (provider === 'anthropic') {
    return {
      promptTokens: asNumber(usage.input_tokens),
      completionTokens: asNumber(usage.output_tokens),
    };
  }

  if (provider === 'google') {
    return {
      promptTokens: asNumber(usage.promptTokenCount),
      completionTokens: asNumber(usage.candidatesTokenCount),
    };
  }

  return {
    promptTokens: asNumber(usage.prompt_tokens),
    completionTokens: asNumber(usage.completion_tokens),
  };
}

/** Model text → JSON, tolerating ``` fences and prose around the object. */
function parseJsonText(text: string): unknown {
  const raw = text.trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1];
  const candidate = fenced ?? raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;

  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    throw invalidAnswer();
  }
}

/** Gemini's responseSchema is an OpenAPI subset: upper-case types, `nullable` instead of unions. */
export function toGeminiSchema(schema: JsonSchema): Json {
  const types = Array.isArray(schema.type)
    ? (schema.type as string[])
    : [String(schema.type)];
  const out: Json = {
    type: (types.find((t) => t !== 'null') ?? 'string').toUpperCase(),
  };

  if (types.includes('null')) out.nullable = true;
  if (typeof schema.description === 'string')
    out.description = schema.description;

  const properties = asRecord(schema.properties);

  if (properties) {
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        toGeminiSchema(value as JsonSchema),
      ]),
    );
    if (Array.isArray(schema.required)) out.required = schema.required;
  }

  const items = asRecord(schema.items);

  if (items) out.items = toGeminiSchema(items);

  return out;
}

@Injectable()
export class TenantAiService {
  private readonly logger = new Logger(TenantAiService.name);

  /** The organization's provider, decrypted key and saved model; a missing/disabled/unreadable config is a (400). */
  async resolveConfig(
    client: SupabaseClient,
    organizationId: string,
  ): Promise<TenantAiConfig> {
    const { data, error } = await client
      .from('ai_provider_configs')
      // '*' and not a column list: `model` is newer than the table and must not be named in a
      // select until every database has it.
      .select('*')
      .eq('organization_id', organizationId)
      .maybeSingle<Record<string, unknown>>();

    // No status code: a failed read is worth retrying.
    if (error) {
      throw new Error(
        `Could not read the organization's AI configuration — ${neutraliseStatusCodes(error.message)} — it will be retried.`,
      );
    }

    const row = data as {
      provider_name: string;
      encrypted_api_key: string;
      encryption_iv: string;
      encryption_tag: string;
      is_active: boolean | null;
      model?: unknown;
    } | null;

    if (!row) {
      throw new TenantAiError(
        'not_configured',
        '(400) No AI provider is configured for this organization — add one in Tenant Config → AI.',
      );
    }

    if (row.is_active === false) {
      throw new TenantAiError(
        'not_configured',
        "(400) The organization's AI provider is disabled (Tenant Config → AI).",
      );
    }

    try {
      return {
        provider: row.provider_name,
        apiKey: decryptApiKey(
          row.encrypted_api_key,
          row.encryption_iv,
          row.encryption_tag,
        ),
        model: typeof row.model === 'string' ? row.model : null,
      };
    } catch (err) {
      this.logger.error(
        `AI key decryption failed for organization ${organizationId}: ${errorMessage(err)}`,
      );

      throw new TenantAiError(
        'auth',
        '(400) The stored AI API key cannot be decrypted — re-enter it in Tenant Config → AI.',
      );
    }
  }

  /** The node's Model override when it holds a real value, else the provider default. */
  resolveModel(provider: string, override?: string | null): string {
    const wanted = override?.trim() ?? '';

    if (wanted !== '' && wanted !== '-' && !wanted.includes('{{'))
      return wanted;

    return DEFAULT_MODELS[provider] ?? '';
  }

  /** Live model list of the tenant's provider; never throws, so the picker can fall back to typing. */
  async listModels(
    client: SupabaseClient,
    organizationId: string,
  ): Promise<TenantAiModels> {
    let config: TenantAiConfig;

    try {
      config = await this.resolveConfig(client, organizationId);
    } catch (err) {
      return {
        provider: null,
        defaultModel: null,
        models: [],
        error: errorMessage(err).replace(/^\(\d{3}\)\s*/, ''),
      };
    }

    const { provider, apiKey } = config;
    const base = {
      provider,
      defaultModel: DEFAULT_MODELS[provider] ?? null,
    };

    // Azure deployment names are chosen per resource, so there is nothing to list.
    if (provider === 'azure_openai')
      return { ...base, models: [], error: null };

    try {
      const models = await this.fetchModelIds(provider, apiKey);

      return { ...base, models: [...new Set(models)].sort(), error: null };
    } catch (err) {
      // fetch quotes a header it refuses, and the key travels in one.
      this.logger.warn(
        `Listing ${provider} models failed for organization ${organizationId}: ${withoutKey(errorMessage(err), apiKey)}`,
      );

      return {
        ...base,
        models: [],
        error: `Could not load the ${provider} model list — type a model name instead.`,
      };
    }
  }

  // Only models that can read a PDF or image and answer in JSON are offered.
  private async fetchModelIds(
    provider: string,
    apiKey: string,
  ): Promise<string[]> {
    const get = async (url: string, headers: Record<string, string>) => {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status}: ${this.providerMessage(await res.text(), apiKey)}`,
        );
      }

      return asRecord((await res.json()) as unknown) ?? {};
    };

    switch (provider) {
      case 'openai': {
        const body = await get('https://api.openai.com/v1/models', {
          Authorization: `Bearer ${apiKey}`,
        });

        return asArray(body.data)
          .map((m) => asRecord(m)?.id)
          .filter((id): id is string => typeof id === 'string')
          .filter(
            (id) =>
              /^(gpt-4o|gpt-4\.1|gpt-[5-9]|o\d)/.test(id) &&
              !/(audio|realtime|tts|transcribe|search|image|codex|instruct)/.test(
                id,
              ),
          );
      }

      case 'anthropic': {
        const body = await get(
          'https://api.anthropic.com/v1/models?limit=1000',
          {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
        );

        return asArray(body.data)
          .map((m) => asRecord(m)?.id)
          .filter((id): id is string => typeof id === 'string');
      }

      case 'google': {
        const body = await get(
          'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
          { 'x-goog-api-key': apiKey },
        );

        return asArray(body.models)
          .map(asRecord)
          .filter((m) =>
            asArray(m?.supportedGenerationMethods).includes('generateContent'),
          )
          .map((m) => (typeof m?.name === 'string' ? m.name : ''))
          .map((name) => name.replace(/^models\//, ''))
          .filter(
            (id) =>
              id.startsWith('gemini') &&
              !/(embedding|tts|image|live|audio|robotics|computer-use|transcribe|customtools)/.test(
                id,
              ),
          );
      }

      case 'mistral': {
        const body = await get('https://api.mistral.ai/v1/models', {
          Authorization: `Bearer ${apiKey}`,
        });

        return asArray(body.data)
          .map(asRecord)
          .filter(
            (m) =>
              asRecord(m?.capabilities)?.vision === true &&
              asRecord(m?.capabilities)?.completion_chat !== false,
          )
          .map((m) => m?.id)
          .filter((id): id is string => typeof id === 'string');
      }

      default:
        return [];
    }
  }

  /** Models to try in order: only the override when the node sets one, else the default and its fallbacks. */
  candidateModels(provider: string, override?: string | null): string[] {
    const model = this.resolveModel(provider, override);

    if (model !== (DEFAULT_MODELS[provider] ?? '')) return [model];

    return [model, ...(DEFAULT_FALLBACK_MODELS[provider] ?? [])];
  }

  /** Every failure is a TenantAiError. */
  async generateJson(req: GenerateJsonRequest): Promise<GenerateJsonResult> {
    const call = this.buildCall(req);
    const timeout = AbortSignal.timeout(req.timeoutMs);
    let ok: boolean;
    let status: number;
    let text: string;

    try {
      const res = await fetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: JSON.stringify(call.body),
        signal: req.signal ? AbortSignal.any([timeout, req.signal]) : timeout,
      });

      ok = res.ok;
      status = res.status;
      text = await res.text();
    } catch (err) {
      throw this.transportError(err, req);
    }

    if (!ok) throw this.httpError(status, text, req);

    let json: unknown;

    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw invalidResult();
    }

    try {
      return this.readResult(req, json);
    } catch (err) {
      // The provider has billed this answer even though it cannot be used.
      if (err instanceof TenantAiError)
        Object.assign(err, readUsage(req.provider, asRecord(json) ?? {}));

      throw err;
    }
  }

  /** Never fails the caller: usage logging is bookkeeping, not part of the result. */
  async logUsage(client: SupabaseClient, entry: AiUsageEntry): Promise<void> {
    // user_id is NOT NULL, so a run without an acting user has nobody to log against.
    if (!entry.userId) return;

    try {
      const { error } = await client.from('ai_usage_logs').insert({
        organization_id: entry.organizationId,
        user_id: entry.userId,
        operation_type: entry.operationType,
        provider_name: entry.provider,
        tokens_used: entry.tokens,
        metadata: { ...entry.metadata, model: entry.model },
      });

      if (error) {
        this.logger.warn(
          `AI usage logging failed (${entry.operationType}): ${error.message}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `AI usage logging failed (${entry.operationType}): ${errorMessage(err)}`,
      );
    }
  }

  private buildCall(req: GenerateJsonRequest): ProviderCall {
    const { provider, apiKey, model, system, prompt, file, schema } = req;
    const isPdf = file?.mimeType === 'application/pdf';
    const dataUrl = file ? `data:${file.mimeType};base64,${file.base64}` : '';
    const text = { type: 'text', text: prompt };

    // No file means the content is already inside `prompt`, so the parts list is the text alone.
    const parts = (filePart: unknown) => (file ? [filePart, text] : [text]);

    // The caller's output limit under the provider's own field name; nothing when there is none.
    const outputLimit = (field: string) =>
      req.maxOutputTokens === undefined ? {} : { [field]: req.maxOutputTokens };

    switch (provider) {
      case 'anthropic':
        return {
          url: 'https://api.anthropic.com/v1/messages',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: {
            model,
            max_tokens: req.maxOutputTokens ?? 8192,
            temperature: 0,
            system,
            tools: [
              {
                name: req.schemaName,
                description: req.schemaDescription,
                input_schema: schema,
              },
            ],
            tool_choice: { type: 'tool', name: req.schemaName },
            messages: [
              {
                role: 'user',
                content: parts(
                  isPdf
                    ? {
                        type: 'document',
                        source: {
                          type: 'base64',
                          media_type: 'application/pdf',
                          data: file?.base64,
                        },
                      }
                    : {
                        type: 'image',
                        source: {
                          type: 'base64',
                          media_type: file?.mimeType,
                          data: file?.base64,
                        },
                      },
                ),
              },
            ],
          },
        };

      case 'openai':
      case 'azure_openai':
        return {
          url:
            provider === 'azure_openai'
              ? this.buildAzureOpenAiUrl(model)
              : 'https://api.openai.com/v1/chat/completions',
          headers:
            provider === 'azure_openai'
              ? { 'Content-Type': 'application/json', 'api-key': apiKey }
              : {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${apiKey}`,
                },
          // No temperature: reasoning models (o-series, gpt-5) reject anything but the default — and
          // they take the limit only as max_completion_tokens.
          body: {
            model,
            ...outputLimit('max_completion_tokens'),
            response_format: {
              type: 'json_schema',
              json_schema: { name: req.schemaName, strict: true, schema },
            },
            messages: [
              { role: 'system', content: system },
              {
                role: 'user',
                content: parts(
                  isPdf
                    ? {
                        type: 'file',
                        file: { filename: file?.fileName, file_data: dataUrl },
                      }
                    : { type: 'image_url', image_url: { url: dataUrl } },
                ),
              },
            ],
          },
        };

      case 'google':
        return {
          url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: {
            systemInstruction: { parts: [{ text: system }] },
            contents: [
              {
                role: 'user',
                parts: file
                  ? [
                      {
                        inlineData: {
                          mimeType: file.mimeType,
                          data: file.base64,
                        },
                      },
                      { text: prompt },
                    ]
                  : [{ text: prompt }],
              },
            ],
            generationConfig: {
              temperature: 0,
              ...outputLimit('maxOutputTokens'),
              responseMimeType: 'application/json',
              responseSchema: toGeminiSchema(schema),
            },
          },
        };

      case 'mistral':
        return {
          url: 'https://api.mistral.ai/v1/chat/completions',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: {
            model,
            temperature: 0,
            ...outputLimit('max_tokens'),
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: `${system}\nReturn ONLY a JSON object matching this JSON schema: ${JSON.stringify(schema)}`,
              },
              {
                role: 'user',
                content: parts(
                  isPdf
                    ? { type: 'document_url', document_url: dataUrl }
                    : { type: 'image_url', image_url: dataUrl },
                ),
              },
            ],
          },
        };

      default:
        throw new TenantAiError(
          'bad_request',
          `(400) Unsupported AI provider: ${provider}`,
        );
    }
  }

  private buildAzureOpenAiUrl(model: string): string {
    const resourceName = process.env['AZURE_RESOURCE_NAME'];
    const apiVersion = process.env['AZURE_OPENAI_API_VERSION'] || '2024-10-21';

    if (!resourceName) {
      throw new TenantAiError(
        'not_configured',
        '(400) Azure OpenAI requires the AZURE_RESOURCE_NAME server setting.',
      );
    }

    return `https://${resourceName}.openai.azure.com/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${apiVersion}`;
  }

  private readResult(
    req: GenerateJsonRequest,
    json: unknown,
  ): GenerateJsonResult {
    const body = asRecord(json) ?? {};
    const usage = readUsage(req.provider, body);
    let data: unknown;

    if (req.provider === 'anthropic') {
      if (body.stop_reason === 'max_tokens') throw cutOff();
      data = asArray(body.content)
        .map(asRecord)
        .find((part) => part?.type === 'tool_use')?.input;
    } else if (req.provider === 'google') {
      const candidate = asRecord(asArray(body.candidates)[0]);
      const blockReason = asRecord(body.promptFeedback)?.blockReason;
      const finishReason = candidate?.finishReason;

      if (finishReason === 'MAX_TOKENS') throw cutOff();

      if (!candidate) {
        throw new TenantAiError(
          'refused',
          `(422) The AI could not read this document (blocked: ${typeof blockReason === 'string' ? blockReason : 'no answer'}).`,
        );
      }

      if (
        typeof finishReason === 'string' &&
        GEMINI_BLOCKED.has(finishReason)
      ) {
        throw new TenantAiError(
          'refused',
          `(422) The AI could not read this document (blocked: ${finishReason}).`,
        );
      }

      data = parseJsonText(
        asArray(asRecord(candidate.content)?.parts)
          .map((part) => asRecord(part)?.text)
          .filter((part): part is string => typeof part === 'string')
          .join(''),
      );
    } else {
      const choice = asRecord(asArray(body.choices)[0]);
      const message = asRecord(choice?.message);

      if (choice?.finish_reason === 'length') throw cutOff();
      const refusal = message?.refusal;
      const content = message?.content;

      if (typeof refusal === 'string' && refusal.trim() !== '') {
        throw new TenantAiError(
          'refused',
          `(422) The AI refused to read this document: ${clip(neutraliseStatusCodes(refusal))}`,
        );
      }

      // Mistral may answer with a list of content chunks instead of one string.
      data = parseJsonText(
        typeof content === 'string'
          ? content
          : asArray(content)
              .map((chunk) => asRecord(chunk)?.text)
              .filter((chunk): chunk is string => typeof chunk === 'string')
              .join(''),
      );
    }

    if (!asRecord(data)) throw invalidAnswer();

    return {
      data,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      model: req.model,
    };
  }

  private httpError(
    status: number,
    body: string,
    req: GenerateJsonRequest,
  ): Error {
    const detail = this.providerMessage(body, req.apiKey);

    this.logger.warn(`${req.provider} returned HTTP ${status}: ${detail}`);

    // Read from the whole body: the telling word is often in `error.code`, not in the message.
    const quotaExhausted =
      req.provider !== 'google' && QUOTA_EXHAUSTED.test(body);

    if (status === 401 || status === 403) {
      return new TenantAiError(
        'auth',
        `(401) The AI provider rejected the API key (${detail})`,
        status,
      );
    }

    if (status === 404) {
      return new TenantAiError(
        'model_not_found',
        `(404) The AI model "${req.model}" was not found for ${req.provider} — set a Model override on the node.`,
        status,
      );
    }

    if (status === 429) {
      return new TenantAiError(
        quotaExhausted ? 'quota' : 'rate_limited',
        '(429) The AI provider rate-limited the request — it will be retried.',
        status,
      );
    }

    if (status === 408 || status >= 500) {
      return new TenantAiError(
        'provider_down',
        `AI provider ${req.provider} error ${status} — it will be retried.`,
        status,
      );
    }

    let kind: TenantAiErrorKind = 'bad_request';

    if (status === 413 || CONTEXT_TOO_LONG.test(body)) kind = 'too_large';
    // Anthropic answers an empty credit balance with a 400, others with a 402.
    else if (status === 402 || quotaExhausted) kind = 'quota';
    // Gemini answers a wrong or expired key with a 400.
    else if (/API_KEY_INVALID|API key not valid/i.test(body)) kind = 'auth';

    return new TenantAiError(
      kind,
      `(400) The AI provider rejected the request: ${detail}`,
      status,
    );
  }

  /** The provider's own error text, trimmed, with the key and any "(ddd)" removed. */
  private providerMessage(body: string, apiKey: string): string {
    let text = body;

    try {
      const parsed = asRecord(JSON.parse(body) as unknown);
      const error = parsed?.error;
      const message =
        asRecord(error)?.message ??
        (typeof error === 'string' ? error : undefined) ??
        parsed?.message ??
        parsed?.detail;

      if (typeof message === 'string') text = message;
    } catch {
      // Not JSON (e.g. a gateway HTML page) — the raw text is all there is.
    }

    return (
      clip(neutraliseStatusCodes(withoutKey(text, apiKey))) || 'no details'
    );
  }

  private transportError(err: unknown, req: GenerateJsonRequest): Error {
    const name = err instanceof Error ? err.name : '';

    // First: the caller's abort also arrives as an AbortError, and must never read as a timeout.
    if (req.signal?.aborted) {
      return new TenantAiError('cancelled', 'AI request was cancelled.');
    }

    if (name === 'TimeoutError' || name === 'AbortError') {
      return new TenantAiError(
        'timeout',
        `AI request timed out after ${Math.round(req.timeoutMs / 1000)} s — it will be retried.`,
      );
    }

    const cause = err instanceof Error ? err.cause : undefined;
    const detail = [errorMessage(err), cause ? errorMessage(cause) : '']
      .filter(Boolean)
      .join(': ');

    // fetch quotes a header it refuses, and the key travels in one.
    return new TenantAiError(
      'provider_down',
      `AI provider unreachable: ${clip(neutraliseStatusCodes(withoutKey(detail, req.apiKey)))} — it will be retried.`,
    );
  }
}
