/**
 * @fileoverview Partner customers + their licenses (sub-ticket 4). Static
 * `/licenses` is declared before `/:customerId` so it isn't captured as an id.
 * @module src/partner/partner-customers.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
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
import { PartnerCustomersService } from './partner-customers.service';
import {
  CreateCustomerDto,
  ProvisionCustomerOrgDto,
  UpdateCustomerDto,
} from './dto/partner.dto';

@ApiTags('Partner Customers')
@ApiBearerAuth()
@RequirePartner()
@UseGuards(PermissionsGuard)
@Controller('partner/customers')
export class PartnerCustomersController {
  constructor(private readonly service: PartnerCustomersService) {}

  @Get()
  @RequirePermissions('can_view_partner_customers')
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

  @Get('licenses')
  @RequirePermissions('can_view_partner_licenses')
  listAllLicenses(
    @CurrentUser() user: RequestUser,
    @Query('active', new ParseBoolPipe({ optional: true })) active?: boolean,
  ) {
    return this.service.listAllLicenses(user.organizationId, {
      activeOnly: active === true,
    });
  }

  /**
   * Organizations this partner may link a customer to. Static path, so it is
   * declared before `/:customerId` for the same reason `/licenses` is.
   *
   * Requires the manage permission rather than the view one: the only reason to
   * read this list is to pick a value for a create/edit form.
   */
  @Get('linkable-organizations')
  @RequirePermissions('can_manage_partner_customers')
  listLinkableOrganizations(@CurrentUser() user: RequestUser) {
    return this.service.listLinkableOrganizations(user.organizationId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_partner_customers')
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateCustomerDto) {
    return this.service.create(user.organizationId, user.userId, dto);
  }

  @Get(':customerId')
  @RequirePermissions('can_view_partner_customers')
  get(
    @CurrentUser() user: RequestUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.service.getDetail(user.organizationId, customerId);
  }

  /** Create and link a NEW workspace for this customer, inviting its owner. */
  @Post(':customerId/provision-org')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_partner_customers')
  provisionOrg(
    @CurrentUser() user: RequestUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: ProvisionCustomerOrgDto,
  ) {
    return this.service.provisionOrg(
      user.organizationId,
      user.userId,
      customerId,
      dto,
    );
  }

  @Patch(':customerId')
  @RequirePermissions('can_manage_partner_customers')
  update(
    @CurrentUser() user: RequestUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.service.update(
      user.organizationId,
      user.userId,
      customerId,
      dto,
    );
  }

  @Delete(':customerId')
  @RequirePermissions('can_manage_partner_customers')
  remove(
    @CurrentUser() user: RequestUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.service.remove(user.organizationId, user.userId, customerId);
  }

  @Get(':customerId/licenses')
  @RequirePermissions('can_view_partner_licenses')
  listCustomerLicenses(
    @CurrentUser() user: RequestUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.service.listCustomerLicenses(user.organizationId, customerId);
  }
}
