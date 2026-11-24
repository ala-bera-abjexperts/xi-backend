/** Customer replies are a separate, explicitly published channel. */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { SlaAccessService } from './sla-access.service';
import { RequestUser } from '../auth/interfaces/request-user.interface';
import { parseTicketNumberSearch } from './sla-rule-options';
import { sanitizeRichText } from '../common/utils/sanitize-rich-text';

@Injectable()
export class SlaRepliesService {
  constructor(
    private readonly admin: SupabaseAdminService,
    private readonly access: SlaAccessService,
  ) {}
  private get db() {
    return this.admin.getClient();
  }
  private check(error: { code?: string } | null) {
    if (!error) return;
    if (['23505', '23514', 'P0001'].includes(error.code ?? ''))
      throw new ConflictException(
        'Request association or publication conflicts with an existing record',
      );
    throw new InternalServerErrorException('Unable to process customer reply');
  }
  async supportRequestOptions(user: RequestUser, taskId: string, search = '') {
    const task = await this.access.authorizeTask(
      user,
      taskId,
      'publish_customer_replies',
    );
    if (typeof search !== 'string' || search.length > 200)
      throw new BadRequestException('Invalid support request search');
    const literal = `%${search.trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    const ticketNumber = parseTicketNumberSearch(search);
    const columns = search.trim()
      ? ticketNumber === null
        ? ['subject']
        : ['ticket_number', 'subject']
      : ['ticket_number'];
    const pages = await Promise.all(
      columns.map(async (column) => {
        let query = this.db
          .from('support_requests')
          .select('id,ticket_number,subject')
          .eq('organization_id', task.organization_id)
          .eq('space_id', task.space_id)
          .is('task_id', null)
          .is('association_locked_at', null);
        if (search.trim())
          query =
            column === 'ticket_number'
              ? query.eq('ticket_number', ticketNumber)
              : query.ilike(column, literal);
        const { data, error } = await query
          .order('ticket_number')
          .order('id')
          .limit(51);
        this.check(error);
        return (data ?? []) as {
          id: string;
          ticket_number: number | string;
          subject: string;
        }[];
      }),
    );
    const matches = [
      ...new Map(pages.flat().map((row) => [row.id, row])).values(),
    ].sort((a, b) =>
      String(a.ticket_number).localeCompare(
        String(b.ticket_number),
        undefined,
        { numeric: true },
      ),
    );
    return {
      options: matches.slice(0, 50),
      hasMore: matches.length > 50 || pages.some((page) => page.length > 50),
    };
  }
  async linkedRequest(user: RequestUser, taskId: string) {
    const task = await this.access.authorizeTask(
      user,
      taskId,
      'publish_customer_replies',
    );
    const { data, error } = await this.db
      .from('support_requests')
      .select(
        'id,ticket_number,subject,created_by,organization_id,space_id,association_locked_at',
      )
      .eq('task_id', taskId)
      .eq('organization_id', task.organization_id)
      .maybeSingle();
    this.check(error);
    if (!data) return null;
    const { data: requester, error: userError } = await this.db
      .from('users')
      .select('id,first_name,last_name,email')
      .eq('id', data.created_by)
      .maybeSingle();
    this.check(userError);
    return { ...data, requester };
  }
  async link(user: RequestUser, taskId: string, requestId: string | null) {
    const task = await this.access.authorizeTask(
      user,
      taskId,
      'publish_customer_replies',
    );
    let id = requestId;
    if (!id) {
      const existing = await this.linkedRequest(user, taskId);
      if (!existing) return null;
      id = existing.id;
    }
    const { data, error } = await this.db.rpc('sla_link_request_task', {
      p_request_id: id,
      p_task_id: requestId ? taskId : null,
      p_organization_id: task.organization_id,
    });
    this.check(error);
    return data;
  }
  async publish(
    user: RequestUser,
    taskId: string,
    input: { content: string; idempotency_key: string; request_id: string },
  ) {
    const request = await this.linkedRequest(user, taskId);
    if (!request)
      throw new BadRequestException('Link a support request before publishing');
    if (request.id !== input.request_id)
      throw new ConflictException(
        'The linked requester changed. Reload before publishing.',
      );
    const content =
      sanitizeRichText(input.content, { allowTables: true })?.trim() ?? '';
    if (
      !content
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, '')
        .trim()
    )
      throw new BadRequestException(
        'A customer reply must contain readable text',
      );
    const { data, error } = await this.db.rpc('sla_publish_customer_reply', {
      p_request_id: request.id,
      p_task_id: taskId,
      p_organization_id: request.organization_id,
      p_actor_id: user.userId,
      p_idempotency_key: input.idempotency_key,
      p_content: content,
    });
    this.check(error);
    return data;
  }
  /**
   * Staff-published replies (immutable) and the customer's portal comments, oldest first.
   * Comments also carry their task and last editor so the Customer tab can offer edit/delete.
   */
  async thread(user: RequestUser, taskId: string) {
    const request = await this.linkedRequest(user, taskId);
    if (!request) return [];
    const [replies, comments] = await Promise.all([
      this.db
        .from('support_customer_replies')
        .select('id,content,published_at,author_id')
        .eq('request_id', request.id)
        .eq('organization_id', request.organization_id),
      this.db
        .from('task_comments')
        .select('id,task_id,content,created_at,updated_at,created_by,edited_by')
        .eq('support_request_id', request.id)
        .eq('organization_id', request.organization_id),
    ]);
    this.check(replies.error);
    this.check(comments.error);
    const items = [
      ...(
        (replies.data ?? []) as {
          id: string;
          content: string;
          published_at: string;
          author_id: string;
        }[]
      ).map((r) => ({
        id: r.id,
        kind: 'reply' as const,
        content: r.content,
        created_at: r.published_at,
        updated_at: r.published_at,
        authorId: r.author_id,
      })),
      ...(
        (comments.data ?? []) as {
          id: string;
          task_id: string;
          content: string;
          created_at: string;
          updated_at: string | null;
          created_by: string | null;
          edited_by: string | null;
        }[]
      ).map((c) => ({
        id: c.id,
        kind: 'comment' as const,
        task_id: c.task_id,
        content: c.content,
        created_at: c.created_at,
        updated_at: c.updated_at ?? c.created_at,
        edited_by: c.edited_by,
        authorId: c.created_by,
      })),
    ];
    // support_customer_replies.author_id has no FK to users, so it cannot be embedded.
    const ids = [
      ...new Set(
        items
          .flatMap((i) => [i.authorId, 'edited_by' in i ? i.edited_by : null])
          .filter(Boolean),
      ),
    ] as string[];
    const authors = new Map<
      string,
      {
        id: string;
        first_name: string | null;
        last_name: string | null;
        avatar_url: string | null;
      }
    >();
    if (ids.length) {
      const { data, error } = await this.db
        .from('users')
        .select('id,first_name,last_name,avatar_url')
        .in('id', ids);
      this.check(error);
      for (const u of (data ?? []) as {
        id: string;
        first_name: string | null;
        last_name: string | null;
        avatar_url: string | null;
      }[])
        authors.set(u.id, u);
    }
    const editorOf = (id: string | null) => {
      const u = id ? authors.get(id) : undefined;
      return u
        ? { id: u.id, first_name: u.first_name, last_name: u.last_name }
        : null;
    };
    return items
      .map(({ authorId, ...item }) => ({
        ...item,
        author: (authorId && authors.get(authorId)) || null,
        ...('edited_by' in item && { editor: editorOf(item.edited_by) }),
      }))
      .sort(
        (a, b) =>
          Date.parse(a.created_at) - Date.parse(b.created_at) ||
          (a.kind === b.kind ? 0 : a.kind === 'reply' ? -1 : 1),
      );
  }
  async requesterReplies(requestId: string, userId: string) {
    const { data: request, error: requestError } = await this.db
      .from('support_requests')
      .select('id')
      .eq('id', requestId)
      .eq('created_by', userId)
      .maybeSingle();
    this.check(requestError);
    if (!request) throw new NotFoundException('Support request not found');
    const { data, error } = await this.db
      .from('support_customer_replies')
      .select('id,content,published_at')
      .eq('request_id', requestId)
      .eq('requester_id', userId)
      .order('published_at', { ascending: true });
    this.check(error);
    return data ?? [];
  }
}
