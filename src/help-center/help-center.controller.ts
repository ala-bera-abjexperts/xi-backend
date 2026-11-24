/**
 * @fileoverview Help Center controller — support request endpoints.
 * All routes are authenticated via the global SupabaseAuthGuard.
 * Users can read and act on their own tickets AND tickets shared with them
 * (`support_request_shares`); anything else is a 404, never a 403 — see
 * `HelpCenterRepository.findVisible`.
 * @module src/help-center/help-center.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { HelpCenterService } from './help-center.service';
import { CreateSupportRequestDto } from './dto/create-support-request.dto';
import { ListSupportRequestsQueryDto } from './dto/list-support-requests-query.dto';
import { AddSupportRequestCommentDto } from './dto/add-support-request-comment.dto';
import { ShareSupportRequestDto } from './dto/share-support-request.dto';
import {
  ExecuteSupportRequestTransitionDto,
  SupportRequestTransitionsQueryDto,
} from './dto/support-request-transition.dto';
import { SubmitFormRequestDto } from './dto/submit-form-request.dto';

@ApiTags('Help Center')
@ApiBearerAuth()
@Controller('help-center/support-requests')
export class HelpCenterController {
  constructor(private readonly service: HelpCenterService) {}

  @Get(':id/replies')
  @ApiOperation({ summary: 'Staff replies published for a support request' })
  getReplies(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getReplies(id, user.userId);
  }

  @Get(':id/activity')
  @ApiOperation({
    summary:
      'Combined reply / comment / status-change timeline for a support request',
  })
  getActivity(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getActivity(id, user.userId);
  }

  @Post(':id/comments')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Add a customer-portal comment' })
  addComment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddSupportRequestCommentDto,
  ) {
    return this.service.addComment(id, user.userId, dto.content);
  }

  @Get(':id/shares')
  @ApiOperation({
    summary: 'List creator + shared users for a support request',
  })
  listShares(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.listShares(id, user.userId);
  }

  @Post(':id/shares')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Share a support request by email. Always 204 — never confirms whether the email has an account',
  })
  async share(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ShareSupportRequestDto,
  ): Promise<void> {
    await this.service.share(id, user.userId, dto.email);
  }

  @Delete(':id/shares/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a shared user (creator, or self-removal)' })
  async unshare(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.service.unshare(id, user.userId, userId);
  }

  @Get(':id/transitions')
  @ApiOperation({
    summary:
      'Status transitions the published ticket-list block lets the customer make',
  })
  listTransitions(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: SupportRequestTransitionsQueryDto,
  ) {
    return this.service.listTransitions(id, user, query);
  }

  @Post(':id/transitions')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Execute an offered status transition; returns the updated request',
  })
  executeTransition(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExecuteSupportRequestTransitionDto,
  ) {
    return this.service.executeTransition(id, user, dto);
  }

  @Get(':id/form-requests')
  @ApiOperation({ summary: 'Forms staff have asked the customer to fill' })
  listFormRequests(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.listFormRequests(id, user.userId);
  }

  @Post(':id/form-requests/:frId/submit')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Submit a pending staff-requested form' })
  submitFormRequest(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('frId', ParseUUIDPipe) frId: string,
    @Body() dto: SubmitFormRequestDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.service.submitFormRequest(id, user.userId, frId, dto.data, {
      ip,
      userAgent,
    });
  }

  @Post(':id/task')
  retryTask(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.retryTask(id, user);
  }

  /**
   * GET /api/v1/help-center/support-requests
   *
   * Returns support requests visible to the authenticated user (creator or
   * shared, per `scope`), newest first by default. Supports filtering, search
   * and pagination — see `ListSupportRequestsQueryDto`.
   */
  @Get()
  @ApiOperation({ summary: "List the current user's support requests" })
  listMyRequests(
    @CurrentUser() user: RequestUser,
    @Query() query: ListSupportRequestsQueryDto,
  ) {
    return this.service.listMyRequests(user.userId, query);
  }

  /**
   * POST /api/v1/help-center/support-requests
   *
   * Creates a new support request for the current user's active tenant.
   * Returns 201 with the created ticket (including auto-generated ticket_number).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new support request' })
  createSupportRequest(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateSupportRequestDto,
  ) {
    const organizationId =
      user.organizationId || user.memberships[0]?.organizationId || '';

    return this.service.createSupportRequest(organizationId, user.userId, dto);
  }

  /**
   * GET /api/v1/help-center/support-requests/:id
   *
   * Returns a single enriched support request by UUID, plus the caller's
   * viewer_role. Returns 404 if the ticket is not visible to the caller
   * (not the creator and not shared with them).
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get a single support request by ID' })
  getRequest(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getRequest(id, user.userId);
  }
}
