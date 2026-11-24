/**
 * @fileoverview Wiki labels service — space-scoped label CRUD and
 * page-label assignment (set/get/bulk).
 * @module src/wiki/wiki-labels.service
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { CreateWikiLabelDto } from './dto/create-wiki-label.dto';
import type { UpdateWikiLabelDto } from './dto/update-wiki-label.dto';
import type { ReorderItemsDto } from './dto/reorder-items.dto';
import type { SetPageLabelsDto } from './dto/set-page-labels.dto';

@Injectable()
export class WikiLabelsService {
  private static readonly LABELS = 'wiki_labels';
  private static readonly PAGE_LABELS = 'wiki_page_labels';
  private static readonly PAGES = 'wiki_pages';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ---- Space labels -------------------------------------------------------

  async getLabels(spaceId: string): Promise<unknown[]> {
    const { data, error } = await this.client
      .from(WikiLabelsService.LABELS)
      .select('*')
      .eq('space_id', spaceId)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) {
      throw new BadRequestException(error.message);
    }
    return (data ?? []) as unknown[];
  }

  async createLabel(
    spaceId: string,
    dto: CreateWikiLabelDto,
  ): Promise<unknown> {
    const r = await this.client
      .from(WikiLabelsService.LABELS)
      .insert({ ...dto, space_id: spaceId })
      .select('*')
      .single();
    if (r.error) {
      throw new BadRequestException(r.error.message);
    }
    return r.data as unknown;
  }

  async updateLabel(
    labelId: string,
    spaceId: string,
    dto: UpdateWikiLabelDto,
  ): Promise<unknown> {
    const r = await this.client
      .from(WikiLabelsService.LABELS)
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', labelId)
      .eq('space_id', spaceId)
      .select('*')
      .single();
    if (r.error) {
      throw new BadRequestException(r.error.message);
    }
    if (!r.data) {
      throw new NotFoundException(`Label ${labelId} not found`);
    }
    return r.data as unknown;
  }

  async deleteLabel(labelId: string, spaceId: string): Promise<void> {
    const { error } = await this.client
      .from(WikiLabelsService.LABELS)
      .delete()
      .eq('id', labelId)
      .eq('space_id', spaceId);
    if (error) {
      throw new BadRequestException(error.message);
    }
  }

  async reorderLabels(spaceId: string, dto: ReorderItemsDto): Promise<void> {
    const results = await Promise.all(
      dto.updates.map((u) =>
        this.client
          .from(WikiLabelsService.LABELS)
          .update({ sort_order: u.sort_order })
          .eq('id', u.id)
          .eq('space_id', spaceId),
      ),
    );
    const failed = results.filter((r) => r.error);
    if (failed.length) {
      throw new BadRequestException(
        `Failed to reorder ${failed.length} label(s)`,
      );
    }
  }

  // ---- Page labels --------------------------------------------------------

  async getPageLabels(pageId: string): Promise<unknown[]> {
    const { data, error } = await this.client
      .from(WikiLabelsService.PAGE_LABELS)
      .select(
        `
        id,
        label_id,
        wiki_labels (
          id, name, color, description, sort_order
        )
      `,
      )
      .eq('page_id', pageId);
    if (error) {
      throw new BadRequestException(error.message);
    }
    return (data ?? []).map((row: Record<string, unknown>) => ({
      id: row['id'],
      label_id: row['label_id'],
      label: row['wiki_labels'],
    }));
  }

  async getBulkPageLabels(
    pageIds: string[],
  ): Promise<Record<string, unknown[]>> {
    if (!pageIds.length) return {};
    const { data, error } = await this.client
      .from(WikiLabelsService.PAGE_LABELS)
      .select(
        `
        page_id,
        label_id,
        assigned_at,
        wiki_labels (id, name, color)
      `,
      )
      .in('page_id', pageIds);
    if (error) {
      throw new BadRequestException(error.message);
    }
    const result: Record<string, unknown[]> = {};
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const pid = row['page_id'] as string;
      if (!result[pid]) result[pid] = [];
      result[pid].push({
        label_id: row['label_id'],
        assigned_at: row['assigned_at'],
        label: row['wiki_labels'],
      });
    }
    return result;
  }

  async getPageLabelAssignmentsForSpace(spaceId: string): Promise<unknown[]> {
    const { data: pages, error: pagesError } = await this.client
      .from(WikiLabelsService.PAGES)
      .select('id')
      .eq('space_id', spaceId)
      .eq('is_archived', false);
    if (pagesError) {
      throw new BadRequestException(pagesError.message);
    }

    const pageIds = ((pages ?? []) as { id: string }[]).map((p) => p.id);
    if (pageIds.length === 0) return [];

    // Batch into chunks of 100 to avoid URI-too-long when spaces have 1000+ pages
    const BATCH_SIZE = 100;
    const batches: any[] = [];

    for (let i = 0; i < pageIds.length; i += BATCH_SIZE) {
      batches.push(
        this.client
          .from(WikiLabelsService.PAGE_LABELS)
          .select('*, label:wiki_labels(*)')
          .in('page_id', pageIds.slice(i, i + BATCH_SIZE)),
      );
    }

    const results = await Promise.all(batches);
    const allData: unknown[] = [];

    for (const { data: batchData, error: batchError } of results) {
      if (batchError) {
        throw new BadRequestException(
          (batchError as { message: string }).message,
        );
      }

      if (batchData) allData.push(...(batchData as unknown[]));
    }

    return allData;
  }

  async setPageLabels(
    pageId: string,
    spaceId: string,
    dto: SetPageLabelsDto,
  ): Promise<unknown[]> {
    // Verify page belongs to space
    const { data: page } = await this.client
      .from(WikiLabelsService.PAGES)
      .select('id')
      .eq('id', pageId)
      .eq('space_id', spaceId)
      .single();
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    // Validate label IDs belong to space
    if (dto.label_ids.length > 0) {
      const { data: labels } = await this.client
        .from(WikiLabelsService.LABELS)
        .select('id')
        .eq('space_id', spaceId)
        .in('id', dto.label_ids);
      const found = new Set(
        ((labels ?? []) as Record<string, unknown>[]).map(
          (l) => l['id'] as string,
        ),
      );
      const missing = dto.label_ids.filter((id) => !found.has(id));
      if (missing.length) {
        throw new BadRequestException(
          `Labels not found in this space: ${missing.join(', ')}`,
        );
      }
    }

    // Replace all labels: delete existing then insert new
    const { error: delErr } = await this.client
      .from(WikiLabelsService.PAGE_LABELS)
      .delete()
      .eq('page_id', pageId);
    if (delErr) {
      throw new BadRequestException(delErr.message);
    }

    if (!dto.label_ids.length) return [];

    const rows = dto.label_ids.map((label_id) => ({
      page_id: pageId,
      label_id,
    }));
    const { data, error } = await this.client
      .from(WikiLabelsService.PAGE_LABELS)
      .insert(rows).select(`
        id,
        label_id,
        wiki_labels (id, name, color, description, sort_order)
      `);
    if (error) {
      throw new BadRequestException(error.message);
    }
    return (data ?? []).map((row: Record<string, unknown>) => ({
      id: row['id'],
      label_id: row['label_id'],
      label: row['wiki_labels'],
    }));
  }
}
