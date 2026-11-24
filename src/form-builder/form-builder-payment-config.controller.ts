import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { FormBuilderPaymentConfigService } from './form-builder-payment-config.service';
import { SavePaymentConfigDto } from './dto/save-payment-config.dto';
import { CreateStripeProductDto } from './dto/create-stripe-product.dto';

// Per-space Stripe connection, configured from the form-builder Integrations tab.
// Not form-scoped (one config per space), so it does NOT use the form-scoped SpaceOrgInterceptor —
// the org comes from the authenticated user (mirrors the integrations controller).
@RequireFeature('module_form_builder')
@ApiTags('form-builder')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/payment-config')
export class FormBuilderPaymentConfigController {
  constructor(private readonly service: FormBuilderPaymentConfigService) {}

  @Get()
  @RequireSpacePermission('manage_forms')
  @ApiOperation({
    summary: 'Get the space’s Stripe connection (secrets redacted)',
  })
  async get(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getConfig({ spaceId, orgId: user.organizationId });
  }

  // Import the connected Stripe account's catalog into the products element.
  @Get('stripe/products')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({
    summary: 'List the connected Stripe account’s active products',
  })
  async listStripeProducts(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listStripeProducts({
      spaceId,
      orgId: user.organizationId,
    });
  }

  // Push a product defined in the builder to Stripe.
  @Post('stripe/products')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({
    summary: 'Create a product + price in the connected Stripe account',
  })
  async createStripeProduct(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateStripeProductDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.createStripeProduct(
      { spaceId, orgId: user.organizationId },
      dto,
    );
  }

  @Put()
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'Connect / update the space’s Stripe credentials' })
  async save(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: SavePaymentConfigDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.saveConfig(
      { spaceId, orgId: user.organizationId },
      dto,
      user.userId,
    );
  }
}
