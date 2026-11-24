/**
 * @fileoverview Partner sales endpoints (sub-ticket 4): license packages, quotes
 * (send/convert), invoices, and on-prem installs. Accepting a quote is NOT here -
 * it is the customer org's act, served by PartnerCustomerQuotesController.
 * @module src/partner/partner-sales.controller
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
import { RequirePartner } from '../auth/decorators/require-partner.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PartnerSalesService } from './partner-sales.service';
import {
  CreatePackageDto,
  CancelLicenceDto,
  CreateQuoteDto,
  UpdateInvoiceDto,
  UpdatePackageDto,
  UpdateQuoteDto,
} from './dto/partner.dto';
import {
  CreateOnpremInstallDto,
  OfflineLicenseDto,
  UpdateOnpremInstallDto,
} from '../onprem-releases/dto/onprem-installations.dto';
import {
  OnpremInstallationsService,
  type OnpremScope,
} from '../onprem-releases/onprem-installations.service';

@ApiTags('Partner Sales')
@ApiBearerAuth()
@RequirePartner()
@UseGuards(PermissionsGuard)
@Controller('partner')
export class PartnerSalesController {
  constructor(
    private readonly service: PartnerSalesService,
    private readonly installs: OnpremInstallationsService,
  ) {}

  // ── Packages ───────────────────────────────────────────────────────────────
  /** The XISUITE price list package rows are picked from (XE-T738). */
  @Get('resellable-items')
  @RequirePermissions('can_view_partner_licenses')
  listResellableItems() {
    return this.service.listResellableItems();
  }

  @Get('packages')
  @RequirePermissions('can_view_partner_licenses')
  listPackages(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize?: number,
  ) {
    return this.service.listPackages(user.organizationId, {
      status,
      search,
      page,
      pageSize,
    });
  }

  @Post('packages')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_partner_licenses')
  createPackage(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreatePackageDto,
  ) {
    return this.service.createPackage(user.organizationId, user.userId, dto);
  }

  @Get('packages/:packageId')
  @RequirePermissions('can_view_partner_licenses')
  getPackage(
    @CurrentUser() user: RequestUser,
    @Param('packageId', ParseUUIDPipe) packageId: string,
  ) {
    return this.service.getPackage(user.organizationId, packageId);
  }

  @Patch('packages/:packageId')
  @RequirePermissions('can_manage_partner_licenses')
  updatePackage(
    @CurrentUser() user: RequestUser,
    @Param('packageId', ParseUUIDPipe) packageId: string,
    @Body() dto: UpdatePackageDto,
  ) {
    return this.service.updatePackage(
      user.organizationId,
      user.userId,
      packageId,
      dto,
    );
  }

  @Delete('packages/:packageId')
  @RequirePermissions('can_manage_partner_licenses')
  deletePackage(
    @CurrentUser() user: RequestUser,
    @Param('packageId', ParseUUIDPipe) packageId: string,
  ) {
    return this.service.deletePackage(
      user.organizationId,
      user.userId,
      packageId,
    );
  }

  // ── Quotes ─────────────────────────────────────────────────────────────────
  @Get('quotes')
  @RequirePermissions('can_view_partner_quotes')
  listQuotes(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: string,
    @Query('customerId', new ParseUUIDPipe({ optional: true }))
    customerId?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize?: number,
    @Query('search') search?: string,
  ) {
    return this.service.listQuotes(user.organizationId, {
      status,
      customerId,
      page,
      pageSize,
      search,
    });
  }

  @Post('quotes')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_partner_quotes')
  createQuote(@CurrentUser() user: RequestUser, @Body() dto: CreateQuoteDto) {
    return this.service.createQuote(user.organizationId, user.userId, dto);
  }

  @Get('quotes/:quoteId')
  @RequirePermissions('can_view_partner_quotes')
  getQuote(
    @CurrentUser() user: RequestUser,
    @Param('quoteId', ParseUUIDPipe) quoteId: string,
  ) {
    return this.service.getQuote(user.organizationId, quoteId);
  }

  @Patch('quotes/:quoteId')
  @RequirePermissions('can_manage_partner_quotes')
  updateQuote(
    @CurrentUser() user: RequestUser,
    @Param('quoteId', ParseUUIDPipe) quoteId: string,
    @Body() dto: UpdateQuoteDto,
  ) {
    return this.service.updateQuote(
      user.organizationId,
      user.userId,
      quoteId,
      dto,
    );
  }

  @Post('quotes/:quoteId/send')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_partner_quotes')
  sendQuote(
    @CurrentUser() user: RequestUser,
    @Param('quoteId', ParseUUIDPipe) quoteId: string,
  ) {
    return this.service.transitionQuote(
      user.organizationId,
      user.userId,
      quoteId,
      'send',
    );
  }

  // There is deliberately NO partner-side accept route. Accepting commits ANOTHER
  // org to a licence + invoice, so it belongs to that org's admin alone - see
  // PartnerCustomerQuotesController (POST /organization/quotes/:quoteId/accept).

  @Post('quotes/:quoteId/convert')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_partner_quotes')
  convertQuote(
    @CurrentUser() user: RequestUser,
    @Param('quoteId', ParseUUIDPipe) quoteId: string,
  ) {
    return this.service.convertQuote(user.organizationId, user.userId, quoteId);
  }

  // ── Invoices ───────────────────────────────────────────────────────────────
  @Get('invoices')
  @RequirePermissions('can_view_partner_invoices')
  listInvoices(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: string,
    @Query('customerId', new ParseUUIDPipe({ optional: true }))
    customerId?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize?: number,
  ) {
    return this.service.listInvoices(user.organizationId, {
      status,
      customerId,
      page,
      pageSize,
    });
  }

  @Get('invoices/:invoiceId')
  @RequirePermissions('can_view_partner_invoices')
  getInvoice(
    @CurrentUser() user: RequestUser,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ) {
    return this.service.getInvoice(user.organizationId, invoiceId);
  }

  @Patch('invoices/:invoiceId')
  @RequirePermissions('can_manage_partner_invoices')
  updateInvoice(
    @CurrentUser() user: RequestUser,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body() dto: UpdateInvoiceDto,
  ) {
    return this.service.updateInvoice(
      user.organizationId,
      user.userId,
      invoiceId,
      dto,
    );
  }

  @Post('invoices/:invoiceId/mark-paid')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_partner_invoices')
  markInvoicePaid(
    @CurrentUser() user: RequestUser,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
  ) {
    return this.service.markInvoicePaid(
      user.organizationId,
      user.userId,
      invoiceId,
    );
  }

  // ── Licence lifecycle (audit P4) ───────────────────────────────────────────
  /** Draft renewal quote continuing the licence from its end date. */
  @Post('licenses/:licenseId/renewal-quote')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_partner_quotes')
  createRenewalQuote(
    @CurrentUser() user: RequestUser,
    @Param('licenseId', ParseUUIDPipe) licenseId: string,
  ) {
    return this.service.createRenewalQuote(
      user.organizationId,
      user.userId,
      licenseId,
    );
  }

  /** Draft upgrade quote, co-terminus with the licence (adds on top). */
  @Post('licenses/:licenseId/upgrade-quote')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_partner_quotes')
  createUpgradeQuote(
    @CurrentUser() user: RequestUser,
    @Param('licenseId', ParseUUIDPipe) licenseId: string,
  ) {
    return this.service.createUpgradeQuote(
      user.organizationId,
      user.userId,
      licenseId,
    );
  }

  @Post('licenses/:licenseId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_partner_licenses')
  cancelLicence(
    @CurrentUser() user: RequestUser,
    @Param('licenseId', ParseUUIDPipe) licenseId: string,
    @Body() dto: CancelLicenceDto,
  ) {
    return this.service.cancelLicence(
      user.organizationId,
      user.userId,
      licenseId,
      dto.mode,
    );
  }

  // ── On-prem ────────────────────────────────────────────────────────────────
  // Managed by the shared OnpremInstallationsService, scoped to this partner.
  @Get('onprem')
  @RequirePermissions('can_view_partner_licenses')
  listOnprem(@CurrentUser() user: RequestUser) {
    return this.installs.list(this.scope(user));
  }

  @Post('onprem')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_partner_licenses')
  createOnprem(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateOnpremInstallDto,
  ) {
    return this.installs.create(this.scope(user), user.userId, dto);
  }

  @Patch('onprem/:installId')
  @RequirePermissions('can_manage_partner_licenses')
  updateOnprem(
    @CurrentUser() user: RequestUser,
    @Param('installId', ParseUUIDPipe) installId: string,
    @Body() dto: UpdateOnpremInstallDto,
  ) {
    return this.installs.update(this.scope(user), user.userId, installId, dto);
  }

  @Post('onprem/:installId/rotate-code')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_partner_licenses')
  rotateOnpremCode(
    @CurrentUser() user: RequestUser,
    @Param('installId', ParseUUIDPipe) installId: string,
  ) {
    return this.installs.rotateCode(this.scope(user), user.userId, installId);
  }

  @Post('onprem/:installId/reset-fingerprint')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_partner_licenses')
  resetOnpremFingerprint(
    @CurrentUser() user: RequestUser,
    @Param('installId', ParseUUIDPipe) installId: string,
  ) {
    return this.installs.resetFingerprint(
      this.scope(user),
      user.userId,
      installId,
    );
  }

  /** Air-gapped: answer the box's request file with a 90-day licence file. */
  @Post('onprem/:installId/offline-license')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_partner_licenses')
  offlineOnpremLicense(
    @CurrentUser() user: RequestUser,
    @Param('installId', ParseUUIDPipe) installId: string,
    @Body() dto: OfflineLicenseDto,
  ) {
    return this.installs.offlineLicense(
      this.scope(user),
      installId,
      dto.request,
    );
  }

  private scope(user: RequestUser): OnpremScope {
    return { kind: 'partner', partnerOrgId: user.organizationId };
  }
}
