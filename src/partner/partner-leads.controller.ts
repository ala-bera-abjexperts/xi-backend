/**
 * @fileoverview Partner-facing lead endpoints (sub-ticket 2): CRUD, submit/
 * resubmit, and the comment thread. Owner review lives in PartnerAdminController.
 * @module src/partner/partner-leads.controller
 */

import {
  Body,
  Controller,
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
import { RequirePartner } from '../auth/decorators/require-partner.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PartnerLeadsService } from './partner-leads.service';
import {
  CreateLeadDto,
  LeadCommentDto,
  UpdateLeadDto,
} from './dto/partner.dto';

@ApiTags('Partner Leads')
@ApiBearerAuth()
@RequirePartner()
@UseGuards(PermissionsGuard)
@Controller('partner/leads')
export class PartnerLeadsController {
  constructor(private readonly service: PartnerLeadsService) {}

  @Get()
  @RequirePermissions('can_view_partner_leads')
  list(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize?: number,
  ) {
    return this.service.list(user.organizationId, {
      status,
      search,
      page,
      pageSize,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_partner_leads')
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateLeadDto) {
    return this.service.create(user.organizationId, user.userId, dto);
  }

  @Get(':leadId')
  @RequirePermissions('can_view_partner_leads')
  get(
    @CurrentUser() user: RequestUser,
    @Param('leadId', ParseUUIDPipe) leadId: string,
  ) {
    return this.service.get(user.organizationId, leadId);
  }

  @Patch(':leadId')
  @RequirePermissions('can_manage_partner_leads')
  update(
    @CurrentUser() user: RequestUser,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body() dto: UpdateLeadDto,
  ) {
    return this.service.update(user.organizationId, user.userId, leadId, dto);
  }

  @Post(':leadId/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_partner_leads')
  submit(
    @CurrentUser() user: RequestUser,
    @Param('leadId', ParseUUIDPipe) leadId: string,
  ) {
    return this.service.submit(user.organizationId, user.userId, leadId);
  }

  @Get(':leadId/comments')
  @RequirePermissions('can_view_partner_leads')
  listComments(
    @CurrentUser() user: RequestUser,
    @Param('leadId', ParseUUIDPipe) leadId: string,
  ) {
    return this.service.listComments(user.organizationId, leadId);
  }

  @Post(':leadId/comments')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_partner_leads')
  addComment(
    @CurrentUser() user: RequestUser,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body() dto: LeadCommentDto,
  ) {
    return this.service.addComment(
      user.organizationId,
      user.userId,
      leadId,
      dto,
    );
  }
}
