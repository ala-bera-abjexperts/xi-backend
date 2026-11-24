import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/decorators/public.decorator';
import { CreateFormPaymentSessionDto } from './dto/create-form-payment-session.dto';
import { FormBuilderPaymentsService } from './form-builder-payments.service';

// Form fillers may be anonymous, so these mirror the public Stripe funnel
// endpoints (@Public, no space-permission guard). The amount is recomputed
// server-side, so a public caller can never dictate the charge.
@ApiTags('form-builder-payments')
@Controller('spaces/:spaceId/forms/:formId/payments')
export class FormBuilderPaymentsController {
  constructor(private readonly service: FormBuilderPaymentsService) {}

  @Public()
  @Post('checkout-session')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create a Stripe Checkout session for a form payment',
  })
  async createCheckoutSession(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: CreateFormPaymentSessionDto,
    @Headers('origin') origin?: string,
  ) {
    return this.service.createCheckoutSession(spaceId, formId, dto, origin);
  }

  // Non-secret Stripe config for the anonymous fill page (enabled flag + publishable key).
  @Public()
  @Get('config')
  @ApiOperation({
    summary: 'Get the non-secret payment config for the fill page',
  })
  async getFillConfig(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
  ) {
    return this.service.getFillConfig(spaceId, formId);
  }

  @Public()
  @Get('status')
  @ApiOperation({
    summary: 'Get the status of a form payment checkout session',
  })
  @ApiQuery({ name: 'session_id', required: true, type: String })
  async getStatus(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Query('session_id') sessionId?: string,
  ) {
    if (!sessionId) {
      throw new BadRequestException('session_id is required');
    }

    return this.service.getStatus(spaceId, formId, sessionId);
  }
}
