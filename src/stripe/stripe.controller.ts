import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
  BadRequestException,
  type RawBodyRequest,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { StripeService } from './stripe.service';

@ImpersonationBlocked()
@ApiTags('Stripe')
@Controller('stripe')
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  @Get('products')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_site_studio')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List active Stripe products/prices for Site Studio',
  })
  async getProducts() {
    return this.stripeService.listProducts();
  }

  @Public()
  @Post('create-checkout-session')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create an embedded Stripe Checkout session' })
  async createCheckoutSession(
    @Body() dto: CreateCheckoutSessionDto,
    @Headers('origin') origin?: string,
  ) {
    return this.stripeService.createCheckoutSession(dto, origin);
  }

  @Public()
  @Get('checkout-status')
  @ApiOperation({ summary: 'Get Stripe Checkout session status' })
  @ApiQuery({ name: 'session_id', required: true, type: String })
  async getCheckoutStatus(@Query('session_id') sessionId?: string) {
    if (!sessionId) {
      throw new BadRequestException('session_id is required');
    }

    return this.stripeService.getCheckoutStatus(sessionId);
  }

  // Skip throttling — Stripe retries 4xx aggressively, so a 429 here would
  // cause Stripe to back off and eventually disable the webhook endpoint. The
  // sender is authenticated by the `stripe-signature` header check inside the
  // service, which is sufficient.
  @SkipThrottle()
  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Handle Stripe webhook events' })
  handleWebhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ) {
    return this.stripeService.handleWebhook(request.rawBody, signature);
  }
}
