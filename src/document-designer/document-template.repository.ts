/**
 * @fileoverview Data access for `document_templates`. Service-role client
 * bypasses RLS, so EVERY query is org-scoped in code — no exceptions.
 * @module src/document-designer/document-template.repository
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { IDocumentTemplate } from './template-definition/template-definition.types';

export interface DocumentTemplateListFilters {
  search?: string;
  source_entity?: string;
  include_archived?: boolean;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class DocumentTemplateRepository {
  private static readonly TABLE = 'document_templates';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async findById(
    organizationId: string,
    id: string,
  ): Promise<IDocumentTemplate | null> {
    const { data, error } = (await this.client
      .from(DocumentTemplateRepository.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle()) as {
      data: IDocumentTemplate | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data ?? null;
  }

  async findByOrganization(
    organizationId: string,
    filters: DocumentTemplateListFilters,
  ): Promise<{ data: IDocumentTemplate[]; totalCount: number }> {
    // Templates are lightweight rows and the pickers (export dialog,
    // automation config) need the full catalog — default high, cap at 200.
    const page = Math.max(filters.page ?? 1, 1);
    const pageSize = Math.min(Math.max(filters.pageSize ?? 100, 1), 200);
    const from = (page - 1) * pageSize;

    let countQuery = this.client
      .from(DocumentTemplateRepository.TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId);

    let dataQuery = this.client
      .from(DocumentTemplateRepository.TABLE)
      .select('*')
      .eq('organization_id', organizationId);

    if (!filters.include_archived) {
      countQuery = countQuery.eq('is_archived', false);
      dataQuery = dataQuery.eq('is_archived', false);
    }
    if (filters.source_entity) {
      countQuery = countQuery.eq('source_entity', filters.source_entity);
      dataQuery = dataQuery.eq('source_entity', filters.source_entity);
    }
    if (filters.search) {
      const safe = filters.search.replace(/[,.()"'\\]/g, '');
      if (safe.length > 0) {
        countQuery = countQuery.ilike('name', `%${safe}%`);
        dataQuery = dataQuery.ilike('name', `%${safe}%`);
      }
    }

    const countResult = await countQuery;
    if (countResult.error)
      throw new BadRequestException(countResult.error.message);

    const { data, error } = await dataQuery
      .order('updated_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw new BadRequestException(error.message);

    return {
      data: (data ?? []) as IDocumentTemplate[],
      totalCount: countResult.count ?? 0,
    };
  }

  async create(input: Record<string, unknown>): Promise<IDocumentTemplate> {
    const { data, error } = (await this.client
      .from(DocumentTemplateRepository.TABLE)
      .insert(input)
      .select()
      .single()) as {
      data: IDocumentTemplate | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data as IDocumentTemplate;
  }

  async update(
    organizationId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<IDocumentTemplate | null> {
    const { data, error } = (await this.client
      .from(DocumentTemplateRepository.TABLE)
      .update(patch)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .select()
      .maybeSingle()) as {
      data: IDocumentTemplate | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data ?? null;
  }

  async delete(organizationId: string, id: string): Promise<void> {
    const { error } = await this.client
      .from(DocumentTemplateRepository.TABLE)
      .delete()
      .eq('organization_id', organizationId)
      .eq('id', id);

    if (error) throw new BadRequestException(error.message);
  }

  /**
   * Copy an existing template's payload into a new row within the same
   * organization. Returns null when the source row does not exist (or belongs
   * to another organization).
   */
  async duplicate(
    organizationId: string,
    id: string,
    name: string,
    userId: string,
  ): Promise<IDocumentTemplate | null> {
    const source = await this.findById(organizationId, id);
    if (!source) return null;

    return this.create({
      organization_id: organizationId,
      name,
      description: source.description,
      source_entity: source.source_entity,
      mode: source.mode,
      definition: source.definition,
      is_archived: false,
      created_by: userId,
      updated_by: userId,
    });
  }
}
