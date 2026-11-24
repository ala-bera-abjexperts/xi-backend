/**
 * @fileoverview Public, unauthenticated REST controller for the
 * `git_branch_created` workflow trigger. A first-party git integration POSTs
 * `{ repository_id, branch }` (optionally signed with `x-workflow-signature`)
 * and every matching workflow transition is fired. Always returns 202 so
 * providers don't retry-storm; auth is the OPTIONAL HMAC
 * (`WORKFLOW_GIT_TRIGGER_SECRET`) — the route is intentionally not
 * platform-guarded, mirroring the inbound-webhook trigger.
 * @module src/git-triggers/git-triggers.controller
 * @author Ala Bera
 */

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { GitTriggersService } from './git-triggers.service';

@ApiTags('Git Triggers')
@Controller('git-triggers')
export class GitTriggersController {
  constructor(private readonly service: GitTriggersService) {}

  @Post('branch-created')
  @Public()
  // Always 202: the webhook is accepted and matching transitions fired; a git
  // provider must not retry on "nothing matched".
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Fire workflow transitions for a "git branch created" event',
  })
  @ApiResponse({
    status: 202,
    description: 'Accepted; count of transitions fired',
  })
  @ApiResponse({
    status: 400,
    description: 'Missing repository or branch in payload',
  })
  @ApiResponse({ status: 401, description: 'Invalid HMAC signature' })
  async branchCreated(
    @Body() payload: Record<string, unknown>,
    @Headers('x-workflow-signature') signature?: string,
  ): Promise<{ accepted: true; fired: number }> {
    return this.service.handleBranchCreated({ payload, signature });
  }

  @Post('pr-merged')
  @Public()
  // Always 202: the webhook is accepted and matching transitions fired; a git
  // provider must not retry on "nothing matched".
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Fire workflow transitions for a "git PR merged" event',
  })
  @ApiResponse({
    status: 202,
    description: 'Accepted; count of transitions fired',
  })
  @ApiResponse({
    status: 400,
    description: 'Missing repository or source branch in payload',
  })
  @ApiResponse({ status: 401, description: 'Invalid HMAC signature' })
  async prMerged(
    @Body() payload: Record<string, unknown>,
    @Headers('x-workflow-signature') signature?: string,
  ): Promise<{ accepted: true; fired: number }> {
    return this.service.handlePrMerged({ payload, signature });
  }

  @Post('github/events')
  @Public()
  // 204: signature-verified GitHub deliveries are accepted; only a bad/absent
  // signature returns 401 (so a misconfigured hook surfaces in GitHub's UI). Any
  // ignored event type still returns 204 so GitHub never retry-storms.
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Receive native GitHub webhook deliveries (branch created / PR merged)',
  })
  @ApiResponse({ status: 204, description: 'Accepted' })
  @ApiResponse({ status: 401, description: 'Invalid webhook signature' })
  async githubEvents(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-github-event') eventName?: string,
    @Headers('x-github-delivery') deliveryId?: string,
    @Headers('x-hub-signature-256') signature?: string,
  ): Promise<void> {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';

    await this.service.handleGithubEvent({
      eventName,
      deliveryId,
      signature,
      rawBody,
    });
  }
}
