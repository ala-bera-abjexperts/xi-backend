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
import { PublicFormSubmitDto } from './dto/public-form.dto';
import { PublicFormService } from './public-form.service';

/** Hard ceiling for the anonymous submit body, checked before the DTO is read. */
// 2 MB: signature/camera/multi_photo/spreadsheet answers are inline data URIs, which never fit 64 KB.
const MAX_CONTENT_LENGTH = 2 * 1024 * 1024;

/**
 * Anonymous access to a form-builder form embedded on a PUBLISHED Site Studio
 * funnel page (`formBuilderForm` element).
 *
 * Both routes are `@Public()` — every authorization decision is made inside
 * {@link PublicFormService}, which proves the form is genuinely embedded on the
 * given published funnel before serving or accepting anything.
 */
@ApiTags('Public Site Studio — Form Builder')
@Controller('public/site-studio')
export class PublicFormController {
  constructor(private readonly service: PublicFormService) {}

  @Public()
  @Get('form')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Sanitized definition of a form embedded on a published funnel page (public)',
  })
  @ApiQuery({ name: 'funnelId', required: true })
  @ApiQuery({ name: 'formId', required: true })
  @ApiQuery({ name: 'pageId', required: false })
  async getDefinition(
    @Query('funnelId') funnelId?: string,
    @Query('formId') formId?: string,
    @Query('pageId') pageId?: string,
    // Optionally present: on a @Public() route the guard attaches the caller only
    // when a valid Bearer is sent, so this is undefined for anonymous visitors.
    @CurrentUser() user?: RequestUser,
  ) {
    if (!funnelId || !formId) {
      throw new BadRequestException('funnelId and formId are required');
    }

    return this.service.getDefinition(
      funnelId,
      formId,
      pageId || undefined,
      user,
    );
  }

  // Separate from form-submit: a visitor uploads while composing an answer, long before submitting.
  @Public()
  @Post('form-upload')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Upload a file for a file_upload/audio field on an embedded form (public)',
  })
  @ApiQuery({ name: 'funnelId', required: true })
  @ApiQuery({ name: 'formId', required: true })
  @ApiQuery({ name: 'fieldKey', required: true })
  @ApiQuery({ name: 'pageId', required: false })
  uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Query('funnelId') funnelId?: string,
    @Query('formId') formId?: string,
    @Query('fieldKey') fieldKey?: string,
    @Query('pageId') pageId?: string,
    @CurrentUser() user?: RequestUser,
  ) {
    if (!file) throw new BadRequestException('File is required');

    if (!funnelId || !formId) {
      throw new BadRequestException('funnelId and formId are required');
    }

    if (!fieldKey?.trim()) {
      throw new BadRequestException('fieldKey query param is required');
    }

    return this.service.uploadFile(
      funnelId,
      formId,
      fieldKey.trim(),
      file,
      pageId || undefined,
      user,
    );
  }

  @Public()
  @Post('form-submit')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit an embedded form-builder form anonymously (public)',
  })
  async submit(
    @Body() dto: PublicFormSubmitDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Headers('content-length') contentLength: string | undefined,
    // Optionally present (see getDefinition) — used to authorize assignee-gated
    // forms and to attribute the submission to a signed-in assignee.
    @CurrentUser() user?: RequestUser,
  ) {
    const declaredLength = Number(contentLength);

    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_CONTENT_LENGTH
    ) {
      throw new BadRequestException('Submission payload too large');
    }

    // `@Ip()` is Express's `req.ip`, which resolves through the configured
    // `trust proxy` hop count (main.ts). Do NOT read X-Forwarded-For directly:
    // its leftmost entry is entirely client-supplied, so trusting it let a
    // caller mint a new rate-limit identity per request AND poisoned the
    // `ip_address` column that abuse response depends on.
    return this.service.submit(dto, ip, userAgent, user);
  }

  /**
   * Ticket a submission produced, polled by the success screen after a submit.
   *
   * Task creation runs after the submit response is written (see PublicFormService.submit), so the
   * key cannot travel in that response. `formId` is required as a second factor: a leaked submission
   * id on its own must not reveal a ticket key. Every unknown case returns the same shape rather
   * than a 404, so probing reveals nothing.
   *
   * Polled rather than submitted, hence the higher limit than `form-submit` — several visitors can
   * share one NAT address.
   */
  @Public()
  @Get('form-submit/:submissionId/ticket')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Ticket created by an embedded form submission (public)',
  })
  @ApiQuery({ name: 'formId', required: true })
  async submissionTicket(
    @Param('submissionId') submissionId: string,
    @Query('formId') formId: string,
    // Optionally present (see getDefinition). Only a signed-in caller is given the space key,
    // since only they can open the in-app task page.
    @CurrentUser() user?: RequestUser,
  ) {
    return this.service.getSubmissionTicket(
      submissionId,
      formId ?? '',
      user?.userId ?? null,
    );
  }
}
