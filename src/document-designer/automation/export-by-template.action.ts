/**
 * @fileoverview Automation action "Export by Template": renders a Document
 * Designer template and delivers it one of three ways — emailed (attached
 * directly when it fits the size budget, otherwise as a 7-day signed download
 * link), saved as a file in File Explorer, or pushed into a Wiki page
 * (created fresh, or updated in place if this template+scope was already
 * pushed to a page in this space before). The action registers itself with
 * the {@link ActionRegistryService} on module init so the automations module
 * never has to know about the document designer (dependency points this way
 * only; no cycle).
 *
 * Scope, one of three modes: a saved filter (batch, only valid for
 * filter-engine-backed source entities); an explicit list of entity ids —
 * normally a single `{{ trigger.task.id }}`-style token so the document covers
 * whichever entity fired the trigger; or all items in the automation's space,
 * which mirrors the manual Export dialog's "All items" scope exactly. An
 * entityIds list that resolves to nothing after `{{ }}` substitution is treated
 * as zero matched items, never passed through as a literal empty array — see
 * resolveScope().
 *
 * With an entity-ids scope the template's TOP-LEVEL `items` region filter is
 * skipped (ignoreItemsRegionFilter): that filter narrows a broad list, so
 * re-applying it to a record the automation named explicitly could only delete
 * it, silently yielding a blank document. Saved-filter and all-items scopes are
 * list-shaped and keep the filter; nested regions always keep theirs.
 *
 * Write permissions: the save-as-file and create-wiki-page destinations
 * explicitly check the acting user's space permission before writing
 * (create_file_explorer / create_wiki_pages / edit_wiki_pages) — unlike the
 * pre-existing app.wiki.create_page action, which performs no such check.
 * This was a deliberate choice made when this feature was designed, not an
 * oversight or an attempt to retrofit the older action.
 *
 * Templating: the automation worker resolves `{{ trigger.* }}` /
 * `{{ nodes.* }}` / `{{ variables.* }}` placeholders in the node config BEFORE
 * dispatch (`resolveConfigTemplates` → `substitute`), and `substitute` leaves
 * unknown placeholders untouched. The local tokens `{{template}}`, `{{date}}`,
 * `{{count}}` and `{{runId}}` therefore survive to this handler, which
 * resolves them here for subject, message, and fileNamePattern.
 * @module src/document-designer/automation/export-by-template.action
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { format as formatDateFns } from 'date-fns';
import { z } from 'zod';
import { ActionRegistryService } from '../../automations/actions/action-registry.service';
import type {
  ActionDefinition,
  ExecutionContext,
} from '../../automations/actions/types';
import { hasUnresolvedPlaceholder } from '../../automations/utils/template';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { UploadFileDto } from '../../file-explorer/dto/upload-file.dto';
import type { IFeNode } from '../../file-explorer/interfaces/fe-node.interface';
import { FileExplorerService } from '../../file-explorer/file-explorer.service';
import { MailService } from '../../mail/mail.service';
import { spaceGrantAllows } from '../../permissions/models/space-permissions.model';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { DOCUMENT_EXPORTS_BUCKET } from '../document-exports.constants';
import {
  DocumentExportsService,
  sanitizeFileName,
} from '../document-exports.service';
import { DocumentWikiPushService } from '../document-wiki-push.service';
import type { IDocumentExportScope } from '../rendering/document-data-resolver.service';

/** Attachment size budget (bytes) before falling back to a signed link. */
const DEFAULT_ATTACHMENT_MAX_BYTES = 15_728_640; // 15 MiB

/** Signed download link lifetime for oversized exports. */
const SIGNED_LINK_TTL_SECONDS = 604_800; // 7 days

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const configSchema = z
  .object({
    templateId: z.uuid(),
    destination: z
      .enum(['email', 'save_as_file', 'create_wiki_page'])
      .default('email'),
    scopeMode: z
      .enum(['saved_filter', 'entity_ids', 'all_items'])
      .default('saved_filter'),
    savedFilterId: z.uuid().optional(),
    entityIds: z.array(z.string().min(1)).min(1).max(50).optional(),
    format: z.enum(['pdf', 'docx']).optional(),
    // Each entry may be a literal email OR a value that resolves (via {{ }}
    // substitution, already applied before this schema runs) to a users.id —
    // classified and looked up at execute-time, see resolveRecipients().
    // format:'email' is intentionally NOT enforced here (schema-time), unlike
    // the pre-existing `to` field on integration.email.send — a UUID would
    // fail that check before we ever get a chance to look it up.
    recipients: z.array(z.string().min(1)).min(1).max(20).optional(),
    subject: z.string().max(200).optional(),
    message: z.string().max(5000).optional(),
    fileNamePattern: z.string().max(120).optional(),
    skipIfEmpty: z.boolean().optional().default(false),
    spaceFolderId: z.uuid().optional(),
    wikiParentPageId: z.uuid().optional(),
    wikiTitle: z.string().max(500).optional(),
    overwriteIfEdited: z.boolean().optional().default(false),
  })
  .superRefine((config, ctx) => {
    if (config.scopeMode === 'saved_filter' && !config.savedFilterId) {
      ctx.addIssue({
        code: 'custom',
        path: ['savedFilterId'],
        message: 'savedFilterId is required when scopeMode is "saved_filter"',
      });
    }

    if (
      config.scopeMode === 'entity_ids' &&
      (!config.entityIds || config.entityIds.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['entityIds'],
        message: 'entityIds is required when scopeMode is "entity_ids"',
      });
    }

    if (config.destination !== 'create_wiki_page' && !config.format) {
      ctx.addIssue({
        code: 'custom',
        path: ['format'],
        message: 'format is required for this destination',
      });
    }

    if (
      config.destination === 'email' &&
      (!config.recipients || config.recipients.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['recipients'],
        message: 'recipients is required for the email destination',
      });
    }
  });

type ExportByTemplateConfig = z.infer<typeof configSchema>;

interface IExportByTemplateOutput {
  ok: boolean;
  exportId: string | null;
  itemCount: number;
  delivered:
    | 'attachment'
    | 'link'
    | 'skipped'
    | 'uploaded'
    | 'wiki_created'
    | 'wiki_updated';
  pageId?: string | null;
  fileNodeId?: string | null;
  /** Direct in-app link to the created file/page — absent for email/skipped deliveries. */
  fileUrl?: string | null;
  pageUrl?: string | null;
}

/** Local tokens resolved AFTER the export, when the item count is known. */
interface ILocalTokens {
  template: string;
  date: string;
  count: string;
  runId: string;
}

function resolveTokens(value: string, tokens: ILocalTokens): string {
  return value.replace(
    /\{\{\s*(template|date|count|runId)\s*\}\}/g,
    (_match, key: keyof ILocalTokens) => tokens[key],
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Order-independent scope equality — matches how a prior wiki push is found. */
function scopesMatch(
  a: IDocumentExportScope | undefined | null,
  b: IDocumentExportScope,
): boolean {
  if (!a) return false;
  if (a.savedFilterId || b.savedFilterId) {
    return Boolean(a.savedFilterId) && a.savedFilterId === b.savedFilterId;
  }
  if (a.ids && b.ids) {
    if (a.ids.length !== b.ids.length) return false;
    const sortedA = [...a.ids].sort();
    const sortedB = [...b.ids].sort();

    return sortedA.every((id, i) => id === sortedB[i]);
  }

  return false;
}

@Injectable()
export class ExportByTemplateAction implements OnModuleInit {
  private readonly logger = new Logger(ExportByTemplateAction.name);

  constructor(
    private readonly registry: ActionRegistryService,
    private readonly documentExports: DocumentExportsService,
    private readonly documentWikiPush: DocumentWikiPushService,
    private readonly fileExplorer: FileExplorerService,
    private readonly permissionsService: PermissionsService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.buildDefinition());
  }

  buildDefinition(): ActionDefinition {
    return {
      kind: 'app.document.export_by_template',
      category: 'app_mutation',
      type: 'action',
      label: { en: 'Export by Template', de: 'Export per Vorlage' },
      description: {
        en: 'Renders a document template and delivers it by email, as a File Explorer file, or as a wiki page',
        de: 'Rendert eine Dokumentvorlage und liefert sie per E-Mail, als File-Explorer-Datei oder als Wiki-Seite',
      },
      icon: 'bx-export',
      inputSchema: z.unknown(),
      configSchema,
      outputSchema: z.object({
        ok: z.boolean(),
        exportId: z.string().nullable(),
        itemCount: z.number(),
        delivered: z.enum([
          'attachment',
          'link',
          'skipped',
          'uploaded',
          'wiki_created',
          'wiki_updated',
        ]),
        pageId: z.string().nullable().optional(),
        fileNodeId: z.string().nullable().optional(),
        fileUrl: z.string().nullable().optional(),
        pageUrl: z.string().nullable().optional(),
      }),
      handler: (config: unknown, _input: unknown, ctx: ExecutionContext) =>
        this.execute(config as ExportByTemplateConfig, ctx),
    };
  }

  private async execute(
    config: ExportByTemplateConfig,
    ctx: ExecutionContext,
  ): Promise<IExportByTemplateOutput> {
    const actingUserId = ctx.actingUserId;

    if (!actingUserId) {
      throw new Error(
        'Export by Template requires an acting user; configure a service user for this automation',
      );
    }

    const scope = this.resolveScope(config, ctx);

    if (!scope) {
      if (config.skipIfEmpty) {
        ctx.logger.info(
          'Export by Template: entityIds resolved to no valid ids — skipping (skipIfEmpty)',
        );

        return { ok: true, exportId: null, itemCount: 0, delivered: 'skipped' };
      }

      throw new BadRequestException(
        'Export by Template: entityIds resolved to no valid ids after {{ }} substitution — set skipIfEmpty to skip silently instead of failing the run',
      );
    }

    if (config.destination === 'save_as_file') {
      await this.assertSpacePermission(
        actingUserId,
        ctx.organizationId,
        ctx.spaceId,
        'create_file_explorer',
      );
    }

    if (config.destination === 'create_wiki_page') {
      return this.executeWikiDestination(config, ctx, scope, actingUserId);
    }

    // email / save_as_file both render+store through the shared export path.
    // The item count is only known after data resolution, which happens
    // inside export() (the resolver applies the scope + strict caps — there
    // is no cheap pre-count path). skipIfEmpty therefore renders and stores
    // the (empty) document anyway and only skips the delivery step. Any
    // failure inside export() has already marked the document_exports row
    // failed; errors propagate so the worker handles retries/failure marking.
    const result = await this.documentExports.export({
      organizationId: ctx.organizationId,
      userId: actingUserId,
      templateId: config.templateId,
      format: config.format!,
      scope,
      delivery: 'store',
      source: 'automation',
      automationRunId: ctx.runId,
      fileName: undefined,
      ignoreItemsRegionFilter: config.scopeMode === 'entity_ids',
    });

    const itemCount = result.record.item_count ?? 0;
    const exportId = result.record.id ?? null;

    if (config.skipIfEmpty && itemCount === 0) {
      ctx.logger.info(
        'Export by Template: 0 items matched the scope — skipping delivery (skipIfEmpty)',
      );

      return { ok: true, exportId, itemCount, delivered: 'skipped' };
    }

    if (config.destination === 'save_as_file') {
      const fileNode = await this.uploadToFileExplorer(
        config,
        ctx,
        result,
        actingUserId,
      );
      const spaceKey = await this.resolveSpaceKey(ctx);

      return {
        ok: true,
        exportId,
        itemCount,
        delivered: 'uploaded',
        fileNodeId: fileNode.id,
        fileUrl: spaceKey
          ? this.buildAppUrl(
              `/spaces/${spaceKey}/file-explorer?previewNodeId=${fileNode.id}`,
            )
          : null,
      };
    }

    return this.deliverByEmail(config, ctx, result, exportId, itemCount);
  }

  /**
   * Builds the scope object export()/pushToWiki() expect. For 'entity_ids'
   * mode, filters out any entry that's still an unresolved {{ }} placeholder
   * or blank after substitution — returns null (not an empty array) when
   * nothing survives, so the caller can distinguish "no valid scope" from
   * "a real but non-matching scope" and never hand either service layer a
   * literal empty ids:[] (which — for the 7 direct-read source entities —
   * silently falls through to an unfiltered query rather than zero rows).
   */
  private resolveScope(
    config: ExportByTemplateConfig,
    ctx: ExecutionContext,
  ): IDocumentExportScope | null {
    // Every item in the automation's own space — byte-identical to what the
    // manual Export dialog sends for its "All items" choice
    // (ExportTemplateDialog.buildScope: query EMPTY_QUERY + source_space_ids),
    // so an automated export matches a hand-run one for the same template.
    if (config.scopeMode === 'all_items') {
      return {
        query: { combinator: 'and', rules: [] },
        source_space_ids: [ctx.spaceId],
      };
    }

    // Positive check on 'entity_ids' (not '=== saved_filter') so an
    // unset/unrecognised scopeMode defaults to the saved-filter behavior —
    // matches the zod schema's own default('saved_filter') for any caller
    // that (unlike the real dispatch() path) invokes the handler directly
    // without going through configSchema.safeParse() first.
    if (config.scopeMode !== 'entity_ids') {
      return { savedFilterId: config.savedFilterId };
    }

    const validIds = (config.entityIds ?? []).filter((id) => {
      if (hasUnresolvedPlaceholder(id)) {
        ctx.logger.info(
          `Export by Template: entityIds entry "${id}" left an unresolved {{ }} token — dropped`,
        );

        return false;
      }

      return id.trim().length > 0;
    });

    return validIds.length > 0 ? { ids: validIds } : null;
  }

  private async assertSpacePermission(
    userId: string,
    organizationId: string,
    spaceId: string,
    permission: string,
  ): Promise<void> {
    const grant = await this.permissionsService.resolveSpaceBaseGrant(
      userId,
      organizationId,
      spaceId,
    );

    if (!spaceGrantAllows(grant, permission)) {
      throw new ForbiddenException(
        `Export by Template: the acting user lacks the "${permission}" permission in this space`,
      );
    }
  }

  private async deliverByEmail(
    config: ExportByTemplateConfig,
    ctx: ExecutionContext,
    result: Awaited<ReturnType<DocumentExportsService['export']>>,
    exportId: string | null,
    itemCount: number,
  ): Promise<IExportByTemplateOutput> {
    const recipients = await this.resolveRecipients(
      config.recipients ?? [],
      ctx,
    );

    if (recipients.length === 0) {
      ctx.logger.info(
        'Export by Template: no deliverable recipients after resolution — skipping email',
      );

      return { ok: true, exportId, itemCount, delivered: 'skipped' };
    }

    const tokens: ILocalTokens = {
      template: result.record.template_name,
      date: formatDateFns(new Date(), 'yyyy-MM-dd'),
      count: String(itemCount),
      runId: ctx.runId.slice(0, 8),
    };

    const subject = config.subject
      ? resolveTokens(config.subject, tokens)
      : `Document export: ${tokens.template}`;

    const message = config.message
      ? resolveTokens(config.message, tokens)
      : undefined;

    const attachmentFileName = config.fileNamePattern
      ? `${sanitizeFileName(
          resolveTokens(config.fileNamePattern, tokens),
          `${tokens.template}-${tokens.date}`,
        )}.${config.format}`
      : result.fileName;

    const footer = `Generated automatically by XISUITE from template "${tokens.template}" — ${itemCount} item(s).`;

    if (result.buffer.length <= this.attachmentMaxBytes) {
      await this.mailService.sendWithAttachments({
        to: recipients,
        subject,
        html: this.buildEmailHtml(message, footer),
        text: [message, footer].filter(Boolean).join('\n\n'),
        attachments: [
          {
            filename: attachmentFileName,
            content: result.buffer,
            contentType: result.mimeType,
          },
        ],
      });

      return { ok: true, exportId, itemCount, delivered: 'attachment' };
    }

    // Oversized: store-only + 7-day signed download link instead of a huge
    // attachment that most relays would reject anyway.
    const signedUrl = await this.createSignedLink(result.record.file_path);

    this.logger.log(
      `Export ${exportId ?? '(unknown)'} is ${result.buffer.length} bytes (> ${this.attachmentMaxBytes}) — emailing a signed link instead of an attachment`,
    );

    const linkFooter = `${footer} The download link expires in 7 days.`;

    await this.mailService.sendWithAttachments({
      to: recipients,
      subject,
      html: this.buildEmailHtml(message, linkFooter, {
        url: signedUrl,
        label: `Download ${attachmentFileName}`,
      }),
      text: [message, `Download: ${signedUrl}`, linkFooter]
        .filter(Boolean)
        .join('\n\n'),
      attachments: [],
    });

    return { ok: true, exportId, itemCount, delivered: 'link' };
  }

  /**
   * Classifies each recipient entry: a literal email is used as-is; a
   * users.id-shaped UUID (e.g. from `{{ trigger.task.assigned_to }}`) is
   * resolved to that user's email; anything else (still-unresolved {{ }},
   * garbage) is dropped with a logged warning rather than failing the run —
   * one unassigned task shouldn't break an otherwise-working automation.
   */
  private async resolveRecipients(
    recipients: string[],
    ctx: ExecutionContext,
  ): Promise<string[]> {
    const resolved: string[] = [];

    for (const entry of recipients) {
      if (hasUnresolvedPlaceholder(entry)) {
        ctx.logger.info(
          `Export by Template: recipient "${entry}" left an unresolved {{ }} token — skipped`,
        );
        continue;
      }

      if (EMAIL_RE.test(entry)) {
        resolved.push(entry);
        continue;
      }

      if (UUID_RE.test(entry)) {
        const { data } = await ctx.supabase
          .from('users')
          .select('email')
          .eq('id', entry)
          .maybeSingle();

        if (data?.email) {
          resolved.push(data.email as string);
        } else {
          ctx.logger.info(
            `Export by Template: recipient user id "${entry}" has no resolvable email — skipped`,
          );
        }
        continue;
      }

      ctx.logger.info(
        `Export by Template: recipient "${entry}" is neither an email nor a user id — skipped`,
      );
    }

    return resolved;
  }

  private async uploadToFileExplorer(
    config: ExportByTemplateConfig,
    ctx: ExecutionContext,
    result: Awaited<ReturnType<DocumentExportsService['export']>>,
    actingUserId: string,
  ): Promise<IFeNode> {
    const tokens: ILocalTokens = {
      template: result.record.template_name,
      date: formatDateFns(new Date(), 'yyyy-MM-dd'),
      count: String(result.record.item_count ?? 0),
      runId: ctx.runId.slice(0, 8),
    };

    // Default pattern includes {{runId}} so back-to-back runs don't collide
    // against fe_nodes' (space_id, parent_id, lower(name)) unique index —
    // a real collision still fails loud via uploadNewFile's own
    // ConflictException rather than being silently papered over here.
    const pattern = config.fileNamePattern ?? '{{template}}-{{date}}-{{runId}}';
    const baseName = sanitizeFileName(
      resolveTokens(pattern, tokens),
      `${tokens.template}-${tokens.date}-${tokens.runId}`,
    );
    const fileName = `${baseName}.${config.format}`;

    const syntheticUser: RequestUser = {
      authUserId: '',
      userId: actingUserId,
      email: '',
      organizationId: ctx.organizationId,
      memberships: [],
    };

    const file = {
      buffer: result.buffer,
      mimetype: result.mimeType,
      originalname: fileName,
      size: result.buffer.length,
    } as Express.Multer.File;

    return this.fileExplorer.uploadNewFile(
      syntheticUser,
      ctx.spaceId,
      {
        space_id: ctx.spaceId,
        parent_id: config.spaceFolderId,
        comment: `Automated export — automation run ${ctx.runId}`,
      } as UploadFileDto,
      file,
    );
  }

  private async executeWikiDestination(
    config: ExportByTemplateConfig,
    ctx: ExecutionContext,
    scope: IDocumentExportScope,
    actingUserId: string,
  ): Promise<IExportByTemplateOutput> {
    const existing = await this.findMatchingWikiPush(
      ctx,
      config.templateId,
      scope,
    );
    const permission = existing ? 'edit_wiki_pages' : 'create_wiki_pages';

    await this.assertSpacePermission(
      actingUserId,
      ctx.organizationId,
      ctx.spaceId,
      permission,
    );

    try {
      const spaceKey = await this.resolveSpaceKey(ctx);

      if (existing) {
        const { page } = await this.documentWikiPush.updateWikiPush({
          organizationId: ctx.organizationId,
          userId: actingUserId,
          templateId: config.templateId,
          spaceId: ctx.spaceId,
          scope: scope as Record<string, unknown>,
          pageId: existing.pageId,
          confirmed: config.overwriteIfEdited,
          ignoreItemsRegionFilter: config.scopeMode === 'entity_ids',
        });

        return {
          ok: true,
          exportId: null,
          itemCount: 0,
          delivered: 'wiki_updated',
          pageId: String(page.id),
          pageUrl: spaceKey
            ? this.buildAppUrl(`/spaces/${spaceKey}/wiki/${String(page.id)}`)
            : null,
        };
      }

      const { page } = await this.documentWikiPush.pushToWiki({
        organizationId: ctx.organizationId,
        userId: actingUserId,
        templateId: config.templateId,
        spaceId: ctx.spaceId,
        scope: scope as Record<string, unknown>,
        parentId: config.wikiParentPageId,
        title: config.wikiTitle,
        ignoreItemsRegionFilter: config.scopeMode === 'entity_ids',
      });

      return {
        ok: true,
        exportId: null,
        itemCount: 0,
        delivered: 'wiki_created',
        pageId: String(page.id),
        pageUrl: spaceKey
          ? this.buildAppUrl(`/spaces/${spaceKey}/wiki/${String(page.id)}`)
          : null,
      };
    } catch (err) {
      if (err instanceof ConflictException) {
        ctx.logger.info(
          `Export by Template: wiki page was hand-edited since the last automated push — skipping overwrite (${err.message})`,
        );

        return { ok: true, exportId: null, itemCount: 0, delivered: 'skipped' };
      }

      if (
        config.skipIfEmpty &&
        err instanceof BadRequestException &&
        /no content to push/i.test(err.message)
      ) {
        ctx.logger.info(
          'Export by Template: 0 items matched — skipping wiki push (skipIfEmpty)',
        );

        return { ok: true, exportId: null, itemCount: 0, delivered: 'skipped' };
      }

      throw err;
    }
  }

  /**
   * Looks up any prior push of this template into THIS space whose recorded
   * scope matches the current run's scope, so a re-run updates the same page
   * instead of creating a duplicate. Queries wiki_page_links directly (rather
   * than DocumentWikiPushService.listWikiPushes(), whose return shape omits
   * target_metadata.scope) — keeps that service's public surface untouched
   * beyond the approved assertScope() fix.
   */
  private async findMatchingWikiPush(
    ctx: ExecutionContext,
    templateId: string,
    scope: IDocumentExportScope,
  ): Promise<{ pageId: string } | null> {
    const { data, error } = await ctx.supabase
      .from('wiki_page_links')
      .select(
        'source_page_id, target_metadata, wiki_pages!source_page_id(space_id, organization_id)',
      )
      .eq('target_type', 'document_export_template')
      .eq('target_id', templateId);

    if (error) {
      throw new Error(
        `Export by Template: failed to look up prior wiki pushes: ${error.message}`,
      );
    }

    const match = (data ?? []).find((row: Record<string, unknown>) => {
      const page = row['wiki_pages'] as {
        space_id?: string;
        organization_id?: string;
      } | null;

      if (
        page?.space_id !== ctx.spaceId ||
        page?.organization_id !== ctx.organizationId
      ) {
        return false;
      }

      const meta = row['target_metadata'] as {
        scope?: IDocumentExportScope;
      } | null;

      return scopesMatch(meta?.scope, scope);
    });

    return match ? { pageId: String(match['source_page_id']) } : null;
  }

  /** Space `key` (URL slug) for the app-link output fields — same config key/fallback pattern already used by notification-email.service.ts for its CTA links. */
  private buildAppUrl(relativePath: string): string {
    const appUrl = (
      this.configService.get<string>('appUrl') || 'http://localhost:3000'
    ).replace(/\/+$/, '');

    return `${appUrl}${relativePath}`;
  }

  private async resolveSpaceKey(ctx: ExecutionContext): Promise<string | null> {
    const { data } = await ctx.supabase
      .from('spaces')
      .select('key')
      .eq('id', ctx.spaceId)
      .maybeSingle();

    return (data?.key as string | undefined) ?? null;
  }

  private get attachmentMaxBytes(): number {
    const raw = this.configService.get<string | number>(
      'DOCUMENT_EMAIL_ATTACHMENT_MAX_BYTES',
    );
    const parsed = Number(raw);

    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_ATTACHMENT_MAX_BYTES;
  }

  private async createSignedLink(filePath: string | null): Promise<string> {
    if (!filePath) {
      throw new Error(
        'Export completed without a stored file path — cannot build a download link',
      );
    }

    const { data, error } = await this.supabaseAdmin
      .getClient()
      .storage.from(DOCUMENT_EXPORTS_BUCKET)
      .createSignedUrl(filePath, SIGNED_LINK_TTL_SECONDS);

    if (error || !data?.signedUrl) {
      throw new Error(
        `Failed to create a signed download link for the export: ${error?.message ?? 'no URL returned'}`,
      );
    }

    return data.signedUrl;
  }

  /**
   * Minimal inline-styled HTML body: optional user message (escaped,
   * newlines → <br>), optional download button, and a footer line.
   */
  private buildEmailHtml(
    message: string | undefined,
    footer: string,
    link?: { url: string; label: string },
  ): string {
    const messageHtml = message
      ? `<p style="margin:0 0 16px">${escapeHtml(message).replace(/\r?\n/g, '<br>')}</p>`
      : '';
    const linkHtml = link
      ? `<p style="margin:0 0 16px"><a href="${link.url}" style="display:inline-block;background:#696CFF;color:#ffffff;text-decoration:none;font-weight:600;border-radius:6px;padding:10px 18px">${escapeHtml(link.label)}</a></p>`
      : '';

    return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#22303E;padding:16px">${messageHtml}${linkHtml}<p style="margin:0;font-size:12px;color:#8592A3">${escapeHtml(footer)}</p></div>`;
  }
}
