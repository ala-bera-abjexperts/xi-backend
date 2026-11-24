/**
 * @fileoverview Unauthenticated public lookup for tenant existence.
 *
 * Used by the Next.js Edge middleware (optionally — current 4.5 middleware
 * trusts any non-reserved subdomain and lets the backend reject at fetch
 * time) and any future Edge CDN cache that wants to short-circuit invalid
 * subdomains before they hit the dashboard route group.
 *
 * Privacy note: the endpoint leaks "tenant slug X exists" to anyone. DNS
 * itself leaks the same info (visiting `{slug}.xisuite.cloud` reveals
 * whether anything is served). Acceptable.
 *
 * @module src/tenants/public-tenants.controller
 */

import {
  Controller,
  Get,
  Header,
  HttpStatus,
  Param,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { isValidSlugFormat } from '../common/constants/slug-validators';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

@ApiTags('Public')
@Controller('public')
export class PublicTenantsController {
  constructor(private readonly supabase: SupabaseAdminService) {}

  @Public()
  @Get('tenant-exists/:slug')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  @ApiOperation({
    summary: 'Check whether a tenant slug exists',
    description:
      'Unauthenticated, idempotent, edge-cacheable. Returns 200 with { exists: true, slug } or 404 with { exists: false }. Used by middleware / CDN to short-circuit invalid subdomains. Format-invalid slugs (wrong regex / wrong length) return 404 without a DB lookup.',
  })
  @ApiResponse({ status: 200, description: 'Slug exists' })
  @ApiResponse({ status: 404, description: 'Slug does not exist' })
  async tenantExists(
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ exists: boolean; slug?: string }> {
    if (!isValidSlugFormat(slug)) {
      res.status(HttpStatus.NOT_FOUND);
      return { exists: false };
    }

    const { data } = await this.supabase
      .getClient()
      .from('organizations')
      .select('slug')
      .eq('slug', slug.toLowerCase())
      .maybeSingle();

    if (!data) {
      res.status(HttpStatus.NOT_FOUND);
      return { exists: false };
    }

    return { exists: true, slug: (data as { slug: string }).slug };
  }
}
