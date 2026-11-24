import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { SaveFormFieldsDto } from './dto/save-form-fields.dto';

export interface SiteStudioFormField {
  id: string;
  organization_id: string;
  funnel_id: string;
  element_id: string;
  field_name: string;
  field_type: string;
  label: string;
  placeholder: string | null;
  required: boolean;
  options: Array<{ label: string; value: string }>;
  validation_rules: Record<string, unknown> | null;
  sort_order: number;
}

@Injectable()
export class FormFieldsService {
  static readonly TABLE = 'site_studio_form_fields';
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
      .from(FormFieldsService.FUNNELS_TABLE)
      .select('id')
      .eq('id', funnelId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!data) throw new NotFoundException('Funnel not found');
  }

  async getFormFields(
    funnelId: string,
    organizationId: string,
  ): Promise<SiteStudioFormField[]> {
    await this.assertFunnelBelongsToOrg(funnelId, organizationId);

    const { data, error } = await this.client
      .from(FormFieldsService.TABLE)
      .select('*')
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    return (data ?? []) as unknown as SiteStudioFormField[];
  }

  async saveFormFields(
    funnelId: string,
    organizationId: string,
    userId: string,
    dto: SaveFormFieldsDto,
  ): Promise<SiteStudioFormField[]> {
    await this.assertFunnelBelongsToOrg(funnelId, organizationId);

    // Atomic replace via RPC
    const { error } = await this.client.rpc('replace_site_studio_form_fields', {
      p_funnel_id: funnelId,
      p_org_id: organizationId,
      p_fields: dto.fields,
    });

    if (error) throw new BadRequestException(error.message);

    // Return the freshly-saved fields
    const { data, error: fetchErr } = await this.client
      .from(FormFieldsService.TABLE)
      .select('*')
      .eq('funnel_id', funnelId)
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true });

    if (fetchErr) throw new BadRequestException(fetchErr.message);

    void this.auditLogsService.logAction(
      organizationId,
      userId,
      'site_studio_form_fields',
      funnelId,
      'update',
      {
        funnel_id: funnelId,
        fields_count: dto.fields.length,
      },
    );

    return (data ?? []) as unknown as SiteStudioFormField[];
  }
}
