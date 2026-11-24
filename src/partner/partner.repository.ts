/* eslint-disable @typescript-eslint/no-unsafe-assignment -- generic, dynamically-typed Supabase data layer (admin client is SupabaseClient<any,any>) */
/**
 * @fileoverview Shared, generic data-access layer for all Partner Portal tables.
 * Uses the service-role client (bypasses RLS), so EVERY caller MUST scope by the
 * partner's organization_id in code - the global guard only confirms the org is a
 * partner, not which rows it may touch.
 * @module src/partner/partner.repository
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

export interface ListOptions {
  page?: number;
  pageSize?: number;
  /** Equality filters applied to both the count and data queries. */
  filters?: Record<string, unknown>;
  /** Case-insensitive contains search on a single column. */
  search?: { column: string; term: string };
  orderBy?: Array<{ column: string; ascending?: boolean }>;
  select?: string;
}

@Injectable()
export class PartnerRepository {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  /** Raw service-role client for the rare query the generic helpers can't express. */
  get client(): SupabaseClient<any, any> {
    return this.supabaseAdmin.getClient();
  }

  private fail(
    error: { message?: string; code?: string } | null,
    fallback: string,
  ): void {
    if (!error) {
      return;
    }
    // Map unique-constraint violations to 409 instead of a raw 500.
    if (error.code === '23505') {
      throw new ConflictException(
        error.message ?? 'A conflicting record already exists',
      );
    }

    throw new BadRequestException(error.message ?? fallback);
  }

  async insert<T = any>(
    table: string,
    input: Record<string, unknown>,
  ): Promise<T> {
    const { data, error } = await this.client
      .from(table)
      .insert(input)
      .select()
      .single();

    this.fail(error, `Failed to insert into ${table}`);

    return data as T;
  }

  async insertMany<T = any>(
    table: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<T[]> {
    if (rows.length === 0) {
      return [];
    }

    const { data, error } = await this.client.from(table).insert(rows).select();

    this.fail(error, `Failed to insert into ${table}`);

    return (data ?? []) as T[];
  }

  async updateById<T = any>(
    table: string,
    id: string,
    patch: Record<string, unknown>,
    organizationId?: string,
  ): Promise<T> {
    let query = this.client.from(table).update(patch).eq('id', id);
    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { data, error } = await query.select().maybeSingle();

    this.fail(error, `Failed to update ${table}`);
    if (!data) {
      throw new BadRequestException(`${table} row not found`);
    }

    return data as T;
  }

  async findById<T = any>(
    table: string,
    id: string,
    organizationId?: string,
  ): Promise<T | null> {
    let query = this.client.from(table).select('*').eq('id', id);
    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { data, error } = await query.maybeSingle();

    this.fail(error, `Failed to load ${table}`);

    return (data as T | null) ?? null;
  }

  async findOne<T = any>(
    table: string,
    filters: Record<string, unknown>,
    select = '*',
  ): Promise<T | null> {
    let query = this.client.from(table).select(select);
    for (const [key, value] of Object.entries(filters)) {
      query = query.eq(key, value);
    }

    const { data, error } = await query.maybeSingle();

    this.fail(error, `Failed to load ${table}`);

    return (data as T | null) ?? null;
  }

  async list<T = any>(
    table: string,
    opts: ListOptions,
  ): Promise<{ data: T[]; totalCount: number }> {
    const page = opts.page ?? 1;
    const pageSize = Math.min(opts.pageSize ?? 20, 100);
    const from = (page - 1) * pageSize;

    let countQuery = this.client
      .from(table)
      .select('id', { count: 'exact', head: true });
    let dataQuery = this.client.from(table).select(opts.select ?? '*');

    for (const [key, value] of Object.entries(opts.filters ?? {})) {
      countQuery = countQuery.eq(key, value);
      dataQuery = dataQuery.eq(key, value);
    }

    if (opts.search?.term) {
      const safe = opts.search.term.replace(/[,.()"'\\%]/g, '');
      if (safe.length > 0) {
        countQuery = countQuery.ilike(opts.search.column, `%${safe}%`);
        dataQuery = dataQuery.ilike(opts.search.column, `%${safe}%`);
      }
    }

    const countResult = await countQuery;
    this.fail(countResult.error, `Failed to count ${table}`);

    const orderBy = opts.orderBy ?? [
      { column: 'created_at', ascending: false },
    ];
    for (const order of orderBy) {
      dataQuery = dataQuery.order(order.column, {
        ascending: order.ascending ?? false,
      });
    }

    const { data, error } = await dataQuery.range(from, from + pageSize - 1);
    this.fail(error, `Failed to list ${table}`);

    return {
      data: (data ?? []) as T[],
      totalCount: countResult.count ?? 0,
    };
  }

  async findMany<T = any>(
    table: string,
    filters: Record<string, unknown>,
    select = '*',
  ): Promise<T[]> {
    let query = this.client.from(table).select(select);
    for (const [key, value] of Object.entries(filters)) {
      query = query.eq(key, value);
    }

    const { data, error } = await query;
    this.fail(error, `Failed to list ${table}`);

    return (data ?? []) as T[];
  }

  async deleteById(
    table: string,
    id: string,
    organizationId?: string,
  ): Promise<void> {
    let query = this.client.from(table).delete().eq('id', id);
    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { error } = await query;
    this.fail(error, `Failed to delete ${table}`);
  }

  async rpc<T = any>(fn: string, params: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(fn, params);
    this.fail(error, `RPC ${fn} failed`);

    return data as T;
  }
}
