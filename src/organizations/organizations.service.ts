/**
 * @fileoverview Service for organization management and branding operations.
 * Handles onboarding (create org + set owner), branding CRUD, and logo
 * upload/deletion in Supabase Storage.
 * @module src/organizations/organizations.service
 * @author Prince Jadiya
 */

import { storageSafeFileName } from '../common/upload-filename';
import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { formatMaxUpload, UPLOAD_LIMITS } from '../common/upload-limits';
import { assertImageMime } from '../common/upload-mime';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { UsersService } from '../users/users.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { CreateOrganizationDto } from './dto/create-organization.dto';
import type { UpsertBrandingDto } from './dto/upsert-branding.dto';
import type { UpdateOrganizationDto } from './dto/update-organization.dto';

/** Valid logo slot names for upload/delete operations */
const VALID_SLOTS = [
  'logo_light',
  'logo_dark',
  'emblem_light',
  'emblem_dark',
] as const;

/** Type for valid logo slot names */
export type LogoSlot = (typeof VALID_SLOTS)[number];

/** Allowed MIME types for logo uploads */
/**
 * Logo uploads accept any `image/*` type, SVG included — logos are commonly authored as vectors and
 * this endpoint has always accepted them. Admin-only upload, so the SVG-inline-script risk is
 * bounded by who can reach it.
 */
const LOGO_MIME_OPTS = { allowSvg: true } as const;

/** Maximum logo file size */
const MAX_LOGO_SIZE = UPLOAD_LIMITS.SMALL_IMAGE;

/** Supabase Storage bucket for tenant logos */
const STORAGE_BUCKET = 'wiki-attachments';

/**
 * Represents a row from the `organizations` table.
 */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  size: string;
  is_active: boolean;
  default_space_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Represents a row from the `organization_branding` table.
 */
export interface OrganizationBranding {
  id: string;
  organization_id: string;
  logo_light_url: string | null;
  logo_light_path: string | null;
  logo_dark_url: string | null;
  logo_dark_path: string | null;
  emblem_light_url: string | null;
  emblem_light_path: string | null;
  emblem_dark_url: string | null;
  emblem_dark_path: string | null;
  primary_color: string | null;

  /** Per-surface theme (backgrounds + typography). Shape owned by the frontend Zod schema. */
  theme_config: Record<string, unknown> | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Service for organization and branding management.
 *
 * @example
 * constructor(private readonly orgsService: OrganizationsService) {}
 * const org = await this.orgsService.createOrganization(userId, dto);
 */
@Injectable()
export class OrganizationsService {
  /** @private Logger instance scoped to this service */
  private readonly logger = new Logger(OrganizationsService.name);

  /**
   * @param {SupabaseAdminService} supabaseAdmin - Admin Supabase client for database and storage
   * @param {UsersService} usersService - Service for user profile lookups
   */
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly usersService: UsersService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  /**
   * Onboarding flow: creates an organization and inserts the caller as the
   * owner membership row atomically via the `create_organization_with_owner`
   * RPC. Users may already belong to other organizations — the previous
   * single-org guard is intentionally removed now that org membership is
   * tracked exclusively in the `organization_members` table.
   *
   * @param {string} userId - The application-level user ID (public.users.id)
   * @param {CreateOrganizationDto} data - Organization creation payload
   * @returns {Promise<Organization>} The newly created organization
   * @throws {ConflictException} When the slug is already taken (code: 'SLUG_TAKEN')
   * @throws {InternalServerErrorException} When the database operation fails
   */
  async createOrganization(
    userId: string,
    data: CreateOrganizationDto,
  ): Promise<Organization> {
    const client = this.supabaseAdmin.getClient();

    // 1. Verify the user exists. Users may now belong to multiple organizations,
    // so we no longer block org creation when the caller already has memberships.
    // Org membership is tracked in organization_members, not users.organization_id.
    const user = await this.usersService.getUserById(userId);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // 2. Validate slug is globally unique
    const slugResult = await client
      .from('organizations')
      .select('id')
      .eq('slug', data.slug)
      .maybeSingle();
    const existingOrg = slugResult.data;

    if (existingOrg) {
      throw new BadRequestException('Slug is already taken');
    }

    // 3. Create org + owner membership atomically. The RPC runs both INSERTs
    // in one transaction so a partial failure cannot leave a half-built org.
    // It re-raises SQLSTATE 23505 on slug collision so the ConflictException
    // mapping below returns a consistent { code: 'SLUG_TAKEN' } response.
    const rpcResult = await client.rpc('create_organization_with_owner', {
      p_user_id: userId,
      p_name: data.name,
      p_slug: data.slug,
      p_size: data.size,
    });

    if (rpcResult.error || !rpcResult.data) {
      const errMessage = rpcResult.error?.message ?? 'No data returned';
      const errCode = (rpcResult.error as { code?: string } | null)?.code;

      this.logger.error(`Failed to create organization: ${errMessage}`);

      if (
        errCode === '23505' ||
        /SLUG_TAKEN/i.test(errMessage) ||
        /organizations_slug_key/i.test(errMessage) ||
        /duplicate key value/i.test(errMessage)
      ) {
        throw new ConflictException({
          code: 'SLUG_TAKEN',
          message: 'Slug is already taken',
        });
      }

      throw new InternalServerErrorException('Failed to create organization');
    }

    return rpcResult.data as Organization;
  }

  /**
   * Retrieves the branding configuration for an organization.
   *
   * @param {string} orgId - The organization ID (UUID)
   * @returns {Promise<OrganizationBranding | null>} The branding record, or null if none exists
   */
  async getOrganizationById(orgId: string): Promise<Organization> {
    const result = await this.supabaseAdmin
      .getClient()
      .from('organizations')
      .select('*')
      .eq('id', orgId)
      .maybeSingle();

    if (result.error) throw new BadRequestException(result.error.message);
    if (!result.data) throw new NotFoundException('Organization not found');
    return result.data as Organization;
  }

  async updateOrganization(
    orgId: string,
    data: UpdateOrganizationDto,
  ): Promise<Organization> {
    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch['name'] = data.name;
    if (data.slug !== undefined) patch['slug'] = data.slug;
    if (data.size !== undefined) patch['size'] = data.size;
    if (data.is_active !== undefined) patch['is_active'] = data.is_active;
    if ('default_space_id' in data)
      patch['default_space_id'] = data.default_space_id ?? null;

    if (Object.keys(patch).length === 0) return this.getOrganizationById(orgId);

    if (data.slug) {
      const slugResult = await this.supabaseAdmin
        .getClient()
        .from('organizations')
        .select('id')
        .eq('slug', data.slug)
        .maybeSingle();
      const existingOrg = slugResult.data as { id: string } | null;

      if (slugResult.error)
        throw new BadRequestException(slugResult.error.message);
      if (existingOrg && existingOrg.id !== orgId) {
        throw new BadRequestException(
          `Organization slug "${data.slug}" is already taken`,
        );
      }
    }

    if (data.default_space_id) {
      const spaceResult = await this.supabaseAdmin
        .getClient()
        .from('spaces')
        .select('id, organization_id')
        .eq('id', data.default_space_id)
        .maybeSingle();
      const space = spaceResult.data as {
        id: string;
        organization_id: string;
      } | null;

      if (spaceResult.error) {
        throw new BadRequestException(spaceResult.error.message);
      }

      if (!space || space.organization_id !== orgId) {
        throw new BadRequestException(
          'Default space must belong to this organization',
        );
      }
    }

    patch['updated_at'] = new Date().toISOString();

    const result = await this.supabaseAdmin
      .getClient()
      .from('organizations')
      .update(patch)
      .eq('id', orgId)
      .select('*')
      .single();

    if (result.error || !result.data)
      throw new BadRequestException(
        result.error?.message ?? 'Failed to update organization',
      );
    return result.data as Organization;
  }

  async getBranding(orgId: string): Promise<OrganizationBranding | null> {
    const result = await this.supabaseAdmin
      .getClient()
      .from('organization_branding')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle();

    if (result.error) {
      this.logger.error(`Failed to get branding: ${result.error.message}`);
      throw new InternalServerErrorException('Failed to get branding');
    }

    return result.data as OrganizationBranding | null;
  }

  /**
   * Creates or updates the branding configuration for an organization.
   * Uses upsert on the organization_id primary key.
   *
   * @param {string} orgId - The organization ID (UUID)
   * @param {string} userId - The user performing the update (for updated_by)
   * @param {UpsertBrandingDto} data - Branding fields to set
   * @returns {Promise<OrganizationBranding>} The created or updated branding record
   * @throws {InternalServerErrorException} When the database operation fails
   */
  async upsertBranding(
    orgId: string,
    userId: string,
    // `theme_config` is intentionally absent from UpsertBrandingDto (it is licence-gated on
    // its own route); widened here so the gated controller can reuse this same writer.
    data: UpsertBrandingDto & { theme_config?: Record<string, unknown> },
  ): Promise<OrganizationBranding> {
    const now = new Date().toISOString();
    const { organizationId: _ignoredOrganizationId, ...brandingData } = data;

    const upsertResult = await this.supabaseAdmin
      .getClient()
      .from('organization_branding')
      .upsert(
        {
          organization_id: orgId,
          ...brandingData,
          updated_by: userId,
          updated_at: now,
        },
        { onConflict: 'organization_id' },
      )
      .select('*')
      .single();

    if (upsertResult.error || !upsertResult.data) {
      this.logger.error(
        `Failed to upsert branding: ${upsertResult.error?.message ?? 'No data returned'}`,
      );
      throw new InternalServerErrorException('Failed to upsert branding');
    }

    const branding = upsertResult.data as OrganizationBranding;

    void this.auditLogsService.logAction(
      orgId,
      userId,
      'organization_branding',
      branding.id ?? orgId,
      'update',
      brandingData,
    );

    return branding;
  }

  /**
   * Uploads a logo file to Supabase Storage, deletes the old file for that slot,
   * retrieves the public URL, and updates the branding record.
   *
   * @param {string} orgId - The organization ID (UUID)
   * @param {string} userId - The user performing the upload (for updated_by)
   * @param {string} slot - The logo slot name (logo_light, logo_dark, emblem_light, emblem_dark)
   * @param {Express.Multer.File} file - The uploaded file
   * @returns {Promise<OrganizationBranding>} The updated branding record
   * @throws {BadRequestException} When the slot is invalid or the file fails validation
   * @throws {InternalServerErrorException} When upload or database operations fail
   */
  async uploadLogo(
    orgId: string,
    userId: string,
    slot: string,
    file: Express.Multer.File,
  ): Promise<OrganizationBranding> {
    // Validate slot
    if (!VALID_SLOTS.includes(slot as LogoSlot)) {
      throw new BadRequestException(
        `Invalid slot. Must be one of: ${VALID_SLOTS.join(', ')}`,
      );
    }

    // Validate file type
    assertImageMime(file.mimetype, LOGO_MIME_OPTS);

    // Validate file size
    if (file.size > MAX_LOGO_SIZE) {
      throw new BadRequestException(
        `File size exceeds ${formatMaxUpload(MAX_LOGO_SIZE)} limit`,
      );
    }

    const client = this.supabaseAdmin.getClient();
    const pathField = `${slot}_path` as keyof OrganizationBranding;
    const urlField = `${slot}_url` as keyof OrganizationBranding;

    // Delete old logo for this slot if exists
    const existingBranding = await this.getBranding(orgId);
    if (existingBranding && existingBranding[pathField]) {
      await client.storage
        .from(STORAGE_BUCKET)
        .remove([existingBranding[pathField] as string]);
    }

    // Upload new file
    const sanitizedName = storageSafeFileName(file.originalname);
    const storagePath = `tenant-logos/${orgId}/${slot}-${Date.now()}-${sanitizedName}`;
    const { error: uploadError } = await client.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      this.logger.error(`Failed to upload logo: ${uploadError.message}`);
      throw new InternalServerErrorException('Failed to upload logo');
    }

    // Get public URL
    const publicUrlResult = client.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);
    const publicUrl = publicUrlResult.data.publicUrl;

    // Upsert branding record with new path and URL
    const updatePayload: Record<string, string> = {
      organization_id: orgId,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
    updatePayload[pathField] = storagePath;
    updatePayload[urlField] = publicUrl;

    const dbResult = await client
      .from('organization_branding')
      .upsert(updatePayload, { onConflict: 'organization_id' })
      .select('*')
      .single();

    if (dbResult.error || !dbResult.data) {
      this.logger.error(
        `Failed to update branding after upload: ${dbResult.error?.message ?? 'No data returned'}`,
      );
      throw new InternalServerErrorException(
        'Failed to update branding record',
      );
    }

    const branding = dbResult.data as OrganizationBranding;

    void this.auditLogsService.logAction(
      orgId,
      userId,
      'organization_branding',
      branding.id ?? orgId,
      'update',
      {
        slot,
        path: storagePath,
        url: publicUrl,
      },
    );

    return branding;
  }

  /**
   * Deletes a logo from Supabase Storage and clears the corresponding branding fields.
   *
   * @param {string} orgId - The organization ID (UUID)
   * @param {string} userId - The user performing the deletion (for updated_by)
   * @param {string} slot - The logo slot name (logo_light, logo_dark, emblem_light, emblem_dark)
   * @returns {Promise<OrganizationBranding>} The updated branding record with cleared fields
   * @throws {BadRequestException} When the slot is invalid
   * @throws {InternalServerErrorException} When deletion or database operations fail
   */
  async deleteLogo(
    orgId: string,
    userId: string,
    slot: string,
  ): Promise<OrganizationBranding> {
    // Validate slot
    if (!VALID_SLOTS.includes(slot as LogoSlot)) {
      throw new BadRequestException(
        `Invalid slot. Must be one of: ${VALID_SLOTS.join(', ')}`,
      );
    }

    const client = this.supabaseAdmin.getClient();
    const pathField = `${slot}_path` as keyof OrganizationBranding;
    const urlField = `${slot}_url` as keyof OrganizationBranding;

    // Get existing branding. Legacy Next behavior allowed deleting an empty
    // slot before a branding row existed by upserting a null slot record.
    const existingBranding = await this.getBranding(orgId);

    // Delete from storage if path exists
    if (existingBranding?.[pathField]) {
      await client.storage
        .from(STORAGE_BUCKET)
        .remove([existingBranding[pathField] as string]);
    }

    // Clear the branding fields
    const updatePayload: Record<string, string | null> = {
      organization_id: orgId,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
    updatePayload[pathField] = null;
    updatePayload[urlField] = null;

    const deleteResult = await client
      .from('organization_branding')
      .upsert(updatePayload, { onConflict: 'organization_id' })
      .select('*')
      .single();

    if (deleteResult.error || !deleteResult.data) {
      this.logger.error(
        `Failed to clear branding fields: ${deleteResult.error?.message ?? 'No data returned'}`,
      );
      throw new InternalServerErrorException(
        'Failed to update branding record',
      );
    }

    const branding = deleteResult.data as OrganizationBranding;

    void this.auditLogsService.logAction(
      orgId,
      userId,
      'organization_branding',
      branding.id ?? orgId,
      'update',
      { slot, cleared: true },
    );

    return branding;
  }

  /**
   * Aggregates platform-wide statistics for an organization.
   * Runs 4 parallel queries then one dependent space-modules query.
   *
   * @param {string} orgId - The organization ID (UUID)
   * @returns Platform statistics including task/user/space counts, activated modules, and AI usage
   */
  /**
   * Bytes and file counts per space, for the platform-statistics breakdown.
   *
   * Four sources:
   *  - file_attachments + file_versions — the unified store behind task, process, wiki-page,
   *    asset-item and support-request attachments made through the frontend attachment service.
   *    Every VERSION is counted, because every version occupies storage, not just the current one.
   *  - asset_object_attachments — self-contained, its own file_size.
   *  - task_attachments — written by the backend TaskAttachmentsService; space resolved through
   *    the parent task.
   *  - wiki_page_attachments — written by WikiService (upload UI + migration); no organization
   *    column, so rows are scoped to the organization's spaces through the wiki_pages embed.
   *
   * Truly legacy tables (process_attachments, wiki_attachments, gdpr_record_attachments,
   * space_gdpr_record_attachments, asset_item_attachments) have no active writers — both the
   * backend and the frontend attachment service route those entity types to the unified
   * file_attachments store — and are excluded to avoid double counting.
   */
  private async storageBytesBySpace(
    orgId: string,
    spaceIds: string[],
  ): Promise<Record<string, { bytes: number; files: number }>> {
    const client = this.supabaseAdmin.getClient();
    const totals: Record<string, { bytes: number; files: number }> = {};

    const add = (spaceId: string | null, bytes: number, files: number) => {
      if (!spaceId) return;
      if (!totals[spaceId]) totals[spaceId] = { bytes: 0, files: 0 };
      totals[spaceId].bytes += bytes;
      totals[spaceId].files += files;
    };

    const [unified, assetObjects, taskFiles, wikiFiles] = await Promise.all([
      client
        .from('file_attachments')
        .select('space_id, file_versions(file_size)')
        .eq('organization_id', orgId),
      client
        .from('asset_object_attachments')
        .select('space_id, file_size')
        .eq('organization_id', orgId),
      client
        .from('task_attachments')
        .select('file_size, tasks(space_id)')
        .eq('organization_id', orgId),
      client
        .from('wiki_page_attachments')
        .select('file_size, wiki_pages(space_id)')
        .in('wiki_pages.space_id', spaceIds),
    ]);

    for (const row of (unified.data ?? []) as Array<{
      space_id: string | null;
      file_versions: { file_size: number | null }[] | null;
    }>) {
      const versions = row.file_versions ?? [];

      add(
        row.space_id,
        versions.reduce((sum, v) => sum + (v.file_size ?? 0), 0),
        1,
      );
    }

    for (const row of (assetObjects.data ?? []) as Array<{
      space_id: string | null;
      file_size: number | null;
    }>) {
      add(row.space_id, row.file_size ?? 0, 1);
    }

    for (const row of (taskFiles.data ?? []) as unknown as Array<{
      file_size: number | null;
      tasks: { space_id: string | null } | null;
    }>) {
      add(row.tasks?.space_id ?? null, row.file_size ?? 0, 1);
    }

    for (const row of (wikiFiles.data ?? []) as unknown as Array<{
      file_size: number | null;
      wiki_pages: { space_id: string | null } | null;
    }>) {
      add(row.wiki_pages?.space_id ?? null, row.file_size ?? 0, 1);
    }

    return totals;
  }

  async getStatistics(orgId: string): Promise<{
    task_count: number;
    user_count: number;
    space_count: number;
    module_space_counts: Record<string, number>;
    org_modules: Array<{ module_type: string; is_enabled: boolean }>;
    space_breakdowns: Array<{
      space_id: string;
      space_name: string;
      space_key: string;
      space_color: string;
      enabled_modules: string[];
      module_counts: Record<string, number>;

      /** Bytes stored against this space, and how many files that is. */
      storage_bytes: number;
      file_count: number;
    }>;
    generated_at: string;
  }> {
    const client = this.supabaseAdmin.getClient();

    const [tasksResult, usersResult, spacesResult, orgModulesResult] =
      await Promise.all([
        client
          .from('tasks')
          .select('*', { count: 'exact', head: true })
          .eq('organization_id', orgId),
        client
          .from('organization_members')
          .select('*', { count: 'exact', head: true })
          .eq('organization_id', orgId),
        client
          .from('spaces')
          .select('id, name, key, color')
          .eq('organization_id', orgId)
          .eq('is_archived', false),
        client
          .from('organization_modules')
          .select('module_type, is_enabled')
          .eq('organization_id', orgId),
      ]);

    const spacesData = (spacesResult.data ?? []) as Array<{
      id: string;
      name: string;
      key: string;
      color: string;
    }>;
    const spaceIds = spacesData.map((s) => s.id);

    const noRows = { data: [] as Array<{ space_id: string }> };

    const [
      spaceModuleRows,
      taskRows,
      wikiRows,
      boardRows,
      planRows,
      processRows,
      automationRows,
      dashboardRows,
      listRows,
      workflowRows,
    ] = await Promise.all([
      spaceIds.length > 0
        ? client
            .from('space_modules')
            .select('module_type, space_id')
            .eq('is_enabled', true)
            .in('space_id', spaceIds)
        : { data: [] },
      spaceIds.length > 0
        ? client.from('tasks').select('space_id').in('space_id', spaceIds)
        : noRows,
      spaceIds.length > 0
        ? client.from('wiki_pages').select('space_id').in('space_id', spaceIds)
        : noRows,
      spaceIds.length > 0
        ? client.from('boards').select('space_id').in('space_id', spaceIds)
        : noRows,
      spaceIds.length > 0
        ? client
            .from('plans')
            .select('space_id')
            .in('space_id', spaceIds)
            .eq('is_archived', false)
        : noRows,
      spaceIds.length > 0
        ? client
            .from('business_processes')
            .select('space_id')
            .in('space_id', spaceIds)
        : noRows,
      spaceIds.length > 0
        ? client
            .from('automations')
            .select('space_id')
            .in('space_id', spaceIds)
            .eq('is_archived', false)
        : noRows,
      spaceIds.length > 0
        ? client.from('dashboards').select('space_id').in('space_id', spaceIds)
        : noRows,
      spaceIds.length > 0
        ? client.from('lists').select('space_id').in('space_id', spaceIds)
        : noRows,
      spaceIds.length > 0
        ? client
            .from('workflows')
            .select('space_id')
            .in('space_id', spaceIds)
            .eq('is_archived', false)
            .eq('is_draft', false)
        : noRows,
    ]);

    const countBySpace = (
      rows: Array<{ space_id: string }> | null,
    ): Record<string, number> =>
      (rows ?? []).reduce((acc: Record<string, number>, row) => {
        acc[row.space_id] = (acc[row.space_id] ?? 0) + 1;
        return acc;
      }, {});

    const moduleCountMaps: Record<string, Record<string, number>> = {
      tasks: countBySpace(taskRows.data as Array<{ space_id: string }> | null),
      wiki: countBySpace(wikiRows.data as Array<{ space_id: string }> | null),
      boards: countBySpace(
        boardRows.data as Array<{ space_id: string }> | null,
      ),
      plans: countBySpace(planRows.data as Array<{ space_id: string }> | null),
      processes: countBySpace(
        processRows.data as Array<{ space_id: string }> | null,
      ),
      automations: countBySpace(
        automationRows.data as Array<{ space_id: string }> | null,
      ),
      dashboards: countBySpace(
        dashboardRows.data as Array<{ space_id: string }> | null,
      ),
      lists: countBySpace(listRows.data as Array<{ space_id: string }> | null),
      workflows: countBySpace(
        workflowRows.data as Array<{ space_id: string }> | null,
      ),
    };

    const moduleSpaceCounts: Record<string, number> = {};
    const spaceModuleMap: Record<string, string[]> = {};

    for (const row of (spaceModuleRows.data as Array<{
      module_type: string;
      space_id: string;
    }>) ?? []) {
      moduleSpaceCounts[row.module_type] =
        (moduleSpaceCounts[row.module_type] ?? 0) + 1;
      if (!spaceModuleMap[row.space_id]) spaceModuleMap[row.space_id] = [];
      spaceModuleMap[row.space_id].push(row.module_type);
    }

    const spaceNameMap = Object.fromEntries(spacesData.map((s) => [s.id, s]));

    const storageBySpace = await this.storageBytesBySpace(orgId, spaceIds);

    const space_breakdowns = spaceIds
      .map((id) => ({
        space_id: id,
        space_name: spaceNameMap[id]?.name ?? id,
        space_key: spaceNameMap[id]?.key ?? '',
        space_color: spaceNameMap[id]?.color ?? '#3B82F6',
        storage_bytes: storageBySpace[id]?.bytes ?? 0,
        file_count: storageBySpace[id]?.files ?? 0,
        enabled_modules: spaceModuleMap[id] ?? [],
        module_counts: Object.fromEntries(
          Object.entries(moduleCountMaps).map(([mod, countMap]) => [
            mod,
            countMap[id] ?? 0,
          ]),
        ),
      }))
      .sort((a, b) => a.space_name.localeCompare(b.space_name));

    return {
      task_count: tasksResult.count ?? 0,
      user_count: usersResult.count ?? 0,
      space_count: spaceIds.length,
      module_space_counts: moduleSpaceCounts,
      org_modules:
        (orgModulesResult.data as Array<{
          module_type: string;
          is_enabled: boolean;
        }>) ?? [],
      space_breakdowns,
      generated_at: new Date().toISOString(),
    };
  }
}
