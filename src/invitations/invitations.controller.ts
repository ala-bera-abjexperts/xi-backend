/**
 * @fileoverview Controller for managing organization invitations. Exposes endpoints for creating,
 * listing, looking up, accepting, resending, and deleting invitations. Most endpoints require
 * authentication and the `can_invite_users` permission; acceptance and token lookup are public.
 * @module src/invitations/invitations.controller
 * @author Prince Jadiya
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
  Logger,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { InvitationsService } from './invitations.service';
import { MailService } from '../mail/mail.service';
import { rethrowEmailSendFailure } from '../mail/mail-failure.util';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import {
  readCookieConfig,
  setActiveOrgCookie,
  setAuthCookies,
} from '../auth/cookies.util';

/**
 * Controller for the `/invitations` route prefix. Manages the full lifecycle
 * of organization invitations: create, list, lookup, accept, resend, and delete.
 *
 * @example
 * // Injected via InvitationsModule:
 * constructor(
 *   private readonly invitationsService: InvitationsService,
 *   private readonly mailService: MailService,
 * ) {}
 */
@ApiTags('Invitations')
@Controller('invitations')
export class InvitationsController {
  /** @private Logger instance scoped to this controller */
  private readonly logger = new Logger(InvitationsController.name);

  /**
   * @param {InvitationsService} invitationsService - Service for invitation CRUD operations
   * @param {MailService} mailService - Email delivery service for sending invitation emails
   */
  constructor(
    private readonly invitationsService: InvitationsService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Creates an organization invitation, generates a secure link, and sends an invitation email.
   *
   * @param {RequestUser} user - The authenticated user creating the invitation
   * @param {CreateInvitationDto} body - The invitation details (email, name, role)
   * @returns {Promise<object>} Success message and invitation summary
   * @throws {BadRequestException} When the user already exists or an invitation is already pending
   * @throws {ForbiddenException} When the user lacks `can_invite_users` permission
   */
  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_invite_users')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create organization invitation',
    description:
      'Invites a new user to the organization. Requires `can_invite_users` permission. Generates a secure token, creates the invitation record, and sends an email.',
  })
  @ApiResponse({
    status: 200,
    description: 'Invitation created and email sent',
  })
  @ApiResponse({
    status: 400,
    description: 'User already exists or invitation already pending',
  })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({
    status: 503,
    description:
      'Invitation email could not be sent (code: email_send_failed) — the invitation is kept; use resend once mail delivery is fixed',
  })
  async createInvitation(
    @CurrentUser() user: RequestUser,
    @Body() body: CreateInvitationDto,
  ) {
    const role = body.role || 'member';

    const result = await this.invitationsService.createOrgInvitation({
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
      organizationId: user.organizationId,
      role,
      invitedByUserId: user.userId,
    });

    try {
      await this.mailService.sendInvitation(body.email, {
        invitationLink: result.invitationLink,
        organizationName: result.organizationName,
        firstName: body.firstName,
        lastName: body.lastName,
        role,
      });
    } catch (err) {
      // The invitation row is kept — the resend endpoint re-sends it once SMTP
      // is fixed, so surface a clear 503 instead of an opaque 500.
      rethrowEmailSendFailure(this.logger, 'create-invitation email', err);
    }

    return {
      message: 'Invitation sent successfully',
      invitation: {
        id: result.invitation.id,
        email: body.email,
        role,
        organization: result.organizationName,
        expires_at: result.invitation.expires_at,
      },
    };
  }

  /**
   * Returns a paginated list of invitations for the current user's organization.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} [page] - Page number (default: 1)
   * @param {string} [limit] - Items per page (default: 50, max: 100)
   * @returns {Promise<object>} Paginated invitation list with total count
   */
  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_invite_users')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List organization invitations',
    description:
      "Returns a paginated list of all invitations for the current user's organization. Requires `can_invite_users` permission.",
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default: 50, max: 100)',
  })
  @ApiResponse({ status: 200, description: 'Paginated invitation list' })
  async listInvitations(
    @CurrentUser() user: RequestUser,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const { data, ...meta } = await this.invitationsService.listInvitations(
      user.organizationId,
      parseInt(page || '1', 10),
      parseInt(limit || '50', 10),
    );
    return { data, ...meta };
  }

  /**
   * Lists pending org-level invitations matching the current user's email.
   *
   * Used by the onboarding empty-state to surface invitations a brand-new
   * signup may have waiting. Filters: status='pending', space_id IS NULL
   * (org-level only; space invites surface elsewhere), expires_at > now().
   *
   * Returns invitation metadata (org name/slug, inviter, role, expiry) but
   * NOT the secure token — tokens stay email-only. Users complete acceptance
   * via the link in the email.
   *
   * @param {RequestUser} user - The authenticated user
   * @returns {Promise<object[]>} Pending org-level invitations for this email
   */
  @Get('mine')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List pending org-level invitations for the current user',
    description:
      "Returns pending, non-expired, org-level invitations matching the authenticated user's email. Used by the onboarding empty-state. Does NOT return tokens (security).",
  })
  @ApiResponse({ status: 200, description: 'Pending invitations array' })
  async listForCurrentUser(@CurrentUser() user: RequestUser) {
    return this.invitationsService.listPendingForEmail(user.email);
  }

  /**
   * Public endpoint to look up an invitation by its secure token.
   * Used by the frontend accept-invitation page.
   *
   * @param {string} token - The secure invitation token from the email link
   * @returns {Promise<object>} Invitation details with organization and space names
   * @throws {BadRequestException} When no token is provided
   * @throws {NotFoundException} When no invitation matches the token
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Get('by-token')
  @ApiOperation({
    summary: 'Look up invitation by token',
    description:
      'Public endpoint to retrieve invitation details by the secure token. Used by the frontend accept-invitation page. Rate-limited to 10 req/min.',
  })
  @ApiQuery({
    name: 'token',
    required: true,
    type: String,
    description: 'The secure invitation token from the email link',
  })
  @ApiResponse({
    status: 200,
    description: 'Invitation details with organization and space names',
  })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async getByToken(@Query('token') token: string) {
    if (!token) {
      throw new BadRequestException('Token is required');
    }
    return this.invitationsService.getByToken(token);
  }

  /**
   * Accepts a pending invitation using the secure token.
   *
   * @param {string} id - The invitation UUID
   * @param {AcceptInvitationDto} body - The request body containing the invitation token
   * @returns {Promise<{ success: boolean }>}
   * @throws {NotFoundException} When the invitation is not found
   * @throws {ForbiddenException} When the token does not match
   * @throws {BadRequestException} When the invitation is expired or no longer pending
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept an invitation',
    description:
      'Accepts a pending invitation using the secure token. For space invitations, creates the space membership and applies custom permissions. Also syncs notification status. Rate-limited to 10 req/min.',
  })
  @ApiParam({ name: 'id', description: 'Invitation UUID' })
  @ApiResponse({ status: 200, description: 'Invitation accepted successfully' })
  @ApiResponse({
    status: 400,
    description: 'Invitation expired or no longer pending',
  })
  @ApiResponse({ status: 403, description: 'Invalid invitation token' })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async acceptInvitation(
    @Param('id') id: string,
    @Body() body: AcceptInvitationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.invitationsService.acceptInvitation(
      id,
      body.token,
      body.password,
    );

    const cfg = readCookieConfig(this.configService);

    if (result.tokens) {
      setAuthCookies(res, result.tokens, cfg);
    }

    // Pin the joined org as the active tenant so the destination subdomain
    // recognises the membership without bouncing through select-tenant.
    // Require both id and slug before writing — an orphan id (no slug) would
    // pin active_org_id to a non-resolvable tenant on the next request.
    if (result.organization?.id && result.organization.slug) {
      setActiveOrgCookie(res, result.organization.id, cfg);
    }

    return {
      success: result.success,
      alreadyAccepted: result.alreadyAccepted ?? false,
      organization: result.organization,
    };
  }

  /**
   * Resends an invitation email with a new token and extended expiry.
   *
   * @param {string} id - The invitation UUID
   * @param {RequestUser} user - The authenticated user
   * @returns {Promise<{ message: string }>} Success message
   * @throws {NotFoundException} When the invitation is not found
   * @throws {ForbiddenException} When the invitation belongs to a different organization
   * @throws {BadRequestException} When the invitation is already accepted
   */
  @Post(':id/resend')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_invite_users')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Resend invitation email',
    description:
      'Generates a new secure token, updates the expiry to 7 days, and resends the invitation email. Requires `can_invite_users` permission.',
  })
  @ApiParam({ name: 'id', description: 'Invitation UUID' })
  @ApiResponse({ status: 200, description: 'Invitation resent successfully' })
  @ApiResponse({
    status: 503,
    description:
      'Invitation email could not be sent (code: email_send_failed) — retry resend once mail delivery is fixed',
  })
  @ApiResponse({ status: 400, description: 'Invitation already accepted' })
  @ApiResponse({ status: 403, description: 'Wrong organization' })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async resendInvitation(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    const result = await this.invitationsService.resendInvitation(
      id,
      user.organizationId,
    );

    const inv = result.invitation as Record<string, string>;
    try {
      await this.mailService.sendInvitation(inv.email, {
        invitationLink: result.invitationLink,
        organizationName: result.organizationName,
        firstName: inv.first_name || '',
        lastName: inv.last_name || '',
        role: inv.role || 'member',
      });
    } catch (err) {
      rethrowEmailSendFailure(this.logger, 'resend-invitation email', err);
    }

    return { message: 'Invitation resent successfully' };
  }

  /**
   * Revokes a pending invitation while preserving the audit trail.
   *
   * @param {string} id - The invitation UUID
   * @param {RequestUser} user - The authenticated user
   * @returns {Promise<object>} The revoked invitation row
   * @throws {NotFoundException} When the invitation is not found
   * @throws {ForbiddenException} When the invitation belongs to a different organization
   * @throws {BadRequestException} When the invitation has already been accepted
   */
  @Post(':id/revoke')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_invite_users')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Revoke an invitation',
    description:
      'Marks a pending invitation as revoked. Requires `can_invite_users` permission.',
  })
  @ApiParam({ name: 'id', description: 'Invitation UUID' })
  @ApiResponse({ status: 200, description: 'Invitation revoked' })
  @ApiResponse({ status: 400, description: 'Invitation already accepted' })
  @ApiResponse({ status: 403, description: 'Wrong organization' })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async revokeInvitation(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.invitationsService.revokeInvitation(
      id,
      user.organizationId,
      user.userId,
    );
  }

  /**
   * Permanently deletes an invitation.
   *
   * @param {string} id - The invitation UUID
   * @param {RequestUser} user - The authenticated user
   * @returns {Promise<{ success: boolean }>}
   * @throws {NotFoundException} When the invitation is not found
   * @throws {ForbiddenException} When the invitation belongs to a different organization
   */
  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_invite_users')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete an invitation',
    description:
      'Permanently deletes a pending or expired invitation. Requires `can_invite_users` permission.',
  })
  @ApiParam({ name: 'id', description: 'Invitation UUID' })
  @ApiResponse({ status: 200, description: 'Invitation deleted' })
  @ApiResponse({ status: 403, description: 'Wrong organization' })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async deleteInvitation(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.invitationsService.deleteInvitation(
      id,
      user.organizationId,
      user.userId,
    );
  }
}
