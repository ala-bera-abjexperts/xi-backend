/**
 * @fileoverview Object cards for chat (XE-T353): resolves the task / wiki page refs a
 * message carries into what the CALLER may see. A ref the caller cannot open is
 * `restricted` and carries no title; one that no longer exists (or lives in another
 * tenant) is `deleted`. Other object types are `restricted` until they get a resolver.
 * @module src/chat/chat-refs.service
 */

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WikiPermissionsService } from '../wiki/wiki-permissions.service';
import type { ChatObjectRefDto } from './dto/chat.dto';

export interface ChatRefResult {
  type: string;
  id: string;
  status: 'ok' | 'restricted' | 'deleted';
  title?: string;
  key?: string;
  spaceKey?: string;
  spaceName?: string;
  url?: string;
  task?: {
    statusName: string | null;
    statusColor: string | null;
    priority: string | null;
    assigneeName: string | null;
    dueDate: string | null;
  };
}

type SpaceStub = { key: string; name: string } | null;

interface TaskRow {
  id: string;
  key: string;
  summary: string;
  priority: string | null;
  due_date: string | null;
  space_id: string;
  status_config: { name: string; color: string | null } | null;
  space: SpaceStub;
  assignee: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  } | null;
}

interface WikiRow {
  id: string;
  title: string;
  space_id: string;
  is_archived: boolean | null;
  space: SpaceStub;
}

@Injectable()
export class ChatRefsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
    private readonly wikiPermissions: WikiPermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async resolve(
    user: RequestUser,
    refs: ChatObjectRefDto[],
  ): Promise<{ results: ChatRefResult[] }> {
    const unique = [
      ...new Map(refs.map((ref) => [`${ref.type}:${ref.id}`, ref])).values(),
    ];
    const idsOf = (type: string) =>
      unique.filter((ref) => ref.type === type).map((ref) => ref.id);

    // One permission check per space, shared by every ref in it.
    const spaceChecks = new Map<string, Promise<boolean>>();
    const canView = (spaceId: string, permission: string) => {
      const cacheKey = `${spaceId}:${permission}`;
      let check = spaceChecks.get(cacheKey);
      if (!check) {
        check = this.permissions.hasSpacePermission(
          user.userId,
          user.organizationId,
          spaceId,
          permission,
        );
        spaceChecks.set(cacheKey, check);
      }
      return check;
    };

    const [tasks, pages] = await Promise.all([
      this.resolveTasks(user, idsOf('task'), canView),
      this.resolveWikiPages(user, idsOf('wiki_page'), canView),
    ]);
    const resolved = new Map(
      [...tasks, ...pages].map((r) => [`${r.type}:${r.id}`, r]),
    );

    return {
      results: unique.map(
        (ref) =>
          resolved.get(`${ref.type}:${ref.id}`) ?? {
            type: ref.type,
            id: ref.id,
            status: 'restricted',
          },
      ),
    };
  }

  private async resolveTasks(
    user: RequestUser,
    ids: string[],
    canView: (spaceId: string, permission: string) => Promise<boolean>,
  ): Promise<ChatRefResult[]> {
    if (ids.length === 0) return [];

    const { data, error } = await this.client
      .from('tasks')
      .select(
        'id, key, summary, priority, due_date, space_id, status_config:task_statuses!tasks_status_id_fkey(name, color), space:spaces!tasks_space_id_fkey(key, name), assignee:users!tasks_assigned_to_fkey(first_name, last_name, email)',
      )
      .eq('organization_id', user.organizationId)
      .in('id', ids);
    if (error) throw new InternalServerErrorException('Could not load tasks');

    const rows = new Map(
      ((data ?? []) as unknown as TaskRow[]).map((row) => [row.id, row]),
    );

    return Promise.all(
      ids.map(async (id): Promise<ChatRefResult> => {
        const row = rows.get(id);
        if (!row) return { type: 'task', id, status: 'deleted' };
        if (!(await canView(row.space_id, 'view_tasks'))) {
          return { type: 'task', id, status: 'restricted' };
        }

        const assignee = row.assignee
          ? `${row.assignee.first_name ?? ''} ${row.assignee.last_name ?? ''}`.trim() ||
            row.assignee.email
          : null;

        return {
          type: 'task',
          id,
          status: 'ok',
          title: row.summary,
          key: row.key,
          spaceKey: row.space?.key,
          spaceName: row.space?.name,
          url: row.space
            ? `/spaces/${row.space.key}/tasks/view/${row.key}`
            : undefined,
          task: {
            statusName: row.status_config?.name ?? null,
            statusColor: row.status_config?.color ?? null,
            priority: row.priority ?? null,
            assigneeName: assignee ?? null,
            dueDate: row.due_date ?? null,
          },
        };
      }),
    );
  }

  private async resolveWikiPages(
    user: RequestUser,
    ids: string[],
    canView: (spaceId: string, permission: string) => Promise<boolean>,
  ): Promise<ChatRefResult[]> {
    if (ids.length === 0) return [];

    const { data, error } = await this.client
      .from('wiki_pages')
      .select(
        'id, title, space_id, is_archived, space:spaces!wiki_pages_space_id_fkey(key, name)',
      )
      .eq('organization_id', user.organizationId)
      .in('id', ids);
    if (error)
      throw new InternalServerErrorException('Could not load wiki pages');

    const rows = new Map(
      ((data ?? []) as unknown as WikiRow[]).map((row) => [row.id, row]),
    );

    return Promise.all(
      ids.map(async (id): Promise<ChatRefResult> => {
        const row = rows.get(id);
        if (!row || row.is_archived) {
          return { type: 'wiki_page', id, status: 'deleted' };
        }
        if (!(await this.canViewPage(user, row, canView))) {
          return { type: 'wiki_page', id, status: 'restricted' };
        }

        return {
          type: 'wiki_page',
          id,
          status: 'ok',
          title: row.title,
          spaceKey: row.space?.key,
          spaceName: row.space?.name,
          url: row.space ? `/spaces/${row.space.key}/wiki/${id}` : undefined,
        };
      }),
    );
  }

  private async canViewPage(
    user: RequestUser,
    row: WikiRow,
    canView: (spaceId: string, permission: string) => Promise<boolean>,
  ): Promise<boolean> {
    if (!(await canView(row.space_id, 'view_wiki_pages'))) return false;

    try {
      await this.wikiPermissions.assertPageAccess(
        row.id,
        user.userId,
        row.space_id,
        'can_view',
      );
      return true;
    } catch {
      return false;
    }
  }
}
