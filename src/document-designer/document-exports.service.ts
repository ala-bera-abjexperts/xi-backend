/**
 * @fileoverview Export orchestrator: loads the template, records a
 * document_exports history row through its full lifecycle
 * (pending → running → completed/failed), resolves data with the STRICT item
 * cap, renders the requested format (html / pdf / docx), uploads the result
 * to the private 'document-exports' bucket, and hands back the buffer +
 * metadata. Per-org in-flight cap (in-memory, per process) keeps one tenant
 * from monopolizing the render workers.
 *
 * Image resolution per DocImageSrc kind (pdf/html path):
 *  - data:    passed through untouched.
 *  - storage: pre-signed (300 s) via the Supabase storage API and injected
 *    through the render service's resolveImageSrc hook (Wave 1 left it open).
 *  - url:     blanked with a warning unless
 *    DOCUMENT_DESIGNER_ALLOW_REMOTE_IMAGES=true (PDF request interception
 *    additionally restricts fetches to the Supabase host).
 * @module src/document-designer/document-exports.service
 */

import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { format as formatDateFns } from 'date-fns';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { DOCUMENT_EXPORTS_BUCKET } from './document-exports.constants';
import {
  DocumentExportRepository,
  type DocumentExportListFilters,
} from './document-export.repository';
import { DocumentTemplateRepository } from './document-template.repository';
import {
  computeDocumentDataNeeds,
  DocumentDataResolverService,
  type IDocumentDataContext,
  type IDocumentExportScope,
} from './rendering/document-data-resolver.service';
import { DocumentImageResolverService } from './rendering/document-image-resolver.service';
import { DocumentRenderService } from './rendering/document-render.service';
import { DocxRenderService } from './rendering/docx-render.service';

import { resolveDocxLayout } from './rendering/docx-layout';
import { PdfRenderService } from './rendering/pdf-render.service';
import { getPageDimensionsPx } from './rendering/render-constants';
import { parseDocumentTemplateDefinition } from './template-definition/template-definition.schema';
import type {
  DocumentExportFormat,
  DocumentExportSource,
  IDocumentExport,
  IDocumentTemplateDefinition,
} from './template-definition/template-definition.types';

export { DOCUMENT_EXPORTS_BUCKET } from './document-exports.constants';

/** Concurrent exports allowed per organization (per process). */
const MAX_INFLIGHT_PER_ORG = 2;

/** Rendered-HTML size guard — larger documents wedge Chromium. */
const MAX_HTML_BYTES = 10 * 1024 * 1024;

const SIGNED_DOWNLOAD_URL_TTL_SECONDS = 60;

const MIME_BY_FORMAT: Record<DocumentExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html',
};

const EXT_BY_FORMAT: Record<DocumentExportFormat, string> = {
  pdf: 'pdf',
  docx: 'docx',
  html: 'html',
};

/**
 * The slice of a document_templates row the renderers need. Structural rather
 * than the full entity so callers can pass a repository row directly.
 */
export interface ITemplateMetaSource {
  name: string;
  description: string | null;
  updated_at: string;
}

export interface IDocumentExportParams {
  organizationId: string;
  userId: string;
  templateId: string;
  format: DocumentExportFormat;
  scope: IDocumentExportScope;
  delivery?: 'download' | 'store';
  fileName?: string;
  source: DocumentExportSource;
  automationRunId?: string | null;
  /**
   * Drop top-level `items` region filters. Only meaningful with an `ids` scope,
   * where the caller already picked the exact rows — see scopedItemsRegion().
   */
  ignoreItemsRegionFilter?: boolean;
}

export interface IDocumentExportResult {
  record: IDocumentExport;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  warnings: string[];
}

export interface IDocumentDownloadInfo {
  signedUrl: string;
  fileName: string;
  mimeType: string;
}

@Injectable()
export class DocumentExportsService {
  private readonly logger = new Logger(DocumentExportsService.name);

  /** orgId → number of exports currently rendering in this process. */
  private readonly inflightByOrg = new Map<string, number>();

  constructor(
    private readonly templateRepo: DocumentTemplateRepository,
    private readonly exportRepo: DocumentExportRepository,
    private readonly dataResolver: DocumentDataResolverService,
    private readonly renderService: DocumentRenderService,
    private readonly pdfService: PdfRenderService,
    private readonly docxService: DocxRenderService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly imageResolver: DocumentImageResolverService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ── Export ────────────────────────────────────────────────────────────────

  async export(params: IDocumentExportParams): Promise<IDocumentExportResult> {
    this.assertScope(params.scope);

    const template = await this.templateRepo.findById(
      params.organizationId,
      params.templateId,
    );
    if (!template) throw new NotFoundException('Document template not found');
    if (template.is_archived) {
      throw new BadRequestException(
        'Archived templates cannot be exported — restore the template first',
      );
    }

    const definition = this.parseDefinition(template.definition);

    this.acquireOrgSlot(params.organizationId);
    try {
      // History row FIRST so even resolve/render crashes leave a failed trace.
      const record = await this.exportRepo.insert(params.organizationId, {
        template_id: template.id,
        template_name: template.name,
        requested_by: params.userId,
        source: params.source,
        automation_run_id: params.automationRunId ?? null,
        format: params.format,
        status: 'pending',
        filter_snapshot: params.scope as Record<string, unknown>,
      });

      try {
        await this.exportRepo.update(params.organizationId, record.id, {
          status: 'running',
          started_at: new Date().toISOString(),
        });

        const result = await this.renderAndStore(
          params,
          definition,
          template,
          record,
        );

        return result;
      } catch (err) {
        await this.markFailed(params.organizationId, record.id, err);
        throw err;
      }
    } finally {
      this.releaseOrgSlot(params.organizationId);
    }
  }

  private async renderAndStore(
    params: IDocumentExportParams,
    definition: IDocumentTemplateDefinition,
    /**
     * The template row, not just its name: the name builds the download
     * filename, and name/description/updated_at also feed the `templateName`,
     * `templateDescription` and `templateUpdatedAt` meta bindings.
     */
    template: ITemplateMetaSource,
    record: IDocumentExport,
  ): Promise<IDocumentExportResult> {
    const warnings: string[] = [];

    // A template's own maxExportItems may only LOWER the effective cap below the org's actually
    // configured default — never raise it above what the org allows.
    const itemLimit =
      definition.maxExportItems != null
        ? Math.min(
            definition.maxExportItems,
            this.dataResolver.getDefaultMaxItems(),
          )
        : undefined;

    // Scope may match more than the cap — truncate to the first `itemLimit`
    // items instead of failing the export outright (mirrors the preview path
    // in document-templates.service.ts). Surfaced to the caller via `warnings`.
    const dataCtx = await this.dataResolver.resolve({
      organizationId: params.organizationId,
      userId: params.userId,
      sourceEntity: definition.sourceEntity,
      scope: params.scope,
      needs: computeDocumentDataNeeds(definition),
      definition,
      itemLimit,
      truncateOverLimit: true,
    });
    warnings.push(...dataCtx.warnings);

    const buffer = await this.renderFormat(
      params,
      definition,
      dataCtx,
      warnings,
      template,
    );

    const ext = EXT_BY_FORMAT[params.format];
    const mimeType = MIME_BY_FORMAT[params.format];
    const sanitized = sanitizeFileName(
      params.fileName,
      `${template.name}-${formatDateFns(new Date(), 'yyyy-MM-dd')}`,
    );

    // Clients sometimes send the file name WITH an extension despite the DTO
    // contract — strip a trailing format extension so the stored name never
    // doubles up ('Report.pdf' → 'Report' → 'Report.pdf').
    const baseName = sanitized.replace(/\.(pdf|docx|html)$/i, '') || sanitized;
    const fileName = `${baseName}.${ext}`;
    const filePath = `${params.organizationId}/${record.id}/${fileName}`;

    const { error: uploadError } = await this.client.storage
      .from(DOCUMENT_EXPORTS_BUCKET)
      .upload(filePath, buffer, { contentType: mimeType, upsert: true });

    if (uploadError) {
      throw new HttpException(
        `Export file upload failed: ${uploadError.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    let completed: IDocumentExport | null;
    try {
      completed = await this.exportRepo.update(
        params.organizationId,
        record.id,
        {
          status: 'completed',
          file_path: filePath,
          file_size_bytes: buffer.length,
          item_count: dataCtx.items.length,
          completed_at: new Date().toISOString(),
        },
      );
    } catch (err) {
      // The row never learned file_path, so the cleanup cron could never
      // reclaim the object — remove it best-effort before the outer catch
      // marks the row failed.
      await this.removeUploadedFile(filePath);
      throw err;
    }

    return {
      record: completed ?? record,
      buffer,
      fileName,
      mimeType,
      warnings,
    };
  }

  private async renderFormat(
    params: IDocumentExportParams,
    definition: IDocumentTemplateDefinition,
    dataCtx: IDocumentDataContext,
    warnings: string[],
    template: ITemplateMetaSource,
  ): Promise<Buffer> {
    // Same template meta for every format, so a document says the same thing
    // whether it was exported as PDF, HTML or DOCX.
    const templateMeta = {
      templateName: template.name,
      templateDescription: template.description,
      templateUpdatedAt: template.updated_at
        ? new Date(template.updated_at)
        : null,
    };

    if (params.format === 'docx') {
      // Word embeds storage images itself (the PDF path signs URLs instead); legacy layout never did.
      const imageData =
        resolveDocxLayout() === 'v2'
          ? await this.imageResolver.downloadForDocx(
              params.organizationId,
              definition,
              warnings,
            )
          : undefined;
      const { buffer, warnings: docxWarnings } =
        await this.docxService.renderDocx(definition, dataCtx, {
          exportedByUserId: params.userId,
          ignoreItemsRegionFilter: params.ignoreItemsRegionFilter,
          ...templateMeta,
          ...(imageData ? { imageData } : {}),
        });
      warnings.push(...docxWarnings);

      return buffer;
    }

    const prepared = await this.imageResolver.prepareImages(
      params.organizationId,
      definition,
      warnings,
    );

    const { html, warnings: renderWarnings } = this.renderService.render(
      prepared.definition,
      dataCtx,
      {
        exportedByUserId: params.userId,
        resolveImageSrc: prepared.resolveImageSrc,
        ignoreItemsRegionFilter: params.ignoreItemsRegionFilter,
        ...templateMeta,
      },
    );
    warnings.push(...renderWarnings);

    const htmlBuffer = Buffer.from(html, 'utf8');
    if (htmlBuffer.length > MAX_HTML_BYTES) {
      const actualMB = (htmlBuffer.length / (1024 * 1024)).toFixed(2);
      const limitMB = (MAX_HTML_BYTES / (1024 * 1024)).toFixed(0);
      const hint =
        definition.mode === 'repeat_per_item'
          ? 'reduce the export scope (fewer items), or avoid a large image on a repeat-per-item page — it is re-embedded once per item, so its size multiplies by the item count'
          : 'reduce the amount of content or the size of embedded images on this document';

      throw new HttpException(
        `Rendered document is ${actualMB} MB (limit ${limitMB} MB) across ${dataCtx.items.length} item(s) — ${hint}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    if (params.format === 'html') return htmlBuffer;

    const page = getPageDimensionsPx(
      definition.page.size,
      definition.page.orientation,
    );

    return this.pdfService.renderPdf(
      html,
      { widthPx: page.width, heightPx: page.height },
      extractUrlImageHosts(prepared.definition),
    );
  }

  // ── History / download ────────────────────────────────────────────────────

  /**
   * Export selection is permission-checked at GENERATE time for the requesting
   * user, so the history/download surface restricts non-managers to their own
   * exports (`requestedBy`) — otherwise any org member could download
   * documents full of space data they have no membership for. Callers holding
   * can_manage_document_templates pass `requestedBy: undefined` to see the
   * whole org history (resolved by the controller).
   */
  async list(
    organizationId: string,
    filters: DocumentExportListFilters,
  ): Promise<{ data: IDocumentExport[]; count: number }> {
    const { data, totalCount } = await this.exportRepo.list(
      organizationId,
      filters,
    );

    return { data, count: totalCount };
  }

  async getById(
    organizationId: string,
    exportId: string,
    requestedBy?: string,
  ): Promise<IDocumentExport> {
    const record = await this.exportRepo.findById(
      organizationId,
      exportId,
      requestedBy,
    );
    if (!record) throw new NotFoundException('Document export not found');

    return record;
  }

  async getDownloadInfo(
    organizationId: string,
    exportId: string,
    requestedBy?: string,
  ): Promise<IDocumentDownloadInfo> {
    const record = await this.getById(organizationId, exportId, requestedBy);
    if (!record.file_path) {
      throw new NotFoundException(
        'Export file is no longer available (expired or failed)',
      );
    }

    const { data, error } = await this.client.storage
      .from(DOCUMENT_EXPORTS_BUCKET)
      .createSignedUrl(record.file_path, SIGNED_DOWNLOAD_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) {
      this.logger.error(
        `Failed to sign export download URL for ${exportId}:`,
        error,
      );
      throw new BadRequestException('Failed to generate download URL');
    }

    const segments = record.file_path.split('/');

    return {
      signedUrl: data.signedUrl,
      fileName: segments[segments.length - 1] ?? `export.${record.format}`,
      mimeType: MIME_BY_FORMAT[record.format],
    };
  }

  // ── Guards / bookkeeping ──────────────────────────────────────────────────

  private assertScope(scope: IDocumentExportScope): void {
    const provided = [
      Boolean(scope?.savedFilterId),
      Boolean(scope?.ids && scope.ids.length > 0),
      Boolean(scope?.query),
    ].filter(Boolean).length;

    if (provided !== 1) {
      throw new BadRequestException(
        'Export scope requires exactly one of savedFilterId, ids, or query',
      );
    }
  }

  private acquireOrgSlot(organizationId: string): void {
    const current = this.inflightByOrg.get(organizationId) ?? 0;
    if (current >= MAX_INFLIGHT_PER_ORG) {
      throw new HttpException(
        'Too many document exports are already running for this organization — retry when one finishes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.inflightByOrg.set(organizationId, current + 1);
  }

  private releaseOrgSlot(organizationId: string): void {
    const current = this.inflightByOrg.get(organizationId) ?? 0;
    if (current <= 1) this.inflightByOrg.delete(organizationId);
    else this.inflightByOrg.set(organizationId, current - 1);
  }

  /** Best-effort removal of an uploaded export file (never throws). */
  private async removeUploadedFile(filePath: string): Promise<void> {
    try {
      const { error } = await this.client.storage
        .from(DOCUMENT_EXPORTS_BUCKET)
        .remove([filePath]);
      if (error) {
        this.logger.error(
          `Failed to remove orphaned export file ${filePath}: ${error.message}`,
        );
      }
    } catch (removeErr) {
      this.logger.error(
        `Failed to remove orphaned export file ${filePath}:`,
        removeErr,
      );
    }
  }

  private async markFailed(
    organizationId: string,
    exportId: string,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await this.exportRepo.update(organizationId, exportId, {
        status: 'failed',
        error: message.slice(0, 2000),
        completed_at: new Date().toISOString(),
      });
    } catch (updateErr) {
      this.logger.error(
        `Failed to mark export ${exportId} as failed:`,
        updateErr,
      );
    }
  }

  private parseDefinition(input: unknown): IDocumentTemplateDefinition {
    try {
      return parseDocumentTemplateDefinition(input);
    } catch (err) {
      throw new BadRequestException(
        `Stored template definition is invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Sanitize a user/template-derived file name for storage + Content-Disposition:
 * path separators, Windows-reserved characters, and control chars stripped;
 * whitespace collapsed to '-'; capped at 120 chars.
 */
export function sanitizeFileName(
  requested: string | undefined,
  fallback: string,
): string {
  const clean = (source: string): string =>
    source
      // eslint-disable-next-line no-control-regex
      .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 120);

  return clean(requested?.trim() ?? '') || clean(fallback) || 'document-export';
}

/**
 * Hostnames of every `url`-kind image the definition actually references —
 * the ONLY extra hosts the PDF render worker is allowed to fetch from for
 * this specific render (SSRF control: never a blanket allow, only what the
 * template's own already-validated https:// image URLs name).
 */
function extractUrlImageHosts(
  definition: IDocumentTemplateDefinition,
): string[] {
  const hosts = new Set<string>();

  for (const el of definition.elements) {
    if (el.type !== 'image' || el.src.kind !== 'url' || !el.src.url) continue;
    try {
      hosts.add(new URL(el.src.url).host);
    } catch {
      // Invalid URL — already schema-validated at save time, but be defensive.
    }
  }

  return Array.from(hosts);
}
