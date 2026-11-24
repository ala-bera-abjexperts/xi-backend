/**
 * @fileoverview Business logic for document templates: CRUD with definition
 * validation (zod contract → readable BadRequestException messages),
 * source_entity/mode consistency enforcement, duplication, bindable-field
 * catalog delegation, and permission-safe preview rendering.
 * @module src/document-designer/document-templates.service
 */

import { randomUUID } from 'crypto';

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ZodError } from 'zod';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { BindableFieldsService } from './bindable-fields.service';
import type { IBindableFieldsResponse } from './bindable-fields.service';
import {
  ALLOWED_TEMPLATE_IMAGE_BUCKETS,
  isAllowedTemplateImageSource,
} from './document-exports.constants';
import { sanitizeFileName } from './document-exports.service';
import {
  DocumentTemplateRepository,
  type DocumentTemplateListFilters,
} from './document-template.repository';
import { DocumentTemplateVersionsService } from './document-template-versions.service';
import { DocumentImageResolverService } from './rendering/document-image-resolver.service';
import {
  computeDocumentDataNeeds,
  DocumentDataResolverService,
  type IDocumentExportScope,
} from './rendering/document-data-resolver.service';
import { DocumentRenderService } from './rendering/document-render.service';
import {
  DOCUMENT_STARTER_TEMPLATES,
  findStarterTemplate,
} from './starter-templates.catalog';
import { parseDocumentTemplateDefinition } from './template-definition/template-definition.schema';
import type {
  IDocLoopRegionElement,
  IDocumentTemplate,
  IDocumentTemplateDefinition,
} from './template-definition/template-definition.types';
import type { IFilterRuleGroup } from '../saved-filters/filter-query-engine';
import type { CreateDocumentTemplateDto } from './dto/create-document-template.dto';
import type { DuplicateDocumentTemplateDto } from './dto/duplicate-document-template.dto';
import type { PreviewDocumentDto } from './dto/preview-document.dto';
import type { UpdateDocumentTemplateDto } from './dto/update-document-template.dto';
import type { ITemplateMetaSource } from './document-exports.service';

export const DOCUMENT_PREVIEW_MAX_ITEMS = 20;
export const DOCUMENT_PREVIEW_DEFAULT_ITEMS = 3;

export interface IDocumentPreviewResult {
  html: string;
  itemCount: number;
  warnings: string[];
}

export interface IBulkDocumentTemplateResult {
  succeeded: string[];
  failed: string[];
}

@Injectable()
export class DocumentTemplatesService {
  private readonly logger = new Logger(DocumentTemplatesService.name);

  constructor(
    private readonly templateRepo: DocumentTemplateRepository,
    private readonly bindableFields: BindableFieldsService,
    private readonly dataResolver: DocumentDataResolverService,
    private readonly renderService: DocumentRenderService,
    private readonly auditLogs: AuditLogsService,
    private readonly imageResolver: DocumentImageResolverService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly versionsService: DocumentTemplateVersionsService,
  ) {}

  private get storageClient() {
    return this.supabaseAdmin.getClient();
  }

  private static readonly MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
  private static readonly ALLOWED_IMAGE_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/avif',
  ];

  /**
   * Uploads an image for use as a `storage`-kind image element source.
   * Writes into the already-allowlisted `attachments` bucket under this
   * org's own folder — deliberately NOT the generic polymorphic attachments
   * system (a document-template image is an embedded JSON field, not a
   * relational entity with its own id/versioning/checkout semantics).
   */
  async uploadElementImage(
    organizationId: string,
    templateId: string,
    file: {
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    },
  ): Promise<{ bucket: string; path: string }> {
    await this.getById(organizationId, templateId);

    if (
      !DocumentTemplatesService.ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)
    ) {
      throw new BadRequestException(
        `Unsupported image type '${file.mimetype}' — use JPEG, PNG, GIF, WEBP, BMP, or AVIF`,
      );
    }
    if (file.size > DocumentTemplatesService.MAX_IMAGE_UPLOAD_BYTES) {
      throw new BadRequestException(
        `Image exceeds the 5MB limit (${(file.size / (1024 * 1024)).toFixed(1)}MB)`,
      );
    }

    const bucket = 'attachments';
    const safeName = sanitizeFileName(file.originalname, 'image');
    const path = `${organizationId}/document-designer/${templateId}/${randomUUID()}-${safeName}`;

    const { error } = await this.storageClient.storage
      .from(bucket)
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });
    if (error) {
      throw new BadRequestException(`Image upload failed: ${error.message}`);
    }

    return { bucket, path };
  }

  /**
   * Signs a batch of `storage`-kind image sources so the canvas (client-side
   * React, no service-role access) can render them. View-level permission
   * only — a read-only viewer should still see images.
   */
  async resolveElementImages(
    organizationId: string,
    templateId: string,
    images: { bucket: string; path: string }[],
  ): Promise<Record<string, string>> {
    await this.getById(organizationId, templateId);

    return this.imageResolver.signMany(organizationId, images);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async list(
    organizationId: string,
    filters: DocumentTemplateListFilters,
  ): Promise<{ data: IDocumentTemplate[]; count: number }> {
    const { data, totalCount } = await this.templateRepo.findByOrganization(
      organizationId,
      filters,
    );

    // Wire shape { data, count } — the frontend DocumentTemplateListResponse
    // reads `count` (mirrors the exports history endpoint).
    return { data, count: totalCount };
  }

  async getById(
    organizationId: string,
    id: string,
  ): Promise<IDocumentTemplate> {
    const template = await this.templateRepo.findById(organizationId, id);
    if (!template) throw new NotFoundException('Document template not found');
    return template;
  }

  async create(
    organizationId: string,
    userId: string,
    dto: CreateDocumentTemplateDto,
  ): Promise<IDocumentTemplate> {
    const definition = this.parseDefinition(dto.definition);
    this.assertConsistency(dto.source_entity, dto.mode, definition);
    this.assertImageSources(organizationId, definition);

    const row = await this.templateRepo.create({
      organization_id: organizationId,
      name: dto.name,
      description: dto.description ?? null,
      source_entity: dto.source_entity,
      mode: dto.mode,
      definition,
      created_by: userId,
      updated_by: userId,
    });

    await this.auditLogs.logAction(
      organizationId,
      userId,
      'document_template',
      row.id,
      'create',
      { name: row.name, source_entity: row.source_entity, mode: row.mode },
    );

    return row;
  }

  async update(
    organizationId: string,
    userId: string,
    id: string,
    dto: UpdateDocumentTemplateDto,
  ): Promise<IDocumentTemplate> {
    const existing = await this.getById(organizationId, id);

    const patch: Record<string, unknown> = { updated_by: userId };

    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.description !== undefined)
      patch['description'] = dto.description ?? null;
    if (dto.is_archived !== undefined) patch['is_archived'] = dto.is_archived;

    const nextSourceEntity = dto.source_entity ?? existing.source_entity;
    if (dto.source_entity !== undefined)
      patch['source_entity'] = dto.source_entity;
    if (dto.mode !== undefined) patch['mode'] = dto.mode;

    if (dto.definition !== undefined) {
      const definition = this.parseDefinition(dto.definition);

      // On full-definition saves the definition is the source of truth for
      // mode: sync the column automatically when the caller did not pin one
      // (the editor changes definition.mode without sending dto.mode). An
      // explicit mismatching dto.mode is still rejected, and source_entity
      // stays strict — the data-source identity of a template never changes
      // implicitly.
      const nextMode = dto.mode ?? definition.mode;
      this.assertConsistency(nextSourceEntity, nextMode, definition);
      this.assertImageSources(organizationId, definition);
      patch['definition'] = definition;
      if (nextMode !== existing.mode) patch['mode'] = nextMode;
    } else if (dto.source_entity !== undefined || dto.mode !== undefined) {
      // Column changes without a new definition must still agree with the
      // stored definition — otherwise render-time behavior diverges.
      const nextMode = dto.mode ?? existing.mode;
      this.assertConsistency(nextSourceEntity, nextMode, existing.definition);
    }

    const updated = await this.templateRepo.update(organizationId, id, patch);
    if (!updated) throw new NotFoundException('Document template not found');

    await this.auditLogs.logAction(
      organizationId,
      userId,
      'document_template',
      id,
      'update',
      { fields: Object.keys(patch).filter((key) => key !== 'updated_by') },
    );

    // Auto-snapshot the saved template as a new version. Best-effort and deduped —
    // it must never fail or slow the save it hangs off. Mirrors form-builder's
    // FormBuilderFieldsController.replace().
    await this.versionsService
      .captureVersion(id, organizationId, userId)
      .catch(() => undefined);

    return updated;
  }

  async delete(
    organizationId: string,
    userId: string,
    id: string,
  ): Promise<{ success: true }> {
    const existing = await this.getById(organizationId, id);
    await this.templateRepo.delete(organizationId, id);

    await this.auditLogs.logAction(
      organizationId,
      userId,
      'document_template',
      id,
      'delete',
      { name: existing.name },
    );

    return { success: true };
  }

  /** Archive/restore many templates via update(), so audit + version snapshots still run per template. */
  bulkUpdate(
    organizationId: string,
    userId: string,
    ids: string[],
    changes: { is_archived: boolean },
  ): Promise<IBulkDocumentTemplateResult> {
    return this.forEachTemplate(ids, 'update', (id) =>
      this.update(organizationId, userId, id, changes),
    );
  }

  /** Delete many templates via delete() (org check + audit per template). */
  bulkDelete(
    organizationId: string,
    userId: string,
    ids: string[],
  ): Promise<IBulkDocumentTemplateResult> {
    return this.forEachTemplate(ids, 'delete', (id) =>
      this.delete(organizationId, userId, id),
    );
  }

  /** One template at a time; a failure is reported, never aborts the rest (like tasks bulk delete). */
  private async forEachTemplate(
    ids: string[],
    action: 'update' | 'delete',
    run: (id: string) => Promise<unknown>,
  ): Promise<IBulkDocumentTemplateResult> {
    const result: IBulkDocumentTemplateResult = { succeeded: [], failed: [] };

    for (const id of new Set(ids)) {
      try {
        await run(id);
        result.succeeded.push(id);
      } catch (err) {
        this.logger.warn(
          `Bulk ${action}: document template ${id} failed: ${(err as Error).message}`,
        );
        result.failed.push(id);
      }
    }

    return result;
  }

  async duplicate(
    organizationId: string,
    userId: string,
    id: string,
    dto: DuplicateDocumentTemplateDto,
  ): Promise<IDocumentTemplate> {
    const existing = await this.getById(organizationId, id);
    const name = (dto.name ?? `${existing.name} (Copy)`).slice(0, 200);

    const copy = await this.templateRepo.duplicate(
      organizationId,
      id,
      name,
      userId,
    );
    if (!copy) throw new NotFoundException('Document template not found');

    await this.auditLogs.logAction(
      organizationId,
      userId,
      'document_template',
      copy.id,
      'create',
      { name: copy.name, duplicated_from: id },
    );

    return copy;
  }

  /** Summaries only (no `definition`) — the picker list doesn't need the full JSON. */
  getStarterTemplates() {
    return DOCUMENT_STARTER_TEMPLATES.map((starter) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { definition, ...summary } = starter;

      return summary;
    });
  }

  async createFromStarter(
    organizationId: string,
    userId: string,
    key: string,
    dto: DuplicateDocumentTemplateDto,
  ): Promise<IDocumentTemplate> {
    const starter = findStarterTemplate(key);
    if (!starter)
      throw new NotFoundException(`Starter template '${key}' not found`);

    const resolvedName = dto.name?.trim()
      ? dto.name.trim()
      : await this.resolveStarterName(
          organizationId,
          starter.name,
          starter.source_entity,
        );

    return this.create(organizationId, userId, {
      name: resolvedName,
      description: starter.description,
      source_entity: starter.source_entity,
      mode: starter.mode,
      // create()'s DTO takes the definition as raw wire JSON (Record<string, unknown>)
      // and re-validates/parses it via parseDefinition() — same as any client payload.
      definition: starter.definition as unknown as Record<string, unknown>,
    });
  }

  /**
   * Mirrors `duplicate()`'s "(Copy)" naming convention: append "(2)", "(3)", …
   * until a non-colliding name is found within this org+source_entity, capped
   * at 200 chars like every other template name.
   */
  private async resolveStarterName(
    organizationId: string,
    baseName: string,
    sourceEntity: string,
  ): Promise<string> {
    // ponytail: one list query (capped at the repo's own 200-row page size)
    // rather than a per-candidate existence check — starter catalogs are tiny.
    const { data } = await this.templateRepo.findByOrganization(
      organizationId,
      {
        source_entity: sourceEntity,
        include_archived: true,
        pageSize: 200,
      },
    );
    const existingNames = new Set(data.map((t) => t.name));

    if (!existingNames.has(baseName)) return baseName.slice(0, 200);

    let suffix = 2;
    let candidate = `${baseName} (${suffix})`.slice(0, 200);
    while (existingNames.has(candidate)) {
      suffix += 1;
      candidate = `${baseName} (${suffix})`.slice(0, 200);
    }

    return candidate;
  }

  // ── Bindable fields ───────────────────────────────────────────────────────

  async getBindableFields(
    organizationId: string,
    sourceEntity: string,
    spaceIds?: string[],
  ): Promise<IBindableFieldsResponse> {
    return this.bindableFields.getBindableFields(
      organizationId,
      sourceEntity,
      spaceIds,
    );
  }

  // ── Preview ───────────────────────────────────────────────────────────────

  async preview(
    organizationId: string,
    userId: string,
    dto: PreviewDocumentDto,
  ): Promise<IDocumentPreviewResult> {
    if (!dto.definition) {
      throw new BadRequestException('definition is required for preview');
    }
    const definition = this.parseDefinition(dto.definition);
    return this.renderPreview(organizationId, userId, definition, dto);
  }

  async previewById(
    organizationId: string,
    userId: string,
    id: string,
    dto: PreviewDocumentDto,
  ): Promise<IDocumentPreviewResult> {
    const template = await this.getById(organizationId, id);
    const definition = this.parseDefinition(template.definition);
    return this.renderPreview(
      organizationId,
      userId,
      definition,
      dto,
      template,
    );
  }

  private async renderPreview(
    organizationId: string,
    userId: string,
    definition: IDocumentTemplateDefinition,
    dto: PreviewDocumentDto,
    /**
     * Only present when previewing a SAVED template. The ad-hoc preview posts a
     * bare definition with no row behind it, so the template meta bindings
     * render empty there — same as any unresolved binding.
     */
    template?: ITemplateMetaSource | null,
  ): Promise<IDocumentPreviewResult> {
    const itemLimit = Math.min(
      Math.max(dto.itemLimit ?? DOCUMENT_PREVIEW_DEFAULT_ITEMS, 1),
      DOCUMENT_PREVIEW_MAX_ITEMS,
    );

    const requestedScope = (dto.scope ?? {}) as IDocumentExportScope;
    const hasScope = Boolean(
      requestedScope.savedFilterId ||
      requestedScope.query ||
      (requestedScope.ids && requestedScope.ids.length > 0),
    );

    // Without an explicit scope, preview samples the first permitted items of
    // the entity (empty rule group = match-all through the permission-safe
    // engine) — UNLESS the template has exactly one top-level `items` loop
    // region with its own filter, in which case that filter becomes the
    // default scope too. Without this, "most recent N org-wide" can select
    // items that satisfy no region's filter, silently rendering every loop
    // empty even though matching data exists elsewhere in the org — the
    // diagnostic warnings in the renderer explain *that* this happened, but
    // this makes the common single-region case just work instead.
    const matchAllQuery: IFilterRuleGroup = { combinator: 'and', rules: [] };
    const smartQuery = hasScope ? null : defaultPreviewQuery(definition);
    const usesSmartDefault = Boolean(smartQuery && smartQuery.rules.length > 0);

    const scope: IDocumentExportScope = hasScope
      ? requestedScope
      : { query: smartQuery ?? matchAllQuery };

    const resolveItems = (s: IDocumentExportScope) =>
      this.dataResolver.resolve({
        organizationId,
        userId,
        sourceEntity: definition.sourceEntity,
        scope: s,
        needs: computeDocumentDataNeeds(definition),
        definition,
        itemLimit,
        truncateOverLimit: true,
      });

    // The region's filter is written for the row-level ElementConditionEvaluator
    // (bare/system field keys, e.g. `summary`), which does not necessarily share
    // the saved-filters query engine's field vocabulary used for this initial
    // item fetch (e.g. `title`, mapped internally to the `summary` column) — a
    // mismatch here silently matches zero items rather than erroring. Worse, a
    // filter referencing a since-deactivated/deleted custom field (`cf_<key>`)
    // makes the query engine THROW before running anything at all. Either way,
    // if the smart default can't be used, fall back to plain match-all so this
    // optimization can never leave a preview emptier — or more broken — than
    // the original default.
    let dataCtx: Awaited<ReturnType<typeof resolveItems>>;
    let fellBackToMatchAll = false;

    if (usesSmartDefault) {
      try {
        dataCtx = await resolveItems(scope);
      } catch {
        dataCtx = await resolveItems({ query: matchAllQuery });
        fellBackToMatchAll = true;
      }

      if (!fellBackToMatchAll && dataCtx.items.length === 0) {
        dataCtx = await resolveItems({ query: matchAllQuery });
        fellBackToMatchAll = true;
      }
    } else {
      dataCtx = await resolveItems(scope);
    }

    const warnings: string[] = [...dataCtx.warnings];
    if (fellBackToMatchAll) {
      warnings.push(
        "This template's own filter could not be used to sample preview items automatically (an unsupported filter field or a stale reference) — showing unfiltered results instead.",
      );
    }
    const prepared = await this.imageResolver.prepareImages(
      organizationId,
      definition,
      warnings,
    );

    const { html, warnings: renderWarnings } = this.renderService.render(
      prepared.definition,
      dataCtx,
      {
        exportedByUserId: userId,
        resolveImageSrc: prepared.resolveImageSrc,
        templateName: template?.name ?? null,
        templateDescription: template?.description ?? null,
        templateUpdatedAt: template?.updated_at
          ? new Date(template.updated_at)
          : null,
        isPreview: true,
      },
    );

    return {
      html,
      itemCount: dataCtx.items.length,
      warnings: [...warnings, ...renderWarnings],
    };
  }

  // ── Definition validation ─────────────────────────────────────────────────

  private parseDefinition(input: unknown): IDocumentTemplateDefinition {
    try {
      return parseDocumentTemplateDefinition(input);
    } catch (err) {
      throw new BadRequestException(formatDefinitionError(err));
    }
  }

  private assertConsistency(
    sourceEntity: string,
    mode: string,
    definition: IDocumentTemplateDefinition,
  ): void {
    if (definition.sourceEntity !== sourceEntity) {
      throw new BadRequestException(
        `source_entity '${sourceEntity}' does not match definition.sourceEntity '${definition.sourceEntity}'`,
      );
    }
    if (definition.mode !== mode) {
      throw new BadRequestException(
        `mode '${mode}' does not match definition.mode '${definition.mode}'`,
      );
    }
  }

  /**
   * Storage-kind image sources are later signed with the SERVICE-ROLE client
   * (bypasses storage RLS), so authors must be stopped early from referencing
   * buckets/paths outside their organization. The export pipeline re-checks
   * at render time (never trust the stored definition); this check makes the
   * failure visible at save time instead of a silently blank image.
   */
  private assertImageSources(
    organizationId: string,
    definition: IDocumentTemplateDefinition,
  ): void {
    for (const el of definition.elements) {
      if (el.type !== 'image' || el.src.kind !== 'storage') continue;

      if (!isAllowedTemplateImageSource(organizationId, el.src)) {
        throw new BadRequestException(
          `Image element ${el.id}: storage images must use one of the allowed buckets (${ALLOWED_TEMPLATE_IMAGE_BUCKETS.join(', ')}) with a path inside your organization folder`,
        );
      }
    }
  }
}

/**
 * Default scope for an unscoped preview: match-all, UNLESS the template has
 * exactly one top-level (parentId null) `items` loop region with its own
 * filter — then reuse that filter, so the default sample is actually items
 * the template's own loop would show. Zero or multiple top-level items
 * regions (ambiguous which filter should win) keep today's match-all
 * behavior unchanged.
 */
function defaultPreviewQuery(
  definition: IDocumentTemplateDefinition,
): IFilterRuleGroup {
  const topLevelItemsRegions = definition.elements.filter(
    (el): el is IDocLoopRegionElement =>
      el.type === 'loop_region' &&
      el.parentId == null &&
      el.dataSource === 'items',
  );

  // A filter-less top-level region already matches everything regardless of
  // scope, so skipping it when picking which filter to reuse never loses
  // anything — this also means a template with several top-level regions
  // (e.g. an "Open" section and a separate "Closed" section) still benefits,
  // rather than only the narrower "exactly one region" case.
  const firstFilter = topLevelItemsRegions.find(
    (region) => region.filter,
  )?.filter;

  return firstFilter ?? { combinator: 'and', rules: [] };
}

/** Map zod issues (or size-cap errors) to one readable message line. */
function formatDefinitionError(err: unknown): string {
  if (err instanceof ZodError) {
    const issues = err.issues.slice(0, 5).map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    const suffix =
      err.issues.length > 5 ? ` (+${err.issues.length - 5} more)` : '';
    return `Invalid template definition — ${issues.join('; ')}${suffix}`;
  }
  if (err instanceof Error) {
    return `Invalid template definition — ${err.message}`;
  }
  return 'Invalid template definition';
}
