/**
 * @fileoverview The tasks and wiki pages a Robert request refers to, read as the invoker before the
 * model call (1.15): task keys in the request, then tasks and pages linked in the conversation
 * window, then page titles the request quotes. Every read goes through the permission-checked
 * "mine" readers, so a task or page the invoker cannot see is never read, quoted or named.
 *
 * The material is data for the model (handles T1…, W1…), sent inside the untrusted block of the
 * prompt like the messages. Its spaces decide whether a card may be shown to the conversation.
 */
import type { AgentFileRead } from './agent-files.service';
import { Injectable, Logger } from '@nestjs/common';

import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { TasksService } from '../tasks/tasks.service';
import { WikiMineService } from '../wiki/wiki-mine.service';
import { cleanUntrusted } from './pipeline/agent-prompt';

export const MAX_REFERENCED_TASKS = 20;
export const MAX_REFERENCED_PAGES = 5;
const MAX_SUBTASKS = 50;
const MAX_COMMENTS = 10;
const MAX_TASK_CHARS = 2_000;
const MAX_PAGE_CHARS = 1_500;
const MAX_MATERIAL_CHARS = 30_000;

/** A task key as the product writes it ("AMBER-T25"). */
const TASK_KEY = /\b[A-Z][A-Z0-9]{0,19}-T\d{1,7}\b/g;
/** A quoted page title in the request: "…", “…”, „…“ or '…'. */
const QUOTED =
  /["“„]([^"“”„\n]{2,120})["”“]|(?<![\p{L}\p{N}])'([^'\n]{2,120})'(?![\p{L}\p{N}])/gu;

export interface AgentTaskMaterial {
  handle: string;
  /** The task's id: its files are read by it (1.18). Never shown to the model. */
  id?: string;
  key: string;
  spaceId: string | null;
  summary: string;
  status: string;
  priority: string;
  assignee: string | null;
  due: string | null;
  labels: string[];
  description: string;
  subtasks: {
    key: string | null;
    summary: string;
    status: string;
    assignee: string | null;
  }[];
  moreSubtasks: number;
  comments: { author: string | null; text: string }[];
  attachments: string[];
}

export interface AgentPageMaterial {
  handle: string;
  id: string;
  spaceId: string | null;
  title: string;
  excerpt: string;
  /** The page or one of its ancestors has its own access list. */
  restricted: boolean;
}

export interface AgentReferences {
  /** 1.19: the tasks and processes Robert already proposed or created for this person in this conversation or thread. */
  earlierTasks?: {
    title: string;
    space: string | null;
    state: 'open' | 'created';
    /** process, wiki_page, plan, plan_item; 1.22.1 plan_link; 1.23 the suggestion kinds. */
    kind?: string;
    /** A process that exists: what the rest of a tree hangs under. */
    key?: string;
    request_type?: string;
    /** 1.23: what makes it the same suggestion (suggestionKey): left out when asked again. */
    match?: string;
  }[];
  /** "The rest": what this person asked for when the answer did not fit. Their own words. */
  earlierRequest?: string;
  tasks: AgentTaskMaterial[];
  pages: AgentPageMaterial[];
  /** Keys the request named that the invoker cannot see or that do not exist. */
  missing: string[];
  /** 1.18: the shared files, read (or not) for the invoker; F1 is the newest. */
  files?: AgentFileRead[];
}

export const NO_REFERENCES: AgentReferences = {
  tasks: [],
  pages: [],
  missing: [],
};

const text = (value: unknown, max: number) =>
  Array.from(
    cleanUntrusted(typeof value === 'string' ? value : '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  )
    .slice(0, max)
    .join('');

const nameKey = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

@Injectable()
export class AgentReferencesService {
  private readonly logger = new Logger(AgentReferencesService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly tasks: TasksService,
    private readonly wiki: WikiMineService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Never throws: without material Robert still answers from the conversation. */
  async load(
    invoker: Pick<RequestUser, 'userId' | 'organizationId'>,
    request: string,
    window: { messageIds: string[]; texts: string[]; conversationId?: string },
  ): Promise<AgentReferences> {
    try {
      return await this.read(invoker as RequestUser, request, window);
    } catch (err) {
      this.logger.warn(
        `Robert references not read: ${err instanceof Error ? err.message : String(err)}`,
      );
      return NO_REFERENCES;
    }
  }

  private async read(
    user: RequestUser,
    request: string,
    window: { messageIds: string[]; texts: string[]; conversationId?: string },
  ): Promise<AgentReferences> {
    const asked = [...new Set(request.match(TASK_KEY) ?? [])];
    const refs = await this.windowRefs(
      user,
      window.messageIds,
      window.conversationId,
    );
    // The request first, then what the conversation links or names, newest last.
    const keys = [
      ...new Set([
        ...asked,
        ...window.texts.flatMap((t) => t.match(TASK_KEY) ?? []),
      ]),
    ];

    const out: AgentReferences = { tasks: [], pages: [], missing: [] };
    let budget = MAX_MATERIAL_CHARS;
    const seen = new Set<string>();

    const addTask = async (idOrKey: string, named: boolean) => {
      if (out.tasks.length >= MAX_REFERENCED_TASKS || budget <= 0) return;
      const material = await this.task(
        user,
        idOrKey,
        `T${out.tasks.length + 1}`,
      );
      if (!material) {
        if (named) out.missing.push(idOrKey);
        return;
      }
      if (seen.has(material.key)) return;
      seen.add(material.key);
      budget -= JSON.stringify(material).length;
      out.tasks.push(material);
    };

    for (const key of keys) await addTask(key, asked.includes(key));
    for (const id of refs.tasks) await addTask(id, false);

    const quoted = [...request.matchAll(QUOTED)].map((m) =>
      (m[1] ?? m[2]).trim(),
    );
    const pageIds = [...refs.pages, ...(await this.pagesByTitle(user, quoted))];
    for (const id of [...new Set(pageIds)]) {
      if (out.pages.length >= MAX_REFERENCED_PAGES || budget <= 0) break;
      const page = await this.page(user, id, `W${out.pages.length + 1}`);
      if (!page) continue;
      budget -= page.excerpt.length;
      out.pages.push(page);
    }
    return out;
  }

  /**
   * Tasks and pages linked in the window's messages (object cards), then what Robert created in
   * this conversation (its cards show them, but no message text names their keys).
   */
  private async windowRefs(
    user: RequestUser,
    messageIds: string[],
    conversationId?: string,
  ): Promise<{ tasks: string[]; pages: string[] }> {
    const [linked, created] = await Promise.all([
      messageIds.length
        ? this.client
            .from('chat_message_refs')
            .select('ref_type, ref_id, created_at')
            .eq('organization_id', user.organizationId)
            .in('message_id', messageIds)
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [] }),
      conversationId
        ? this.client
            .from('agent_object_origins')
            .select('entity_type, entity_id, action_id, created_at')
            .eq('organization_id', user.organizationId)
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: false })
            .limit(MAX_REFERENCED_TASKS)
        : Promise.resolve({ data: [] }),
    ]);
    // An origin row stays after Undo, for the audit. What was undone is not something to refer to.
    const origins = (created.data ?? []) as { entity_type: string; entity_id: string; action_id: string }[];
    const { data: undoneRows } = origins.length
      ? await this.client
          .from('agent_actions')
          .select('id')
          .eq('organization_id', user.organizationId)
          .eq('status', 'undone')
          .in('id', origins.map((o) => o.action_id))
      : { data: [] };
    const undone = new Set(((undoneRows ?? []) as { id: string }[]).map((a) => a.id));
    const rows = [
      ...((linked.data ?? []) as { ref_type: string; ref_id: string }[]),
      ...origins.filter((o) => !undone.has(o.action_id)).map((o) => ({
        ref_type: o.entity_type,
        ref_id: o.entity_id,
      })),
    ];
    return {
      tasks: rows.filter((r) => r.ref_type === 'task').map((r) => r.ref_id),
      pages: rows
        .filter((r) => r.ref_type === 'wiki_page')
        .map((r) => r.ref_id),
    };
  }

  private async task(
    user: RequestUser,
    idOrKey: string,
    handle: string,
  ): Promise<AgentTaskMaterial | null> {
    let detail: Awaited<ReturnType<TasksService['getMyTask']>>;
    try {
      // The permission-checked reader: a uniform 404 for missing, foreign or hidden tasks.
      detail = await this.tasks.getMyTask(user, idOrKey, {
        includeComments: true,
        commentLimit: MAX_COMMENTS,
      });
    } catch {
      return null;
    }
    const t = detail.task;
    if (!t.key) return null;

    // Subtasks share the parent's space, which the invoker may view (getMyTask checked it).
    const [subtasks, attachments] = await Promise.all([
      this.tasks.getSubtasks(t.id, user.organizationId).catch(() => []),
      this.client
        .from('task_attachments')
        .select('file_name')
        .eq('task_id', t.id)
        .eq('organization_id', user.organizationId)
        .limit(20),
    ]);

    return {
      handle,
      id: t.id,
      key: t.key,
      spaceId: t.space?.id ?? null,
      summary: text(t.summary, 300),
      status: t.status,
      priority: t.priority,
      assignee: t.assignee?.name ?? null,
      due: t.dueDate,
      labels: Array.isArray(t.labels)
        ? (t.labels as unknown[]).filter(
            (l): l is string => typeof l === 'string',
          )
        : [],
      description: text(t.description, MAX_TASK_CHARS),
      subtasks: subtasks.slice(0, MAX_SUBTASKS).map((s) => ({
        key: s.key,
        summary: text(s.summary, 200),
        status: s.status_config?.name ?? s.status,
        assignee: s.assignee_name ?? null,
      })),
      moreSubtasks: Math.max(0, subtasks.length - MAX_SUBTASKS),
      comments: (detail.comments ?? []).map((c) => ({
        author: c.author?.name ?? null,
        text: text(c.content, 400),
      })),
      attachments: ((attachments.data ?? []) as { file_name: string }[]).map(
        (a) => text(a.file_name, 120),
      ),
    };
  }

  /** Pages the request names in quotes, matched exactly (case and accents aside) among the readable ones. */
  private async pagesByTitle(
    user: RequestUser,
    titles: string[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const title of titles.slice(0, MAX_REFERENCED_PAGES)) {
      const { pages } = await this.wiki.searchMyWikiPages(user, {
        query: title,
        limit: 10,
      });
      const exact = pages.filter(
        (p) => !p.isArchived && nameKey(p.title) === nameKey(title),
      );
      // Two pages with the same title: neither is read, the model is not to guess.
      if (exact.length === 1) ids.push(exact[0].id);
    }
    return ids;
  }

  private async page(
    user: RequestUser,
    id: string,
    handle: string,
  ): Promise<AgentPageMaterial | null> {
    try {
      const { page } = await this.wiki.getMyWikiPage(user, id);
      if (page.isArchived) return null;
      return {
        handle,
        id: page.id,
        spaceId: page.space?.id ?? null,
        title: text(page.title, 300),
        excerpt: text(page.contentText, MAX_PAGE_CHARS),
        restricted: await this.isRestricted(user.organizationId, page.id),
      };
    } catch {
      return null;
    }
  }

  /** Whether a page or an ancestor carries its own access list (then fewer people see it than its space). */
  async isRestricted(organizationId: string, pageId: string): Promise<boolean> {
    const { data } = await this.client
      .from('wiki_pages')
      .select('path, has_custom_permissions')
      .eq('id', pageId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    const row = data as {
      path: string[] | null;
      has_custom_permissions: boolean;
    } | null;
    if (!row) return true;
    if (row.has_custom_permissions) return true;
    const path = row.path ?? [];
    if (!path.length) return false;
    const { data: up } = await this.client
      .from('wiki_pages')
      .select('id')
      .eq('organization_id', organizationId)
      .in('id', path)
      .eq('has_custom_permissions', true)
      .limit(1);
    return (up ?? []).length > 0;
  }
}
