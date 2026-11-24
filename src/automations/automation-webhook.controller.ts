import {
  Controller,
  Post,
  Param,
  Req,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { AutomationWebhookService } from './automation-webhook.service';

@ApiTags('Automation Webhooks')
@Controller('webhooks/automation')
export class AutomationWebhookController {
  constructor(private readonly webhookService: AutomationWebhookService) {}

  @Post(':token')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({
    summary: 'Receive inbound webhook for an automation',
    description:
      'Public endpoint — no auth required. Identified by the automation `webhook_token`. ' +
      'Validates the token, enforces per-second and per-hour rate limits, ' +
      'verifies the optional HMAC/bearer signature, logs the delivery, ' +
      'creates a run record, and enqueues the first execution steps. ' +
      'Always returns 200 once the automation is found — the response body ' +
      'carries `runId` on success or a `status` field explaining why no run was created.',
  })
  @ApiParam({
    name: 'token',
    description: 'Automation webhook token (min 16 chars)',
  })
  @ApiResponse({
    status: 200,
    description:
      '`{ received: true, runId }` on success; `{ received: true, status }` if no published version or run failed',
  })
  @ApiResponse({ status: 400, description: 'Token missing or too short' })
  @ApiResponse({
    status: 404,
    description: 'No published automation with this token',
  })
  @ApiResponse({
    status: 413,
    description: 'Request body exceeds size limit',
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded for this token',
  })
  async receiveWebhook(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Raw body is attached by express.raw() middleware in main.ts.
    // Falls back to stringified body if middleware not applied.
    const rawBody: string =
      typeof (req as Request & { rawBody?: unknown }).rawBody === 'string'
        ? ((req as Request & { rawBody?: string }).rawBody as string)
        : typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body ?? '');

    // Convert headers to a plain string→string record
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ');
      }
    }

    const result = await this.webhookService.receive(token, rawBody, headers);

    // Bypass the global ResponseInterceptor — return raw JSON matching the
    // source app's response shape exactly.
    return res.status(result.status).json(result.body);
  }
}
