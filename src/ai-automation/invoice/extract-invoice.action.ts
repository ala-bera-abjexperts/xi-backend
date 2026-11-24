/**
 * @fileoverview Automation action "AI Invoice Data Extraction" (`ai.invoice.extract`): reads the
 * ticket's invoice attachment with the organization's own AI and returns flat, typed fields for
 * later tasks (`{{ nodes['<id>'].output.<field> }}`).
 *
 * Self-registers on module init like Find Asset Object by name, because it needs injected services.
 * Messages carry "(4xx)" for one-attempt failures; anything else is retried by the worker.
 */
import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { ActionRegistryService } from '../../automations/actions/action-registry.service';
import type {
  ActionDefinition,
  ExecutionContext,
} from '../../automations/actions/types';
import { EntitlementsService } from '../../licensing/entitlements.service';
import { errorMessage, TenantAiService } from '../tenant-ai.service';
import type { GenerateJsonResult } from '../tenant-ai.service';
import {
  buildInvoiceOutput,
  checkInvoiceFileSize,
  checkProviderFileType,
  detectInvoiceFileType,
  INVOICE_JSON_SCHEMA,
  INVOICE_SYSTEM_PROMPT,
  INVOICE_USER_PROMPT,
  maxInvoicesInstruction,
} from './invoice-extraction';
import type { InvoiceOutput } from './invoice-extraction';
import { checkInvoiceStructure } from './invoice-structure-check';
import { documentToText, isTextDocument } from './spreadsheet-text';
import {
  downloadAttachment,
  listTaskAttachments,
  loadTask,
  pickAttachment,
} from './task-attachment-finder';

const LABEL = 'AI Invoice Extraction';

const AI_TIMEOUT_MS = 120_000;

// Model not found, rate limit or provider overload — worth trying the next default model.
const MODEL_UNAVAILABLE =
  /^\(404\) .*The AI model|^\(429\)|provider \S+ error 5\d\d/;

// No .min(): a Zod failure is permanent with an unreadable message, so values are checked in code.
const configSchema = z.object({
  taskId: z.string(),
  fileNamePattern: z.string().nullish(),
  attachmentId: z.string().nullish(),
  onMultipleMatches: z.enum(['newest', 'fail']).nullish(),
  model: z.string().nullish(),

  // Empty means no limit: every invoice in the document is read.
  maxInvoices: z.union([z.number(), z.string()]).nullish(),
});

type ExtractInvoiceConfig = z.infer<typeof configSchema>;

const nullableNumber = z.number().nullable();
const nullableString = z.string().nullable();

const outputSchema = z.object({
  status: z.enum(['extracted', 'incomplete', 'not_invoice']),
  isValidInvoice: z.boolean(),
  invoiceNumber: nullableString,
  invoiceDate: nullableString,
  companyFrom: nullableString,
  invoiceToCompany: nullableString,
  invoiceTotal: nullableNumber,
  currency: nullableString,
  subtotal: nullableNumber,
  taxTotal: nullableNumber,
  positions: z.array(
    z.object({
      position: nullableNumber,
      description: nullableString,
      quantity: nullableNumber,
      unitPrice: nullableNumber,
      totalPrice: nullableNumber,
    }),
  ),
  positionCount: z.number(),
  positionsText: z.string(),
  missingFields: z.array(z.string()),

  // Why isValidInvoice is false — one sentence per missing required field; empty when valid.
  invalidReasons: z.array(z.string()).optional(),

  // Every invoice in the document, each with its own fields, positions and validity.
  invoiceCount: z.number().optional(),
  invoices: z.array(z.record(z.string(), z.unknown())).optional(),
  warnings: z.array(z.string()),
  reason: nullableString,
  attachmentId: z.string(),
  attachmentName: z.string(),
  provider: z.string(),
  model: z.string(),
});

/** The attachment id from an "Attachment added" trigger payload; null for any other trigger. */
function readTriggerAttachmentId(input: unknown): string | null {
  const payload = input as Record<string, unknown> | null | undefined;
  const attachment = payload?.attachment as
    | Record<string, unknown>
    | null
    | undefined;
  const id = attachment?.id;

  return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
}

/** Puts the action label after a leading "(ddd)" so the worker still sees the code first. */
async function labelled<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    throw new Error(
      errorMessage(err).replace(/^(\(\d{3}\) )?/, `$1${LABEL}: `),
    );
  }
}

@Injectable()
export class ExtractInvoiceAction implements OnModuleInit {
  constructor(
    private readonly registry: ActionRegistryService,
    private readonly tenantAi: TenantAiService,
    private readonly entitlements: EntitlementsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.buildDefinition());
  }

  buildDefinition(): ActionDefinition {
    return {
      kind: 'ai.invoice.extract',
      category: 'ai',
      type: 'action',
      label: {
        en: 'AI Invoice Data Extraction',
        de: 'KI-Rechnungsdatenextraktion',
      },
      description: {
        en: "Reads a ticket's invoice attachment with the organization's AI and returns invoice number, date, companies, totals and positions for later tasks.",
        de: 'Liest den Rechnungsanhang eines Tickets mit der KI der Organisation und liefert Rechnungsnummer, Datum, Firmen, Beträge und Positionen für weitere Aufgaben.',
      },
      icon: 'bx-receipt',
      inputSchema: z.unknown(),
      configSchema,
      outputSchema,
      handler: (config: unknown, input: unknown, ctx: ExecutionContext) =>
        this.execute(configSchema.parse(config), input, ctx),
    };
  }

  private async execute(
    config: ExtractInvoiceConfig,
    input: unknown,
    ctx: ExecutionContext,
  ): Promise<InvoiceOutput> {
    const client = ctx.supabase;
    const task = await loadTask(
      client,
      ctx.organizationId,
      ctx.spaceId,
      config.taskId,
    );
    const attachment = pickAttachment(
      await listTaskAttachments(client, ctx.organizationId, task.id),
      task,
      { ...config, triggerAttachmentId: readTriggerAttachmentId(input) },
      ctx.logger,
    );

    // Refuses an oversized file before downloading it.
    if (attachment.size !== null)
      checkInvoiceFileSize(attachment.size, attachment.name);

    const bytes = await downloadAttachment(client, attachment);
    const mimeType = detectInvoiceFileType(
      bytes,
      attachment.name,
      attachment.mimeType,
    );

    ctx.logger.info(
      `${LABEL}: read ${attachment.name} (${mimeType}, ${Math.ceil(bytes.length / 1024)} KB) from ${task.key ?? task.id}`,
    );

    // A spreadsheet is unreadable to every provider, so its rows travel as text in the prompt.
    const sheetText = isTextDocument(mimeType, attachment.name)
      ? documentToText(bytes, attachment.name, mimeType)
      : null;

    // Before anything is paid for: does the text carry invoice fields at all? A PDF or an image has
    // no text here, so it is passed straight on.
    checkInvoiceStructure(sheetText, attachment.name, ctx.logger);

    if (sheetText) {
      ctx.logger.info(
        `${LABEL}: ${attachment.name} is read as text — sending ${sheetText.length} characters of rows as text`,
      );
    }

    const entitlements = await this.entitlements.getEffectiveEntitlements(
      ctx.organizationId,
    );

    if (!entitlements.has('feature_ai_assist')) {
      throw new Error(
        `(403) ${LABEL}: the AI Assist feature is not included in this organization's license.`,
      );
    }

    const { provider, apiKey } = await labelled(
      this.tenantAi.resolveConfig(client, ctx.organizationId),
    );

    checkInvoiceFileSize(bytes.length, attachment.name, provider);
    checkProviderFileType(mimeType, attachment.name, provider);

    const models = this.tenantAi.candidateModels(provider, config.model);
    let result: GenerateJsonResult | undefined;

    for (const [index, model] of models.entries()) {
      ctx.logger.info(`${LABEL}: asking ${provider} (${model})`);

      try {
        result = await labelled(
          this.tenantAi.generateJson({
            provider,
            apiKey,
            model,
            system: INVOICE_SYSTEM_PROMPT,
            prompt: sheetText
              ? `${INVOICE_USER_PROMPT}${maxInvoicesInstruction(config.maxInvoices)}\n\nThe document is below as text (a spreadsheet as CSV, otherwise its raw content). Read it as you would the printed invoice.\n\n${sheetText}`
              : `${INVOICE_USER_PROMPT}${maxInvoicesInstruction(config.maxInvoices)}`,
            file: sheetText
              ? undefined
              : {
                  base64: bytes.toString('base64'),
                  mimeType,
                  fileName: attachment.name,
                },
            schema: INVOICE_JSON_SCHEMA,
            schemaName: 'record_invoice',
            schemaDescription: 'Record the extracted invoice',
            timeoutMs: AI_TIMEOUT_MS,
          }),
        );
        break;
      } catch (err) {
        const next = models[index + 1];

        // Busy (5xx), rate-limited or retired model: the next default may answer.
        if (!next || !MODEL_UNAVAILABLE.test(errorMessage(err))) throw err;

        ctx.logger.info(
          `${LABEL}: ${model} is unavailable (${errorMessage(err)}) — trying ${next}`,
        );
      }
    }

    if (!result) throw new Error(`${LABEL}: no AI model answered.`);

    // Read outside the closure so `result` stays narrowed by the guard above.
    const usageModel = result.model;
    const usageTokens = result.promptTokens + result.completionTokens;

    // The provider has already billed this call, so a rejected document must be logged too.
    const logUsage = (status: string) =>
      this.tenantAi.logUsage(client, {
        organizationId: ctx.organizationId,
        userId: ctx.actingUserId,
        provider,
        model: usageModel,
        operationType: 'automation_invoice_extraction',
        tokens: usageTokens,
        metadata: {
          automationId: ctx.automationId,
          runId: ctx.runId,
          attachmentName: attachment.name,
          status,
        },
      });

    let output: InvoiceOutput;

    try {
      output = buildInvoiceOutput(
        result.data,
        {
          attachmentId: attachment.id,
          attachmentName: attachment.name,
          provider,
          model: result.model,
        },
        config.maxInvoices,
      );
    } catch (err) {
      await logUsage('rejected');
      throw err;
    }

    ctx.logger.info(
      `${LABEL}: ${output.status} — ${output.positionCount} position(s), ${output.missingFields.length} missing field(s), ${output.warnings.length} warning(s)`,
    );

    await logUsage(output.status);

    return output;
  }
}
