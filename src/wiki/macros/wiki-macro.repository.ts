import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';

export interface MacroSpace {
  id: string;
  organization_id: string;
  name: string;
  key: string;
  description: string | null;
  icon: string | null;
  icon_url: string | null;
}

export interface MacroSpaceMember {
  id: string;
  member_type: string;
  user_id: string | null;
  space_role: string | null;
  user:
    | {
        id?: string;
        first_name?: string | null;
        last_name?: string | null;
        avatar_url?: string | null;
      }
    | Array<{
        id?: string;
        first_name?: string | null;
        last_name?: string | null;
        avatar_url?: string | null;
      }>
    | null;
}

export interface MacroDecisionPage {
  id: string;
  title: string;
  content: string | Record<string, unknown>;
}

/** Narrow reads kept here to avoid a WikiModule -> SpacesModule -> TasksModule cycle. */
@Injectable()
export class WikiMacroRepository {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  async getBlogAuthorNames(userIds: string[]): Promise<Record<string, string>> {
    const names: Record<string, string> = {};
    const unique = [...new Set(userIds)];
    for (let offset = 0; offset < unique.length; offset += 100) {
      const result = await this.supabaseAdmin.getClient().from('users').select('id,first_name,last_name').in('id', unique.slice(offset, offset + 100));
      if (result.error) throw new BadRequestException('Could not load blog authors');
      for (const user of result.data ?? []) names[user.id] = [user.first_name, user.last_name].filter(Boolean).join(' ');
    }
    return names;
  }

  async getBlogSpaces(organizationId: string, userId: string): Promise<Array<{ id: string; key: string; name: string; starred: boolean }>> {
    const client = this.supabaseAdmin.getClient();
    const stars = await client.from('starred_spaces').select('space_id').eq('user_id', userId);
    if (stars.error) throw new BadRequestException('Could not load starred spaces');
    const starred = new Set((stars.data ?? []).map(row => row.space_id));
    const rows: Array<{ id: string; key: string; name: string; starred: boolean }> = [];
    for (let offset = 0; ; offset += 500) {
      const result = await client.from('spaces').select('id,key,name').eq('organization_id', organizationId).order('id').range(offset, offset + 499);
      if (result.error) throw new BadRequestException('Could not load blog spaces');
      rows.push(...(result.data ?? []).map(space => ({ ...space, starred: starred.has(space.id) })));
      if ((result.data?.length ?? 0) < 500) return rows;
    }
  }

  async getSpace(spaceId: string, organizationId: string): Promise<MacroSpace> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('spaces')
      .select('id,organization_id,name,key,description,icon,icon_url')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Space not found');
    return data as MacroSpace;
  }

  async getSpaceMembers(
    spaceId: string,
    limit: number,
    offset: number,
  ): Promise<{ data: MacroSpaceMember[]; total: number; hasMore: boolean }> {
    const capped = Math.min(Math.max(Math.trunc(limit) || 100, 1), 100);
    const safeOffset = Math.max(Math.trunc(offset) || 0, 0);
    const { data, error, count } = await this.supabaseAdmin
      .getClient()
      .from('space_members')
      .select(
        'id,member_type,user_id,space_role,user:user_id(id,first_name,last_name,avatar_url)',
        { count: 'exact' },
      )
      .eq('space_id', spaceId)
      .eq('is_active', true)
      .not('user_id', 'is', null)
      .order('created_at', { ascending: true })
      .range(safeOffset, safeOffset + capped - 1);

    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as unknown as MacroSpaceMember[];
    const total = count ?? rows.length;
    return {
      data: rows,
      total,
      hasMore: safeOffset + rows.length < total,
    };
  }

  async getSpaceMemberByUserId(
    spaceId: string,
    userId: string,
    orgId: string,
  ): Promise<MacroSpaceMember | null> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('space_members')
      .select(
        'id,member_type,user_id,space_role,user:user_id!inner(id,first_name,last_name,avatar_url,organization_members!inner(organization_id))',
      )
      .eq('space_id', spaceId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .eq('user.is_active', true)
      .eq('user.organization_members.organization_id', orgId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    return data as unknown as MacroSpaceMember | null;
  }

  async getDecisionPages(
    pageIds: string[],
    limit: number,
  ): Promise<MacroDecisionPage[]> {
    if (!pageIds.length) return [];
    const capped = Math.min(Math.max(Math.trunc(limit) || 100, 1), 100);
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('wiki_pages')
      .select('id,title,content')
      .in('id', pageIds.slice(0, 500))
      .ilike('content', '%"type":"decisionItem"%')
      .limit(capped);

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as unknown as MacroDecisionPage[];
  }
}
