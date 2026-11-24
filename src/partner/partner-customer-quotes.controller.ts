/**
 * @fileoverview Customer-facing quote inbox (sub-ticket 4). The org being sold to
 * lists and accepts the quotes addressed to it; that acceptance is what authorises
 * PartnerSalesController's /convert. Deliberately NOT decorated with
 * @RequirePartner() - the caller is an ordinary tenant, not a partner - and gated
 * on the org-admin settings permissions rather than any can_*_partner_* key.
 * Every method is scoped to the caller's own organizationId from the auth context.
 * @module src/partner/partner-customer-quotes.controller
 */

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PartnerSalesService } from './partner-sales.service';

@ApiTags('Organization Quotes')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('organization/quotes')
export class PartnerCustomerQuotesController {
  constructor(private readonly service: PartnerSalesService) {}

  @Get()
  @RequirePermissions('can_view_settings')
  list(
    @CurrentUser() user: RequestUser,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize?: number,
  ) {
    return this.service.listIncomingQuotes(user.organizationId, {
      page,
      pageSize,
    });
  }

  @Get(':quoteId')
  @RequirePermissions('can_view_settings')
  get(
    @CurrentUser() user: RequestUser,
    @Param('quoteId', ParseUUIDPipe) quoteId: string,
  ) {
    return this.service.getIncomingQuote(user.organizationId, quoteId);
  }

  // can_edit_settings, not can_view_settings: accepting commits the org to a
  // licence and an invoice, so it is owner/admin-only (managers hold view but
  // not edit). This is the same bar as any other org-level commitment.
  @Post(':quoteId/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_edit_settings')
  accept(
    @CurrentUser() user: RequestUser,
    @Param('quoteId', ParseUUIDPipe) quoteId: string,
  ) {
    return this.service.acceptIncomingQuote(
      user.organizationId,
      user.userId,
      quoteId,
    );
  }
}
