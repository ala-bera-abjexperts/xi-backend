import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { ListContactsDto } from './dto/list-contacts.dto';

export interface SiteStudioContact {
  id: string;
  organization_id: string;
  funnel_id: string;
  source_page_id: string | null;
  email: string | null;
  form_data: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  is_test_submission: boolean | null;
  created_at: string;
  updated_at: string;
}

export interface ContactListResult {
  data: SiteStudioContact[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNextPage: boolean;
}

@Injectable()
export class ContactsService {
  static readonly CONTACTS_TABLE = 'site_studio_contacts';
  static readonly FUNNELS_TABLE = 'site_studio_funnels';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async assertFunnelBelongsToOrg(
    funnelId: string,
    organizationId: string,
  ): Promise<void> {
    const { data } = await this.client
      .from(ContactsService.FUNNELS_TABLE)
      .select('id')
      .eq('id', funnelId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!data) throw new NotFoundException('Funnel not found');
  }

  async getContacts(
    funnelId: string,
    organizationId: string,
    dto: ListContactsDto,
  ): Promise<ContactListResult> {
    await this.assertFunnelBelongsToOrg(funnelId, organizationId);

    const page = dto.page ?? 1;
    const pageSize = dto.pageSize ?? 20;
    const offset = (page - 1) * pageSize;

    const escaped = dto.search
      ? dto.search.replace(/%/g, '\\%').replace(/_/g, '\\_')
      : undefined;

    // Count query
    let countQ = this.client
      .from(ContactsService.CONTACTS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId);

    if (escaped) countQ = countQ.ilike('email', `%${escaped}%`);

    const { count: totalCount, error: countErr } = await countQ;

    if (countErr) throw new BadRequestException(countErr.message);

    // Data query
    let dataQ = this.client
      .from(ContactsService.CONTACTS_TABLE)
      .select('*')
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (escaped) dataQ = dataQ.ilike('email', `%${escaped}%`);

    const { data, error } = await dataQ;

    if (error) throw new BadRequestException(error.message);

    const total = totalCount ?? 0;
    const totalPages = Math.ceil(total / pageSize);

    return {
      data: (data ?? []) as unknown as SiteStudioContact[],
      totalCount: total,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
    };
  }

  async deleteContact(
    contactId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    // Verify existence first
    const { data } = await this.client
      .from(ContactsService.CONTACTS_TABLE)
      .select('id, funnel_id, email')
      .eq('id', contactId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!data) throw new NotFoundException('Contact not found');

    const { error } = await this.client
      .from(ContactsService.CONTACTS_TABLE)
      .delete()
      .eq('id', contactId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'site_studio_contact',
      contactId,
      'delete',
      {
        funnel_id: (data as Record<string, unknown>)['funnel_id'],
        email: (data as Record<string, unknown>)['email'] ?? null,
      },
    );
  }

  async exportContactsCsv(
    funnelId: string,
    organizationId: string,
  ): Promise<string> {
    await this.assertFunnelBelongsToOrg(funnelId, organizationId);

    // Fetch form fields for column headers
    const { data: formFields } = await this.client
      .from('site_studio_form_fields')
      .select('field_name, label, sort_order')
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true });

    const { data: contacts, error } = await this.client
      .from(ContactsService.CONTACTS_TABLE)
      .select('*')
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    const fields = (formFields ?? []) as Array<{
      field_name: string;
      label: string;
    }>;

    const escapeCell = (value: unknown): string => {
      const str =
        value === null || value === undefined
          ? ''
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value as string | number | boolean);

      if (str.includes('"') || str.includes(',') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }

      return str;
    };

    const headerRow = ['Email', 'Submitted At', ...fields.map((f) => f.label)]
      .map(escapeCell)
      .join(',');

    const rows = (contacts ?? []).map((contact: unknown) => {
      const c = contact as SiteStudioContact;

      const cells = [
        c.email ?? '',
        c.created_at ?? '',
        ...fields.map((f) => (c.form_data?.[f.field_name] ?? '') as unknown),
      ];

      return cells.map(escapeCell).join(',');
    });

    return [headerRow, ...rows].join('\n');
  }
}
