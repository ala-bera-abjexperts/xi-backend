/**
 * @fileoverview Unauthenticated endpoints of the Git integrations: where GitHub / GitLab send the
 * admin back after approving access, and where they deliver webhooks.
 *
 * No licence decorator and no auth guard: a provider callback or delivery never carries a signed-in
 * user. What proves who started a connect flow is the signed OAuth `state`; what proves a delivery
 * is genuine is the GitHub HMAC signature, the per-repository GitLab token or the per-project Azure DevOps password.
 * Webhooks answer 204 for everything that verified (including ignored events) so providers never
 * retry-storm; only a failed verification answers 401. Azure DevOps also gets 410 and 503, see its service.
 * @module src/git-integrations/git-integrations-public.controller
 */

import {
  Controller,
  GoneException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { readState } from '../calendar/integrations/calendar-oauth.state';
import { GitIdentitiesService } from './git-identities.service';
import type { GitProvider } from './git-integrations.types';
import { GitProvidersRegistry } from './git-providers.registry';
import {
  hasStateSecret,
  integrationsPageUrl,
  parseIdentityStateTag,
} from './git-integrations.util';

@ApiExcludeController()
@Controller('git-integrations')
export class GitIntegrationsPublicController {
  constructor(
    private readonly providers: GitProvidersRegistry,
    private readonly identities: GitIdentitiesService,
  ) {}

  @Public()
  @Get('github/callback')
  async githubCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('installation_id') installationId: string | undefined,
    @Query('setup_action') setupAction: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // Without a real secret the state could be forged (see hasStateSecret); never read it.
    if (!hasStateSecret()) {
      res.redirect(
        integrationsPageUrl(undefined, 'github', { error: 'not_configured' }),
      );

      return;
    }

    const identity = await this.identityRedirect('github', state, code, error);

    if (identity) {
      res.redirect(identity);

      return;
    }

    res.redirect(
      await this.providers.github.handleCallback({
        code,
        state,
        installationId,
        setupAction,
        error,
      }),
    );
  }

  /**
   * Personal-account links (ticket 2) share the callback URL with the organization connect flow;
   * their signed state carries an identity tag. Null for every other state, which then goes to
   * the provider's own handler exactly as before.
   */
  private async identityRedirect(
    provider: GitProvider,
    state: string | undefined,
    code: string | undefined,
    error: string | undefined,
  ): Promise<string | null> {
    const opened = readState(state);
    const tag = opened ? parseIdentityStateTag(opened.provider) : null;

    if (!opened || !tag || tag.provider !== provider) return null;

    return this.identities.handleCallback({
      provider,
      page: tag.page,
      serverId: tag.serverId,
      userId: opened.userId,
      organizationId: opened.organizationId,
      returnTo: opened.returnTo,
      code,
      error,
      state,
    });
  }

  @Public()
  @Get('gitlab/callback')
  async gitlabCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!hasStateSecret()) {
      res.redirect(
        integrationsPageUrl(undefined, 'gitlab', { error: 'not_configured' }),
      );

      return;
    }

    const identity = await this.identityRedirect('gitlab', state, code, error);

    if (identity) {
      res.redirect(identity);

      return;
    }

    res.redirect(
      await this.providers.gitlab.handleCallback({ code, state, error }),
    );
  }

  @Public()
  @Get('azure_devops/callback')
  async azureDevopsCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!hasStateSecret()) {
      res.redirect(
        integrationsPageUrl(undefined, 'azure_devops', {
          error: 'not_configured',
        }),
      );

      return;
    }

    const identity = await this.identityRedirect(
      'azure_devops',
      state,
      code,
      error,
    );

    if (identity) {
      res.redirect(identity);

      return;
    }

    res.redirect(
      await this.providers.azureDevops.handleCallback({ code, state, error }),
    );
  }

  @Public()
  @Post('azure_devops/webhook/:hookId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async azureDevopsWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Param('hookId', ParseUUIDPipe) hookId: string,
    @Headers('authorization') authorization?: string,
  ): Promise<void> {
    const outcome = await this.providers.azureDevops.handleWebhook({
      hookId,
      authorization,
      rawBody: req.rawBody,
    });

    if (outcome === 'unauthorized')
      throw new UnauthorizedException('Invalid webhook password');
    if (outcome === 'gone') throw new GoneException();
    if (outcome === 'retry') throw new ServiceUnavailableException();
  }

  @Public()
  @Post('github/webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  async githubWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-github-event') event?: string,
    @Headers('x-github-delivery') deliveryId?: string,
    @Headers('x-hub-signature-256') signature?: string,
  ): Promise<void> {
    const outcome = await this.providers.github.handleWebhook({
      event,
      deliveryId,
      signature,
      rawBody: req.rawBody,
    });

    if (outcome === 'unauthorized')
      throw new UnauthorizedException('Invalid webhook signature');
  }

  /** An organization's own GitHub App on its server (ticket 11), verified with that server's secret. */
  @Public()
  @Post('github/webhook/:serverId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async githubServerWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Param('serverId', ParseUUIDPipe) serverId: string,
    @Headers('x-github-event') event?: string,
    @Headers('x-github-delivery') deliveryId?: string,
    @Headers('x-hub-signature-256') signature?: string,
  ): Promise<void> {
    const outcome = await this.providers.github.handleWebhook({
      event,
      deliveryId,
      signature,
      rawBody: req.rawBody,
      serverId,
    });

    if (outcome === 'unauthorized')
      throw new UnauthorizedException('Invalid webhook signature');
  }

  @Public()
  @Post('gitlab/webhook/:repositoryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async gitlabWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Param('repositoryId', ParseUUIDPipe) repositoryId: string,
    @Headers('x-gitlab-token') token?: string,
    @Headers('x-gitlab-event') event?: string,
    @Headers('x-gitlab-event-uuid') eventUuid?: string,
  ): Promise<void> {
    const outcome = await this.providers.gitlab.handleWebhook({
      repositoryId,
      token,
      event,
      eventUuid,
      rawBody: req.rawBody,
    });

    if (outcome === 'unauthorized')
      throw new UnauthorizedException('Invalid webhook token');
  }
}
