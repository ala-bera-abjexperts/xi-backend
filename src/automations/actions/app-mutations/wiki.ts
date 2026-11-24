import { z } from 'zod';

import { extractWikiPlainText } from '../../../wiki/wiki-content.util';
import type { ActionDefinition, ExecutionContext } from '../types';

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

export const wikiCreatePage: ActionDefinition = {
  kind: 'app.wiki.create_page',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Create wiki page', de: 'Wiki-Seite erstellen' },
  description: {
    en: 'Creates a new wiki page in the specified space',
    de: 'Erstellt eine neue Wiki-Seite im angegebenen Bereich',
  },
  icon: 'bx-book-add',
  inputSchema: z.unknown(),
  configSchema: z.object({
    title: z.string().min(1).max(500),
    content: z.string().optional(),
    spaceId: z.string().min(1).optional(),
    parentId: z.string().uuid().optional(),
    isPublished: z.boolean().optional(),
  }),
  outputSchema: z.object({
    page: z.object({
      id: z.string().uuid(),
      title: z.string(),
      slug: z.string(),
      space_id: z.string(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      title: string;
      content?: string;
      spaceId?: string;
      parentId?: string;
      isPublished?: boolean;
    };

    const spaceId = conf.spaceId ?? ctx.spaceId;
    if (!spaceId) throw new Error('wikiCreatePage: spaceId is required');

    const slug = slugify(conf.title) || `page-${Date.now()}`;
    const content = conf.content ?? '';
    const isPublished = conf.isPublished ?? false;

    const insert: Record<string, unknown> = {
      space_id: spaceId,
      organization_id: ctx.organizationId,
      title: conf.title,
      slug,
      content,
      content_format: 'editorjs',
      // Feed search_vector with the page body and keep workflow_status coherent
      // with is_published (a published page must not read as a draft).
      content_text: extractWikiPlainText(content, 'editorjs'),
      workflow_status: isPublished ? 'published' : 'draft',
      parent_id: conf.parentId ?? null,
      path: [],
      level: 0,
      is_published: isPublished,
      is_archived: false,
      tags: [],
      metadata: {},
      has_custom_permissions: false,
      created_by: ctx.actingUserId,
      updated_by: ctx.actingUserId,
    };

    const { data, error } = await ctx.supabase
      .from('wiki_pages')
      .insert(insert)
      .select('id, title, slug, space_id')
      .single();

    if (error) throw new Error(`Failed to create wiki page: ${error.message}`);

    const row = data as {
      id: string;
      title: string;
      slug: string;
      space_id: string;
    };

    return {
      page: {
        id: row.id,
        title: row.title,
        slug: row.slug,
        space_id: row.space_id,
      },
    };
  },
};

export const wikiUpdatePage: ActionDefinition = {
  kind: 'app.wiki.update_page',
  category: 'app_mutation',
  type: 'action',
  label: { en: 'Update wiki page', de: 'Wiki-Seite aktualisieren' },
  description: {
    en: 'Updates the title or content of an existing wiki page',
    de: 'Aktualisiert Titel oder Inhalt einer vorhandenen Wiki-Seite',
  },
  icon: 'bx-book-open',
  inputSchema: z.unknown(),
  configSchema: z.object({
    pageId: z.string().min(1),
    title: z.string().min(1).max(500).optional(),
    content: z.string().optional(),
    isPublished: z.boolean().optional(),
  }),
  outputSchema: z.object({
    page: z.object({
      id: z.string().uuid(),
      title: z.string(),
      slug: z.string(),
      space_id: z.string(),
    }),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      pageId: string;
      title?: string;
      content?: string;
      isPublished?: boolean;
    };

    const patch: Record<string, unknown> = { updated_by: ctx.actingUserId };

    if (conf.title !== undefined) patch.title = conf.title;

    if (conf.isPublished !== undefined) {
      patch.is_published = conf.isPublished;
      patch.workflow_status = conf.isPublished ? 'published' : 'draft';
    }

    if (conf.content !== undefined) {
      // Automations emit editorjs/html strings, never TipTap (Wiki 2.0) JSON.
      // Fetch the stored content_format so we (a) recompute content_text with
      // the correct extractor and (b) never overwrite a TipTap document with a
      // non-TipTap string, which would corrupt the page. TipTap pages skip the
      // content field; other fields (title/publish) still apply.
      const { data: existing } = await ctx.supabase
        .from('wiki_pages')
        .select('content_format')
        .eq('id', conf.pageId)
        .eq('organization_id', ctx.organizationId)
        .single();

      const storedFormat =
        (existing as { content_format?: string } | null)?.content_format ??
        'editorjs';

      if (storedFormat === 'tiptap') {
        ctx.logger.info(
          `wikiUpdatePage: skipping content update for TipTap page ${conf.pageId} (automation content is not TipTap)`,
        );
      } else {
        patch.content = conf.content;
        patch.content_text = extractWikiPlainText(conf.content, storedFormat);
      }
    }

    const { data, error } = await ctx.supabase
      .from('wiki_pages')
      .update(patch)
      .eq('id', conf.pageId)
      .eq('organization_id', ctx.organizationId)
      // Whiteboard link rows: their title is the board's name, which needs edit_whiteboards.
      .is('whiteboard_id', null)
      .select('id, title, slug, space_id')
      .single();

    if (error) throw new Error(`Failed to update wiki page: ${error.message}`);

    const row = data as {
      id: string;
      title: string;
      slug: string;
      space_id: string;
    };

    return {
      page: {
        id: row.id,
        title: row.title,
        slug: row.slug,
        space_id: row.space_id,
      },
    };
  },
};
