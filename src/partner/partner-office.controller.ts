/**
 * @fileoverview Partner office (Backoffice) user endpoints (sub-ticket 3): list
 * members, list/revoke pending invites, invite a domain-locked Backoffice user,
 * and remove an active office user.
 * @module src/partner/partner-office.controller
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
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePartner } from '../auth/decorators/require-partner.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PartnerOfficeService } from './partner-office.service';
import { InviteOfficeUserDto } from './dto/partner.dto';

@ApiTags('Partner Office Users')
@ApiBearerAuth()
@RequirePartner()
@UseGuards(PermissionsGuard)
@Controller('partner/office-users')
export class PartnerOfficeController {
  constructor(private readonly service: PartnerOfficeService) {}

  @Get()
  @RequirePermissions('can_view_partner_profile')
  listMembers(@CurrentUser() user: RequestUser) {
    return this.service.listMembers(user.organizationId);
  }

  @Get('invites')
  @RequirePermissions('can_manage_partner_office_users')
  listInvites(@CurrentUser() user: RequestUser) {
    return this.service.listPendingInvites(user.organizationId);
  }

  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_partner_office_users')
  invite(@CurrentUser() user: RequestUser, @Body() dto: InviteOfficeUserDto) {
    return this.service.inviteBackoffice(user.organizationId, user.userId, dto);
  }

  @Delete('invites/:invitationId')
  @RequirePermissions('can_manage_partner_office_users')
  revoke(
    @CurrentUser() user: RequestUser,
    @Param('invitationId', ParseUUIDPipe) invitationId: string,
  ) {
    return this.service.revokeInvite(user.organizationId, invitationId);
  }

  @Delete('members/:userId')
  @RequirePermissions('can_manage_partner_office_users')
  removeMember(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.service.removeMember(user.organizationId, user.userId, userId);
  }
}
