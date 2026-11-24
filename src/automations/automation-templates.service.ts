import {
  Injectable,
  Logger,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  AUTOMATION_TEMPLATES,
  AutomationTemplate,
} from './automation-templates.constants';

@Injectable()
export class AutomationTemplatesService {
  private readonly logger = new Logger(AutomationTemplatesService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async getTemplates(spaceId: string): Promise<AutomationTemplate[]> {
    const { data, error } = await this.db
      .from('automation_templates')
      .select('*')
      .eq('space_id', spaceId)
      .order('created_at', { ascending: true });

    if (error) {
      this.logger.warn(
        `Failed to load custom templates for space ${spaceId}: ${error.message}`,
      );
    }

    const customTemplates = (data ?? []) as AutomationTemplate[];

    // Custom templates take precedence over system templates with the same ID
    const systemFiltered = AUTOMATION_TEMPLATES.filter(
      (t) => !customTemplates.some((c) => c.id === t.id),
    );

    return [...systemFiltered, ...customTemplates];
  }

  async getMarketplaceTemplates(
    spaceId: string,
  ): Promise<AutomationTemplate[]> {
    const { data, error } = await this.db
      .from('automation_templates')
      .select('*')
      .eq('is_public', true)
      .neq('space_id', spaceId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.warn(
        `Failed to load marketplace templates: ${error.message}`,
      );
    }

    return (data ?? []) as AutomationTemplate[];
  }

  async create(input: {
    space_id: string;
    name: string;
    description: string;
    category: string;
    tags: string[];
    icon: string;
    svg_icon?: string | null;
    color?: string | null;
    trigger_kind: string;
    trigger_config: Record<string, unknown>;
    definition: { nodes: unknown[]; edges: unknown[] };
    is_public: boolean;
    created_by: string;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.db
      .from('automation_templates')
      .insert(input)
      .select('*')
      .single();

    if (error || !data) {
      throw new InternalServerErrorException(
        `Failed to create template: ${error?.message}`,
      );
    }

    return data as Record<string, unknown>;
  }

  async getById(
    templateId: string,
    spaceId: string,
  ): Promise<Record<string, unknown> | null> {
    const { data } = await this.db
      .from('automation_templates')
      .select('*')
      .eq('id', templateId)
      .eq('space_id', spaceId)
      .single();

    // .single() with no match → { data: null, error: { code: 'PGRST116' } }
    return data ?? null;
  }

  async update(
    templateId: string,
    spaceId: string,
    input: Partial<{
      name: string;
      description: string;
      category: string;
      tags: string[];
      icon: string;
      svg_icon: string | null;
      color: string | null;
      is_public: boolean;
      definition: { nodes: unknown[]; edges: unknown[] };
    }>,
  ): Promise<Record<string, unknown>> {
    const { data, error } = await this.db
      .from('automation_templates')
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq('id', templateId)
      .eq('space_id', spaceId)
      .select('*')
      .single();

    // Distinguish PGRST116 (no row → 404) from CHECK constraint / other DB errors (→ 500).
    // if (error || !data) alone would throw 404 for constraint violations — wrong behavior.
    if (error?.code === 'PGRST116' || !data) {
      throw new NotFoundException('Template not found or not accessible');
    }
    if (error) {
      throw new InternalServerErrorException(
        `Failed to update template: ${error.message}`,
      );
    }

    return data as Record<string, unknown>;
  }

  async delete(templateId: string, spaceId: string): Promise<void> {
    const { error } = await this.db
      .from('automation_templates')
      .delete()
      .eq('id', templateId)
      .eq('space_id', spaceId);

    if (error) {
      throw new InternalServerErrorException(
        `Failed to delete template: ${error.message}`,
      );
    }
    // Supabase DELETE on a missing row returns { error: null } — no error thrown.
    // 404 enforcement is done by the controller calling getById() before this method.
  }
}
