import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { SubmitFormDto } from './dto/submit-form.dto';
import { SubmitService } from './submit.service';

@ApiTags('Site Studio — Submit')
@Controller('site-studio')
export class SubmitController {
  constructor(private readonly service: SubmitService) {}

  /**
   * Public endpoint — no auth required.
   * Called from published funnel pages by anonymous visitors.
   * Rate-limited to 20 requests per minute per IP (tighter than the default).
   */
  @Post('submit')
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit a contact form (public — no auth required)',
  })
  async publicSubmit(
    @Body() dto: SubmitFormDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Headers('x-forwarded-for') forwardedFor: string | undefined,
  ) {
    const clientIp = forwardedFor ? forwardedFor.split(',')[0].trim() : ip;
    const contact = await this.service.submitForm(
      dto,
      clientIp,
      userAgent,
      false,
    );

    return { data: contact };
  }

  /**
   * Authenticated endpoint — requires a valid session with `can_view_site_studio`.
   * Called from the editor's "Test Submission" flow.
   * Marks the contact row with is_test_submission=true and bypasses the
   * published-funnel check so editors can test forms before publishing.
   */
  @Post('contact-form/test')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_site_studio')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Test-submit a contact form (authenticated editor use)',
  })
  async testSubmit(
    @CurrentUser() _user: RequestUser,
    @Body() dto: SubmitFormDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Headers('x-forwarded-for') forwardedFor: string | undefined,
  ) {
    const clientIp = forwardedFor ? forwardedFor.split(',')[0].trim() : ip;
    const contact = await this.service.submitForm(
      dto,
      clientIp,
      userAgent,
      true,
    );

    return { data: contact };
  }
}
