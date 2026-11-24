/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- dynamically-typed Supabase rows via the generic partner repository */
/**
 * @fileoverview Public partner directory (the "Partner section" of the website).
 * Anonymous, read-only: lists published listings and resolves one by slug.
 *
 * This is the ONLY unauthenticated surface the partner module exposes, so every
 * column it returns is world-readable. Both handlers project an explicit
 * allow-list - never `select('*')`. The raw rows carry organization_id,
 * partner_profile_id and created_by/updated_by (real auth user UUIDs), plus the
 * soft-delete bookkeeping: internal identifiers that every other endpoint keys
 * on, which anonymous callers have no business receiving.
 * @module src/partner/partner-public.controller
 */

import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { PartnerRepository } from './partner.repository';

/**
 * The public face of a listing. Add a column ONLY if it is genuinely meant for
 * anonymous visitors - anything absent here stays internal.
 */
const PUBLIC_LISTING_COLUMNS = [
  'slug',
  'headline',
  'summary',
  'description',
  'logo_url',
  'banner_url',
  'contact_email',
  'contact_phone',
  'website_url',
  'social_links',
  'gallery_urls',
  'published_at',
] as const;

/**
 * Offerings are public by design once their listing is published (the table has
 * no is_published/is_deleted of its own), but they still carry organization_id
 * and created_by/updated_by, which must not ship.
 */
const PUBLIC_OFFERING_COLUMNS = [
  'title',
  'description',
  'icon',
  'sort_order',
] as const;

type PublicRow = Record<string, unknown>;

/** Keep only allow-listed keys - defence in depth if a select ever widens. */
function project(row: PublicRow, columns: readonly string[]): PublicRow {
  const out: PublicRow = {};

  for (const key of columns) {
    if (key in row) out[key] = row[key];
  }

  return out;
}

@ApiTags('Partner Directory (public)')
@Public()
@Controller('partners')
export class PartnerPublicController {
  constructor(private readonly repo: PartnerRepository) {}

  @Get()
  async listPublished() {
    const { data } = await this.repo.client
      .from('partner_public_listings')
      .select(PUBLIC_LISTING_COLUMNS.join(','))
      .eq('is_published', true)
      .eq('is_deleted', false)
      // XE-T734: the directory lists only partners who opted in; a published
      // listing without it is still reachable by its own slug below.
      .eq('show_in_directory', true)
      .order('created_at', { ascending: false });

    // A runtime-built select string defeats supabase-js's column inference, so the
    // rows come back as GenericStringError - double-cast through unknown.
    return (data ?? []).map((row) =>
      project(row as unknown as PublicRow, PUBLIC_LISTING_COLUMNS),
    );
  }

  @Get(':slug')
  async getBySlug(@Param('slug') slug: string) {
    // findOne returns the whole row: the listing id is needed to fetch offerings
    // but must not be returned, so it is projected away below.
    const listing = await this.repo.findOne('partner_public_listings', {
      slug,
      is_published: true,
      is_deleted: false,
    });

    if (!listing) {
      throw new NotFoundException('Partner listing not found');
    }

    const offerings = await this.repo.findMany('partner_offerings', {
      listing_id: listing.id as string,
    });

    return {
      ...project(listing as PublicRow, PUBLIC_LISTING_COLUMNS),
      offerings: (offerings ?? [])
        .map((o) => project(o as PublicRow, PUBLIC_OFFERING_COLUMNS))
        .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0)),
    };
  }
}
