/**
 * @fileoverview Partner profile, contacts, public listing + offerings endpoints
 * (sub-ticket 1). All gated by @RequirePartner + per-route permissions.
 * @module src/partner/partner-profile.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePartner } from '../auth/decorators/require-partner.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PartnerProfileService } from './partner-profile.service';
import {
  CreatePartnerContactDto,
  CreatePartnerOfferingDto,
  UpdatePartnerContactDto,
  UpdatePartnerOfferingDto,
  UpdatePartnerProfileDto,
  UpsertPartnerListingDto,
} from './dto/partner.dto';

@ApiTags('Partner Profile')
@ApiBearerAuth()
@RequirePartner()
@UseGuards(PermissionsGuard)
@Controller('partner/profile')
export class PartnerProfileController {
  constructor(private readonly service: PartnerProfileService) {}

  @Get()
  @RequirePermissions('can_view_partner_profile')
  getProfile(@CurrentUser() user: RequestUser) {
    return this.service.getProfile(user.organizationId);
  }

  @Put()
  @RequirePermissions('can_manage_partner_profile')
  updateProfile(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdatePartnerProfileDto,
  ) {
    return this.service.updateProfile(user.organizationId, user.userId, dto);
  }

  // ── Contacts ───────────────────────────────────────────────────────────────
  @Get('contacts')
  @RequirePermissions('can_view_partner_profile')
  listContacts(@CurrentUser() user: RequestUser) {
    return this.service.listContacts(user.organizationId);
  }

  @Post('contacts')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_partner_profile')
  createContact(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreatePartnerContactDto,
  ) {
    return this.service.createContact(user.organizationId, user.userId, dto);
  }

  @Patch('contacts/:contactId')
  @RequirePermissions('can_manage_partner_profile')
  updateContact(
    @CurrentUser() user: RequestUser,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: UpdatePartnerContactDto,
  ) {
    return this.service.updateContact(
      user.organizationId,
      user.userId,
      contactId,
      dto,
    );
  }

  @Delete('contacts/:contactId')
  @RequirePermissions('can_manage_partner_profile')
  deleteContact(
    @CurrentUser() user: RequestUser,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ) {
    return this.service.deleteContact(user.organizationId, contactId);
  }

  // ── Public listing ─────────────────────────────────────────────────────────
  @Get('listing')
  @RequirePermissions('can_view_partner_profile')
  getListing(@CurrentUser() user: RequestUser) {
    return this.service.getListing(user.organizationId);
  }

  @Put('listing')
  @RequirePermissions('can_manage_partner_profile')
  upsertListing(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpsertPartnerListingDto,
  ) {
    return this.service.upsertListing(user.organizationId, user.userId, dto);
  }

  @Post('listing/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_partner_profile')
  publishListing(@CurrentUser() user: RequestUser) {
    return this.service.setPublished(user.organizationId, user.userId, true);
  }

  @Post('listing/unpublish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_partner_profile')
  unpublishListing(@CurrentUser() user: RequestUser) {
    return this.service.setPublished(user.organizationId, user.userId, false);
  }

  // ── Offerings ────────────────────────────────────────────────────────────
  @Get('offerings')
  @RequirePermissions('can_view_partner_profile')
  listOfferings(@CurrentUser() user: RequestUser) {
    return this.service.listOfferings(user.organizationId);
  }

  @Post('offerings')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_partner_profile')
  createOffering(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreatePartnerOfferingDto,
  ) {
    return this.service.createOffering(user.organizationId, user.userId, dto);
  }

  @Patch('offerings/:offeringId')
  @RequirePermissions('can_manage_partner_profile')
  updateOffering(
    @CurrentUser() user: RequestUser,
    @Param('offeringId', ParseUUIDPipe) offeringId: string,
    @Body() dto: UpdatePartnerOfferingDto,
  ) {
    return this.service.updateOffering(
      user.organizationId,
      user.userId,
      offeringId,
      dto,
    );
  }

  @Delete('offerings/:offeringId')
  @RequirePermissions('can_manage_partner_profile')
  deleteOffering(
    @CurrentUser() user: RequestUser,
    @Param('offeringId', ParseUUIDPipe) offeringId: string,
  ) {
    return this.service.deleteOffering(user.organizationId, offeringId);
  }
}
