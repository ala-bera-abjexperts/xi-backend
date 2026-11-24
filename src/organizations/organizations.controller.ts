/**
 * @fileoverview Controller for organization management and branding endpoints.
 * Provides routes for onboarding (create org), branding CRUD, and logo upload/deletion.
 * @module src/organizations/organizations.controller
 * @author Prince Jadiya
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireRoles } from '../auth/decorators/require-roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  OrganizationsService,
  OrganizationBranding,
} from './organizations.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import {
  UpsertBrandingDto,
  UpsertBrandingThemeDto,
} from './dto/upsert-branding.dto';

/**
 * Controller for organization and branding management under the `/organizations` route prefix.
 *
 * Endpoints:
 * - `POST /organizations` -- Onboarding: create org + set user as owner
 * - `GET /organizations/branding` -- Get org branding config (admin/owner)
 * - `POST /organizations/branding` -- Upsert branding (admin/owner)
 * - `POST /organizations/branding/logo` -- Upload logo to slot (admin/owner)
 * - `DELETE /organizations/branding/logo` -- Delete logo from slot (admin/owner)
 */
@ApiTags('Organizations')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  /**
   * @param {OrganizationsService} organizationsService - Service for organization operations
   */
  constructor(private readonly organizationsService: OrganizationsService) {}

  /**
   * Onboarding endpoint: creates a new organization, adds the authenticated user
   * as the owner, and updates the user's organization_id.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {CreateOrganizationDto} body - Organization creation payload
   * @returns {Promise<Organization>} The newly created organization
   */
  @Post()
  @ApiOperation({
    summary: 'Create organization (onboarding)',
    description:
      'Creates a new organization, adds the authenticated user as owner, and links the user to the organization.',
  })
  @ApiResponse({
    status: 201,
    description: 'Organization created successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'User already has an org or slug is taken',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async createOrganization(
    @CurrentUser() user: RequestUser,
    @Body() body: CreateOrganizationDto,
  ): Promise<{
    message: string;
    organization: { id: string; name: string; slug: string };
  }> {
    const org = await this.organizationsService.createOrganization(
      user.userId,
      body,
    );
    return {
      message: 'Organization created successfully',
      organization: { id: org.id, name: org.name, slug: org.slug },
    };
  }

  @Get('branding')
  @UseGuards(RolesGuard)
  @RequireRoles('admin', 'owner')
  @ApiOperation({
    summary: 'Get organization branding',
    description:
      "Returns the branding configuration for the user's organization. Returns null if no branding is configured.",
  })
  @ApiResponse({ status: 200, description: 'Branding config returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  async getBranding(
    @CurrentUser() user: RequestUser,
  ): Promise<{ data: OrganizationBranding | null }> {
    const branding = await this.organizationsService.getBranding(
      user.organizationId,
    );
    return { data: branding };
  }

  /**
   * Creates or updates the branding configuration for the authenticated user's organization.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {UpsertBrandingDto} body - Branding fields to set
   * @returns {Promise<OrganizationBranding>} The created or updated branding record
   */
  @Post('branding')
  @UseGuards(RolesGuard)
  @RequireRoles('admin', 'owner')
  @ApiOperation({
    summary: 'Upsert organization branding',
    description:
      'Creates or updates branding configuration (primary color, logo URLs/paths) for the organization.',
  })
  @ApiResponse({ status: 201, description: 'Branding upserted successfully' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  async upsertBranding(
    @CurrentUser() user: RequestUser,
    @Body() body: UpsertBrandingDto,
  ): Promise<{ data: OrganizationBranding }> {
    const branding = await this.organizationsService.upsertBranding(
      user.organizationId,
      user.userId,
      body,
    );
    return { data: branding };
  }

  /**
   * Writes the per-surface branding theme (backgrounds + typography).
   *
   * Separate from `POST /branding` so the licence gate applies ONLY to the new surfaces.
   * Logo and primary colour stay ungated, because tenants already configured those under
   * plans that never checked the flag and must not lose them.
   */
  @Post('branding/theme')
  @UseGuards(RolesGuard)
  @RequireRoles('admin', 'owner')
  @RequireFeature('feature_custom_branding')
  @ApiOperation({
    summary: 'Upsert per-surface branding theme',
    description:
      'Sets backgrounds and typography for the app shell and wiki. Requires the feature_custom_branding entitlement.',
  })
  @ApiResponse({ status: 201, description: 'Branding theme upserted' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Insufficient role or feature_custom_branding not entitled',
  })
  async upsertBrandingTheme(
    @CurrentUser() user: RequestUser,
    @Body() body: UpsertBrandingThemeDto,
  ): Promise<{ data: OrganizationBranding }> {
    const branding = await this.organizationsService.upsertBranding(
      user.organizationId,
      user.userId,
      body,
    );
    return { data: branding };
  }

  /**
   * Uploads a logo image to a specific slot in the organization's branding.
   * Accepts multipart/form-data with `slot` and `file` fields.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {Express.Multer.File} file - The uploaded file
   * @param {string} slot - The logo slot (logo_light, logo_dark, emblem_light, emblem_dark)
   * @returns {Promise<OrganizationBranding>} The updated branding record
   */
  @Post('branding/logo')
  @UseGuards(RolesGuard)
  @RequireRoles('admin', 'owner')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Upload organization logo',
    description:
      'Uploads a logo to a specific slot (logo_light, logo_dark, emblem_light, emblem_dark). Max 5 MB. Supported formats: JPEG, PNG, WebP, SVG.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        slot: {
          type: 'string',
          enum: ['logo_light', 'logo_dark', 'emblem_light', 'emblem_dark'],
        },
        file: { type: 'string', format: 'binary' },
      },
      required: ['slot', 'file'],
    },
  })
  @ApiResponse({ status: 201, description: 'Logo uploaded successfully' })
  @ApiResponse({
    status: 400,
    description: 'Invalid slot, file type, or file too large',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  async uploadLogo(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('slot') slot: string,
  ): Promise<{ data: OrganizationBranding }> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    if (!slot) {
      throw new BadRequestException('Slot is required');
    }

    const branding = await this.organizationsService.uploadLogo(
      user.organizationId,
      user.userId,
      slot,
      file,
    );
    return { data: branding };
  }

  /**
   * Deletes a logo from a specific slot in the organization's branding.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} slot - The logo slot to clear
   * @returns {Promise<OrganizationBranding>} The updated branding record with cleared fields
   */
  @Delete('branding/logo')
  @UseGuards(RolesGuard)
  @RequireRoles('admin', 'owner')
  @ApiOperation({
    summary: 'Delete organization logo',
    description:
      'Deletes a logo from the specified slot and clears the branding fields.',
  })
  @ApiQuery({
    name: 'slot',
    required: true,
    enum: ['logo_light', 'logo_dark', 'emblem_light', 'emblem_dark'],
    description: 'The logo slot to delete',
  })
  @ApiResponse({ status: 200, description: 'Logo deleted successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or missing slot' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({ status: 404, description: 'Branding not found' })
  async deleteLogo(
    @CurrentUser() user: RequestUser,
    @Query('slot') slot: string,
  ): Promise<{ data: OrganizationBranding }> {
    if (!slot) {
      throw new BadRequestException('Slot query parameter is required');
    }

    const branding = await this.organizationsService.deleteLogo(
      user.organizationId,
      user.userId,
      slot,
    );
    return { data: branding };
  }

  @Get('statistics')
  @UseGuards(RolesGuard)
  @RequireRoles('admin', 'owner')
  @ApiOperation({
    summary: 'Get platform-wide statistics for the current organization',
  })
  @ApiResponse({ status: 200, description: 'Statistics returned' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  async getStatistics(@CurrentUser() user: RequestUser) {
    return this.organizationsService.getStatistics(user.organizationId);
  }

  // ── Parameterized routes last (static routes above must be declared first) ──

  @Get(':id')
  @UseGuards(RolesGuard)
  @RequireRoles('admin', 'owner')
  @ApiOperation({ summary: 'Get organization by ID (admin/owner only)' })
  @ApiResponse({ status: 200, description: 'Organization returned' })
  @ApiResponse({
    status: 403,
    description: 'Insufficient role or wrong organization',
  })
  async getOrganization(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ data: Record<string, unknown> }> {
    if (user.organizationId !== id) throw new ForbiddenException();
    const org = await this.organizationsService.getOrganizationById(id);
    return { data: org as unknown as Record<string, unknown> };
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @RequireRoles('admin', 'owner')
  @ApiOperation({ summary: 'Update organization (admin/owner only)' })
  @ApiResponse({ status: 200, description: 'Organization updated' })
  @ApiResponse({
    status: 403,
    description: 'Insufficient role or wrong organization',
  })
  async updateOrganization(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateOrganizationDto,
  ): Promise<{ data: Record<string, unknown> }> {
    if (user.organizationId !== id) throw new ForbiddenException();
    const org = await this.organizationsService.updateOrganization(id, body);
    return { data: org as unknown as Record<string, unknown> };
  }
}
