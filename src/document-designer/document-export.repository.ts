/**
 * @fileoverview Data access for `document_exports` (export history rows).
 * Used by Wave 2's export worker; complete now so the schema contract is
 * exercised. Service-role client bypasses RLS — every query org-scoped.
 * @module src/document-designer/document-export.repository
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type {
  DocumentExportSource,
  DocumentExportStatus,
  IDocumentExport,
} from './template-definition/template-definition.types';

export interface DocumentExportListFilters {
  template_id?: string;
  status?: DocumentExportStatus;
  source?: DocumentExportSource;
  /** Restrict rows to this requester (non-manager callers see only their own). */
  requested_by?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class DocumentExportRepository {
  private static readonly TABLE = 'document_exports';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async insert(
    organizationId: string,
    input: Record<string, unknown>,
  ): Promise<IDocumentExport> {
    const { data, error } = (await this.client
      .from(DocumentExportRepository.TABLE)
      .insert({ ...input, organization_id: organizationId })
      .select()
      .single()) as {
      data: IDocumentExport | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data as IDocumentExport;
  }

  async update(
    organizationId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<IDocumentExport | null> {
    const { data, error } = (await this.client
      .from(DocumentExportRepository.TABLE)
      .update(patch)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .select()
      .maybeSingle()) as {
      data: IDocumentExport | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data ?? null;
  }

  async findById(
    organizationId: string,
    id: string,
    requestedBy?: string,
  ): Promise<IDocumentExport | null> {
    let query = this.client
      .from(DocumentExportRepository.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('id', id);

    if (requestedBy) query = query.eq('requested_by', requestedBy);

    const { data, error } = (await query.maybeSingle()) as {
      data: IDocumentExport | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data ?? null;
  }

  async list(
    organizationId: string,
    filters: DocumentExportListFilters,
  ): Promise<{ data: IDocumentExport[]; totalCount: number }> {
    const page = filters.page ?? 1;
    const pageSize = Math.min(filters.pageSize ?? 20, 100);
    const from = (page - 1) * pageSize;

    let countQuery = this.client
      .from(DocumentExportRepository.TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId);

    let dataQuery = this.client
      .from(DocumentExportRepository.TABLE)
      .select('*')
      .eq('organization_id', organizationId);

    if (filters.template_id) {
      countQuery = countQuery.eq('template_id', filters.template_id);
      dataQuery = dataQuery.eq('template_id', filters.template_id);
    }
    if (filters.status) {
      countQuery = countQuery.eq('status', filters.status);
      dataQuery = dataQuery.eq('status', filters.status);
    }
    if (filters.source) {
      countQuery = countQuery.eq('source', filters.source);
      dataQuery = dataQuery.eq('source', filters.source);
    }
    if (filters.requested_by) {
      countQuery = countQuery.eq('requested_by', filters.requested_by);
      dataQuery = dataQuery.eq('requested_by', filters.requested_by);
    }

    const countResult = await countQuery;
    if (countResult.error)
      throw new BadRequestException(countResult.error.message);

    const { data, error } = await dataQuery
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw new BadRequestException(error.message);

    return {
      data: (data ?? []) as IDocumentExport[],
      totalCount: countResult.count ?? 0,
    };
  }
}
