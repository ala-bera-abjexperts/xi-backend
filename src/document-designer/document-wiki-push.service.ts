/**
 * @fileoverview Orchestrates "push a document template to a wiki page":
 * resolve data (same resolver every export format uses) → render to TipTap
 * → write via WikiService. Mirrors document-exports.service.ts's shape but
 * writes to wiki_pages instead of the export Storage bucket, so it does not
 * create a document_exports row (see the approved plan for why).
 * @module src/document-designer/document-wiki-push.service
 */

import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WikiService } from '../wiki/wiki.service';
import { WikiPermissionsService } from '../wiki/wiki-permissions.service';
import type { CreateWikiPageDto } from '../wiki/dto/create-wiki-page.dto';
import { DocumentTemplateRepository } from './document-template.repository';
import {
  computeDocumentDataNeeds,
  DocumentDataResolverService,
  type IDocumentExportScope,
} from './rendering/document-data-resolver.service';
import { DocumentImageResolverService } from './rendering/document-image-resolver.service';
import {
  TipTapRenderService,
  type ITipTapRenderResult,
} from './rendering/tiptap-render.service';
import { isAllowedTemplateImageSource } from './document-exports.constants';
import { parseDocumentTemplateDefinition } from './template-definition/template-definition.schema';
import type {
  DocImageSrc,
  IDocumentTemplateDefinition,
} from './template-definition/template-definition.types';

/** Below tiptap-sanitizer.ts's hard MAX_NODES=50000, so we surface a clear error before the sanitizer would. */
const MAX_TIPTAP_NODES = 40_000;

/** Matches create-wiki-page.dto.ts's content cap — enforced manually since this path bypasses the DTO's ValidationPipe. */
const MAX_WIKI_CONTENT_BYTES = 5_000_000;

interface IPushParams {
  organizationId: string;
  userId: string;
  templateId: string;
  spaceId: string;
  scope: Record<string, unknown>;
  /** See IDocumentRenderOptions.ignoreItemsRegionFilter — same contract. */
  ignoreItemsRegionFilter?: boolean;
}

@Injectable()
export class DocumentWikiPushService {
  private readonly logger = new Logger(DocumentWikiPushService.name);

  constructor(
    private readonly templateRepo: DocumentTemplateRepository,
    private readonly dataResolver: DocumentDataResolverService,
    private readonly imageResolver: DocumentImageResolverService,
    private readonly tiptapRenderService: TipTapRenderService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly wikiService: WikiService,
    private readonly wikiPermissions: WikiPermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async pushToWiki(
    params: IPushParams & { parentId?: string; title?: string },
  ): Promise<{ page: Record<string, unknown>; warnings: string[] }> {
    await this.assertSpaceInOrganization(params.spaceId, params.organizationId);

    if (params.parentId) {
      await this.wikiPermissions.assertPageAccess(
        params.parentId,
        params.userId,
        params.spaceId,
        'can_create',
      );
    }

    const { template, content, warnings } = await this.renderForPush(params);
    const title = (params.title?.trim() || template.name).slice(0, 500);

    const page = (await this.createWithRetry(
      {
        space_id: params.spaceId,
        title,
        content,
        content_format: 'tiptap',
        parent_id: params.parentId,
      } as CreateWikiPageDto,
      params.organizationId,
      params.userId,
    )) as Record<string, unknown>;

    await this.recordLink(
      String(page.id),
      params.templateId,
      template.name,
      params.scope,
      params.userId,
    );

    await this.recordTaskLink(String(page.id), template, params);

    return { page, warnings };
  }

  /**
   * Also links the new page to the task it was generated from, so it shows up in the task's
   * Wiki Links panel next to AI-generated pages.
   *
   * Only for a single-task push: `scope.ids` is generic across source entities, so without the
   * source_entity check a single-risk export would be recorded as a task link.
   *
   * Create-only on purpose. `updateWikiPush` can run many times against one page, and the task
   * panel does not de-duplicate — re-linking there would inflate its count on every re-push.
   */
  private async recordTaskLink(
    pageId: string,
    template: { name: string; source_entity: string },
    params: IPushParams,
  ): Promise<void> {
    const ids = (params.scope as IDocumentExportScope)?.ids;

    if (template.source_entity !== 'tasks' || ids?.length !== 1) return;

    // Never fail an otherwise-successful export for a bookkeeping row.
    try {
      await this.client.from('wiki_page_links').upsert(
        {
          source_page_id: pageId,
          target_type: 'task',
          target_id: ids[0],
          target_metadata: { template_name: template.name },
          created_by: params.userId,
        },
        { onConflict: 'source_page_id,target_type,target_id' },
      );
    } catch (err) {
      this.logger.warn(
        `recordTaskLink failed for page ${pageId}: ${String(err)}`,
      );
    }
  }

  async updateWikiPush(
    params: IPushParams & { pageId: string; confirmed?: boolean },
  ): Promise<{ page: Record<string, unknown>; warnings: string[] }> {
    await this.assertSpaceInOrganization(params.spaceId, params.organizationId);

    const link = await this.findLink(params.pageId, params.templateId);

    if (!link) {
      throw new BadRequestException(
        'This page was not created from this template — use "Create New" instead',
      );
    }

    await this.wikiPermissions.assertPageAccess(
      params.pageId,
      params.userId,
      params.spaceId,
      'can_edit',
    );

    const existing = (await this.wikiService.getPageById(
      params.pageId,
      params.spaceId,
    )) as Record<string, unknown>;

    if (existing.content_format !== 'tiptap') {
      throw new BadRequestException(
        'This page is no longer in wiki-native format (converted since the last push) — use "Create New" instead',
      );
    }

    if (!params.confirmed) {
      await this.assertSafeToOverwrite(link, existing, params.pageId);
    }

    const { template, content, warnings } = await this.renderForPush(params);

    const page = (await this.wikiService.updatePage(
      params.pageId,
      params.spaceId,
      { content, content_format: 'tiptap' },
      params.userId,
    )) as Record<string, unknown>;

    await this.client
      .from('wiki_page_links')
      .update({
        target_metadata: {
          template_name: template.name,
          scope: params.scope,
          pushed_at: new Date().toISOString(),
        },
      })
      .eq('id', link.id as string);

    return { page, warnings };
  }

  async listWikiPushes(
    templateId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await this.client
      .from('wiki_page_links')
      .select(
        'id, source_page_id, target_metadata, created_at, wiki_pages!source_page_id(id, title, slug, space_id, organization_id)',
      )
      .eq('target_type', 'document_export_template')
      .eq('target_id', templateId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    // Filtered here (not just relied on the caller's own space access) so a
    // template pushed into MULTIPLE spaces never leaks another space's page
    // titles to a caller who only has access to one of them.
    return (data ?? [])
      .filter((row: Record<string, unknown>) => {
        const page = row['wiki_pages'] as Record<string, unknown> | null;

        return (
          page?.space_id === spaceId && page?.organization_id === organizationId
        );
      })
      .map((row: Record<string, unknown>) => {
        const page = row['wiki_pages'] as Record<string, unknown>;
        const meta = row['target_metadata'] as Record<string, unknown> | null;

        return {
          link_id: row['id'],
          page_id: page.id,
          title: page.title,
          slug: page.slug,
          pushed_at: meta?.pushed_at ?? row['created_at'],
        };
      });
  }

  private async assertSafeToOverwrite(
    link: Record<string, unknown>,
    existing: Record<string, unknown>,
    pageId: string,
  ): Promise<void> {
    const meta = link.target_metadata as Record<string, unknown> | null;
    const pushedAt = meta?.pushed_at as string | undefined;
    const handEdited =
      Boolean(pushedAt) &&
      Boolean(existing.updated_at) &&
      new Date(existing.updated_at as string) > new Date(pushedAt as string);
    const openComments = await this.countOpenComments(pageId);

    if (!handEdited && openComments === 0) return;

    throw new ConflictException({
      message: handEdited
        ? 'This page was edited since the last push — confirm to overwrite it.'
        : `This page has ${openComments} open comment(s) that may lose their anchor — confirm to continue.`,
      code: 'WIKI_PUSH_CONFIRM_REQUIRED',
      data: { handEdited, openComments },
    });
  }

  /** Shared resolve → render → validate pipeline for both create and update. */
  private async renderForPush(params: IPushParams): Promise<{
    template: {
      id: string;
      name: string;
      description: string | null;
      updated_at: string;
      // Exposed so the caller can tell a single-task push from a single-risk or
      // single-process one — scope.ids is generic across every source entity.
      source_entity: string;
    };
    content: string;
    warnings: string[];
  }> {
    this.assertScope(params.scope as IDocumentExportScope);

    const template = await this.templateRepo.findById(
      params.organizationId,
      params.templateId,
    );

    if (!template) throw new NotFoundException('Document template not found');
    if (template.is_archived) {
      throw new BadRequestException(
        'Archived templates cannot be pushed to wiki — restore the template first',
      );
    }

    const definition = parseDocumentTemplateDefinition(template.definition);
    const warnings: string[] = [];
    const itemLimit =
      definition.maxExportItems != null
        ? Math.min(
            definition.maxExportItems,
            this.dataResolver.getDefaultMaxItems(),
          )
        : undefined;

    const dataCtx = await this.dataResolver.resolve({
      organizationId: params.organizationId,
      userId: params.userId,
      sourceEntity: definition.sourceEntity,
      scope: params.scope as IDocumentExportScope,
      needs: computeDocumentDataNeeds(definition),
      definition,
      itemLimit,
      truncateOverLimit: true,
    });

    warnings.push(...dataCtx.warnings);

    const prepared = await this.imageResolver.prepareImages(
      params.organizationId,
      definition,
      warnings,
    );
    const resolveImageSrc = await this.prepareWikiImages(
      params.organizationId,
      params.spaceId,
      prepared.definition,
      warnings,
    );

    const result: ITipTapRenderResult = this.tiptapRenderService.render(
      prepared.definition,
      dataCtx,
      {
        exportedByUserId: params.userId,
        ignoreItemsRegionFilter: params.ignoreItemsRegionFilter,
        templateName: template.name,
        templateDescription: template.description,
        templateUpdatedAt: template.updated_at
          ? new Date(template.updated_at)
          : null,
        resolveImageSrc,
      },
    );

    warnings.push(...result.warnings);

    if (result.doc.content.length === 0) {
      throw new BadRequestException(
        'This template has no content to push to a wiki page',
      );
    }

    const nodeCount = this.tiptapRenderService.countNodes(result.doc);

    if (nodeCount > MAX_TIPTAP_NODES) {
      throw new HttpException(
        `This export is too large for a wiki page (${nodeCount} nodes) — reduce the export scope`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const content = JSON.stringify(result.doc);

    if (Buffer.byteLength(content, 'utf8') > MAX_WIKI_CONTENT_BYTES) {
      throw new BadRequestException(
        'Rendered document is too large for a wiki page (5 MB content limit) — reduce the export scope',
      );
    }

    return { template, content, warnings };
  }

  /** Re-uploads storage-kind template images into the wiki's own storage — a 300s signed URL would go permanently broken on a persisted page. */
  private async prepareWikiImages(
    organizationId: string,
    spaceId: string,
    definition: IDocumentTemplateDefinition,
    warnings: string[],
  ): Promise<(src: DocImageSrc) => string> {
    const resolved = new Map<string, string>();

    for (const el of definition.elements) {
      if (el.type !== 'image' || el.src.kind !== 'storage') continue;

      const key = `${el.src.bucket}/${el.src.path}`;

      if (resolved.has(key)) continue;

      if (!isAllowedTemplateImageSource(organizationId, el.src)) {
        warnings.push(
          `Image element ${el.id}: storage image outside the organization's allowed buckets — rendered empty`,
        );
        resolved.set(key, '');
        continue;
      }

      const { data, error } = await this.client.storage
        .from(el.src.bucket)
        .download(el.src.path);

      if (error || !data) {
        warnings.push(
          `Image element ${el.id}: could not read the source image — rendered empty`,
        );
        resolved.set(key, '');
        continue;
      }

      try {
        const buffer = Buffer.from(await data.arrayBuffer());
        const uploaded = await this.wikiService.uploadImage(spaceId, {
          buffer,
          mimetype: data.type || 'application/octet-stream',
          originalname: el.src.path.split('/').pop() || 'image',
          size: buffer.length,
        } as Express.Multer.File);

        resolved.set(key, typeof uploaded.url === 'string' ? uploaded.url : '');
      } catch {
        warnings.push(
          `Image element ${el.id}: could not copy the image into the wiki space — rendered empty`,
        );
        resolved.set(key, '');
      }
    }

    return (src: DocImageSrc) =>
      src.kind === 'storage'
        ? (resolved.get(`${src.bucket}/${src.path}`) ?? '')
        : '';
  }

  /** Bounded retry on a slug collision — WikiService.createPage can throw on the (space_id, slug) unique race, mirroring the migration engine's own retry for the same case. */
  private async createWithRetry(
    dto: CreateWikiPageDto,
    organizationId: string,
    userId: string,
    attempt = 0,
  ): Promise<unknown> {
    try {
      return await this.wikiService.createPage(dto, organizationId, userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (attempt >= 2 || !/duplicate|unique|slug/i.test(message)) throw err;

      return this.createWithRetry(
        { ...dto, title: `${dto.title} (${attempt + 2})` },
        organizationId,
        userId,
        attempt + 1,
      );
    }
  }

  private async recordLink(
    pageId: string,
    templateId: string,
    templateName: string,
    scope: Record<string, unknown>,
    userId: string,
  ): Promise<void> {
    await this.client.from('wiki_page_links').insert({
      source_page_id: pageId,
      target_type: 'document_export_template',
      target_id: templateId,
      target_metadata: {
        template_name: templateName,
        scope,
        pushed_at: new Date().toISOString(),
      },
      created_by: userId,
    });
  }

  private async findLink(
    pageId: string,
    templateId: string,
  ): Promise<Record<string, unknown> | null> {
    const { data } = await this.client
      .from('wiki_page_links')
      .select('id, target_metadata')
      .eq('source_page_id', pageId)
      .eq('target_type', 'document_export_template')
      .eq('target_id', templateId)
      .maybeSingle();

    return data ?? null;
  }

  /**
   * Guards against a cross-org data-integrity gap: `SpacePermissionsGuard`
   * checks whether the acting user holds the required permission on
   * `spaceId`, but never confirms that space actually belongs to the acting
   * session's `organizationId` — a user with grants in multiple orgs (or any
   * future permission-resolution gap) could otherwise push a page whose
   * `space_id` and `organization_id` (stamped from the session, not derived
   * from the space) disagree, corrupting the org/space pairing every other
   * org-scoped query in this codebase assumes holds.
   */
  private async assertSpaceInOrganization(
    spaceId: string,
    organizationId: string,
  ): Promise<void> {
    const { data } = await this.client
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!data) {
      throw new BadRequestException(
        'Target space does not belong to your organization',
      );
    }
  }

  private async countOpenComments(pageId: string): Promise<number> {
    const { count } = await this.client
      .from('wiki_page_comments')
      .select('id', { count: 'exact', head: true })
      .eq('wiki_page_id', pageId)
      .is('resolved_at', null);

    return count ?? 0;
  }

  /**
   * Mirrors document-exports.service.ts's assertScope() exactly. Without this,
   * an empty/ambiguous scope (e.g. from an automation's {{ }} substitution
   * resolving to nothing) falls through to selectDirect()'s unfiltered-query
   * path for the 7 direct-read source entities instead of failing loud — a
   * gap the export path already closed but this one hadn't (found during
   * planning for automation support, approved as a required fix).
   */
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
}
