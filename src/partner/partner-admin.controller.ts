/**
 * @fileoverview Owner-panel (super admin) partner endpoints: provision a partner,
 * list all partners/leads, and accept/reject submitted leads.
 * @module src/partner/partner-admin.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireSuperAdmin } from '../auth/decorators/require-super-admin.decorator';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PartnerAdminService } from './partner-admin.service';
import { PartnerLeadsService } from './partner-leads.service';
import {
  CreateResellableItemDto,
  ProvisionPartnerDto,
  ReviewLeadDto,
  UpdateResellableItemDto,
} from './dto/partner.dto';

@ApiTags('Admin Partners')
@ApiBearerAuth()
@ImpersonationBlocked()
@RequireSuperAdmin()
@UseGuards(SuperAdminGuard)
@Controller('admin/partners')
export class PartnerAdminController {
  constructor(
    private readonly admin: PartnerAdminService,
    private readonly leads: PartnerLeadsService,
  ) {}

  @Get()
  listPartners(
    @Query('search') search?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize?: number,
  ) {
    return this.admin.listPartners({ search, page, pageSize });
  }

  @Post('provision')
  @HttpCode(HttpStatus.OK)
  provision(
    @CurrentUser() user: RequestUser,
    @Body() dto: ProvisionPartnerDto,
  ) {
    return this.admin.provision(user.userId, dto);
  }

  // ── Global module price list (XE-T738) ────────────────────────────────────
  @Get('resellable-items')
  listResellableItems() {
    return this.admin.listResellableItems();
  }

  @Post('resellable-items')
  createResellableItem(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateResellableItemDto,
  ) {
    return this.admin.createResellableItem(user.userId, dto);
  }

  @Patch('resellable-items/:itemId')
  updateResellableItem(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateResellableItemDto,
  ) {
    return this.admin.updateResellableItem(itemId, user.userId, dto);
  }

  @Delete('resellable-items/:itemId')
  deactivateResellableItem(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.admin.deactivateResellableItem(itemId, user.userId);
  }

  @Get('leads')
  listAllLeads(
    @Query('status') status?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize?: number,
  ) {
    return this.admin.listAllLeads({ status, page, pageSize });
  }

  @Get('leads/:leadId')
  getLead(@Param('leadId', ParseUUIDPipe) leadId: string) {
    return this.leads.getForOwner(leadId);
  }

  @Post('leads/:leadId/review')
  @HttpCode(HttpStatus.OK)
  reviewLead(
    @CurrentUser() user: RequestUser,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body() dto: ReviewLeadDto,
  ) {
    return this.leads.review(leadId, user.userId, dto);
  }
}
