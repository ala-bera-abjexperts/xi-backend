/**
 * @fileoverview Partner reporting endpoints (sub-ticket 5): kickback per month +
 * projection, and a portfolio overview (customers, MRR, expiring licenses).
 * @module src/partner/partner-reporting.controller
 */

import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePartner } from '../auth/decorators/require-partner.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PartnerReportingService } from './partner-reporting.service';

@ApiTags('Partner Reporting')
@ApiBearerAuth()
@RequirePartner()
@UseGuards(PermissionsGuard)
@Controller('partner/reporting')
export class PartnerReportingController {
  constructor(private readonly service: PartnerReportingService) {}

  @Get('overview')
  @RequirePermissions('can_view_partner_customers')
  overview(@CurrentUser() user: RequestUser) {
    return this.service.overview(user.organizationId);
  }

  @Get('kickback')
  @RequirePermissions('can_view_partner_invoices')
  kickback(@CurrentUser() user: RequestUser) {
    return this.service.kickback(user.organizationId);
  }
}
