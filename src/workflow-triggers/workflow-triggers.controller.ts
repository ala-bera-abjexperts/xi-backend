/**
 * @fileoverview Public, unauthenticated REST controller for inbound workflow
 * webhooks. Resolves the target transition by per-trigger shared secret,
 * verifies the optional HMAC signature, and forwards execution to the
 * workflow runtime engine. The endpoint is intentionally NOT guarded by
 * the platform auth guard — the trigger's shared secret IS the auth.
 * @module src/workflow-triggers/workflow-triggers.controller
 * @author Rajbha Manek
 */

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { WorkflowTriggersService } from './workflow-triggers.service';

@ApiTags('Workflow Triggers')
@Controller('workflow-triggers')
export class WorkflowTriggersController {
  constructor(private readonly service: WorkflowTriggersService) {}

  @Post('inbound/:secret')
  @Public()
  // NestJS defaults POST handlers to 201 Created; we return 202 Accepted because
  // the engine execution is enqueued (idempotent via execution_id) rather than
  // synchronously creating a resource. The @ApiResponse decorator below
  // documents this contract; @HttpCode enforces it at runtime.
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Inbound webhook entry point for workflow trigger fired externally',
  })
  @ApiParam({
    name: 'secret',
    description: 'Per-trigger shared secret (resolves the target transition)',
  })
  @ApiResponse({
    status: 202,
    description: 'Webhook accepted; execution queued',
  })
  @ApiResponse({ status: 401, description: 'Invalid HMAC signature' })
  @ApiResponse({
    status: 404,
    description: 'No active trigger configured for this secret',
  })
  @ApiResponse({
    status: 410,
    description: "Trigger's workflow is archived or no longer active",
  })
  @ApiResponse({
    status: 503,
    description: 'Engine runtime not available (P6 not yet deployed)',
  })
  async inbound(
    @Param('secret') secret: string,
    @Body() payload: Record<string, unknown>,
    @Headers('x-workflow-signature') signature?: string,
  ): Promise<{ accepted: true; execution_id: string }> {
    return this.service.handleInbound({ secret, payload, signature });
  }
}
