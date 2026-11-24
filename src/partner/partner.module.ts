/**
 * @fileoverview Partner Portal module - the /partner workspace, the owner-panel
 * /admin/partners endpoints, and the customer-facing /organization/quotes inbox
 * (the only surface that can accept a quote; it is NOT partner-guarded). Imports
 * LicensingModule for EntitlementsService (cache bust on quote conversion).
 * SupabaseAdminService is globally available.
 * @module src/partner/partner.module
 */

import { Module } from '@nestjs/common';
import { InvitationsModule } from '../invitations/invitations.module';
import { LicensingModule } from '../licensing/licensing.module';
import { OnpremReleasesModule } from '../onprem-releases/onprem-releases.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { PartnerRepository } from './partner.repository';
import { PartnerProfileService } from './partner-profile.service';
import { PartnerLeadsService } from './partner-leads.service';
import { PartnerCustomersService } from './partner-customers.service';
import { PartnerSalesService } from './partner-sales.service';
import { PartnerReportingService } from './partner-reporting.service';
import { PartnerOfficeService } from './partner-office.service';
import { PartnerAdminService } from './partner-admin.service';
import { PartnerKickbackCron } from './partner-kickback.cron';
import { PartnerProfileController } from './partner-profile.controller';
import { PartnerPublicController } from './partner-public.controller';
import { PartnerLeadsController } from './partner-leads.controller';
import { PartnerCustomersController } from './partner-customers.controller';
import { PartnerSalesController } from './partner-sales.controller';
import { PartnerReportingController } from './partner-reporting.controller';
import { PartnerOfficeController } from './partner-office.controller';
import { PartnerAdminController } from './partner-admin.controller';
import { PartnerCustomerQuotesController } from './partner-customer-quotes.controller';

@Module({
  imports: [
    LicensingModule,
    PermissionsModule,
    OnpremReleasesModule,
    InvitationsModule,
  ],
  controllers: [
    PartnerProfileController,
    PartnerPublicController,
    PartnerLeadsController,
    PartnerCustomersController,
    PartnerSalesController,
    PartnerReportingController,
    PartnerOfficeController,
    PartnerAdminController,
    PartnerCustomerQuotesController,
  ],
  providers: [
    PartnerRepository,
    PartnerProfileService,
    PartnerLeadsService,
    PartnerCustomersService,
    PartnerSalesService,
    PartnerReportingService,
    PartnerOfficeService,
    PartnerAdminService,
    PartnerKickbackCron,
  ],
})
export class PartnerModule {}
