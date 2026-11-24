import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiConsumes, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { Public } from '../../auth/decorators/public.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { PublicFormBuilderService } from './public-form-builder.service';
import { PublicFormBuilderSubmitDto } from './dto/public-form-builder.dto';
import { PublicFormPaymentSessionDto } from './dto/public-form-payment.dto';

/** Hard ceiling on the anonymous submit body, checked before the DTO is read. */
// 2 MB: signature/camera answers are inline data URIs allowed up to 300 KB each, which never fit 64 KB.
const MAX_CONTENT_LENGTH = 2 * 1024 * 1024;

/**
 * Standalone published forms: `/forms/{slug}`.
 *
 * Deliberately carries NO `@RequireFeature` and NO `@UseGuards`. `FeatureGuard`
 * throws on a missing `request.user` before the handler runs, so decorating this
 * controller with it would 403 every anonymous visitor. Entitlement is instead
 * resolved inside the service from the resolved form's organization, which is
 * both correct for an unauthenticated caller and impossible to spoof from the
 * request. `FormBuilderPaymentsController` establishes the same pattern.
 */
@ApiTags('Public Form Builder')
@Controller('public/forms')
export class PublicFormBuilderController {
  constructor(private readonly service: PublicFormBuilderService) {}

  @Public()
  @Get(':slug')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Fetch a published form by its public slug' })
  getDefinition(
    @Param('slug') slug: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.service.getDefinition(slug ?? '', user);
  }

  @Public()
  @Post(':slug/submit')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a published form' })
  submit(
    @Param('slug') slug: string,
    @Body() dto: PublicFormBuilderSubmitDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    @CurrentUser() user?: RequestUser,
  ) {
    const declaredLength = Number(contentLength);

    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_CONTENT_LENGTH
    ) {
      throw new BadRequestException('Submission payload too large');
    }

    return this.service.submit(slug ?? '', dto, ip, userAgent, user);
  }

  // 20/min, not the submit limit (10/min) — a single fill session can attach
  // several files while composing one answer, well before it ever submits.
  @Public()
  @Post(':slug/upload')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a file for a file_upload/audio field on a published form',
  })
  @ApiQuery({
    name: 'fieldKey',
    description: 'The field_key of the file_upload/audio field',
  })
  uploadFile(
    @Param('slug') slug: string,
    @Query('fieldKey') fieldKey: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user?: RequestUser,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    if (!fieldKey?.trim()) {
      throw new BadRequestException('fieldKey query param is required');
    }

    return this.service.uploadFile(slug ?? '', fieldKey.trim(), file, user);
  }
  //
  // Slug-addressed so the public page never needs a space or form id, and so every call runs the
  // same gate ladder as `getDefinition`/`submit` — the space-scoped payment routes do not.

  @Public()
  @Get(':slug/payment-config')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Non-secret payment config for a published form',
  })
  getPaymentConfig(
    @Param('slug') slug: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.service.getPaymentConfig(slug ?? '', user);
  }

  // Charging is far more expensive than reading, so it gets the submit limit, not the read one.
  @Public()
  @Post(':slug/checkout-session')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Open a Stripe Checkout session for a published form',
  })
  createPaymentSession(
    @Param('slug') slug: string,
    @Body() dto: PublicFormPaymentSessionDto,
    @Ip() ip: string,
    @Headers('content-length') contentLength: string | undefined,
    @Headers('origin') origin?: string,
    @CurrentUser() user?: RequestUser,
  ) {
    const declaredLength = Number(contentLength);

    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_CONTENT_LENGTH
    ) {
      throw new BadRequestException('Submission payload too large');
    }

    return this.service.createPaymentSession(slug ?? '', dto, user, origin, ip);
  }

  @Public()
  @Get(':slug/payment-status')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiQuery({ name: 'session_id', required: true })
  @ApiOperation({ summary: 'Poll payment state for a checkout session' })
  getPaymentStatus(
    @Param('slug') slug: string,
    @Query('session_id') sessionId: string,
    @CurrentUser() user?: RequestUser,
  ) {
    if (!sessionId) throw new BadRequestException('session_id is required');

    return this.service.getPaymentStatus(slug ?? '', sessionId, user);
  }
}
