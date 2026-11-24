import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from '../auth/decorators/public.decorator';
import { AutomationConnectionsService } from './automation-connections.service';
import { packSecretForStorage } from '../lib/crypto/encryption';

@ApiExcludeController()
@Controller('auth/callback')
export class AutomationOAuthCallbackController {
  private readonly logger = new Logger(AutomationOAuthCallbackController.name);

  constructor(
    private readonly connectionsService: AutomationConnectionsService,
  ) {}

  @Public()
  @Get('automation-google')
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const apiUrl =
      process.env.AUTOMATIONS_PUBLIC_API_URL ??
      process.env.PUBLIC_API_URL ??
      'http://localhost:3001/api/v1';

    if (!code || !state) {
      res.redirect(`${appUrl}/error?msg=missing+code+or+state`);
      return;
    }

    const row = await this.connectionsService.consumeOAuthState(state);

    if (!row) {
      res.redirect(`${appUrl}/error?msg=invalid+state`);
      return;
    }
    if (new Date(row.expires_at) < new Date()) {
      res.redirect(`${appUrl}/error?msg=state+expired`);
      return;
    }
    if (row.consumed_at) {
      res.redirect(`${appUrl}/error?msg=state+already+used`);
      return;
    }
    if (row.provider !== 'google_calendar') {
      res.redirect(`${appUrl}/error?msg=provider+mismatch`);
      return;
    }

    const cb = `${apiUrl}/auth/callback/automation-google`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: cb,
      }),
    });

    if (!tokenRes.ok) {
      res.redirect(`${appUrl}/error?msg=google+token+exchange+failed`);
      return;
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      scope?: string;
    };

    const userRes = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
    );
    const userData = userRes.ok
      ? ((await userRes.json()) as {
          id?: string;
          email?: string;
          name?: string;
        })
      : {};

    await this.connectionsService.upsertOAuthConnection({
      stateId: row.id,
      organizationId: row.organization_id,
      spaceId: row.space_id,
      provider: 'google_calendar',
      displayName: userData.name ?? userData.email ?? 'Google Calendar',
      externalAccountId: userData.id ?? null,
      secret: tokenData.access_token,
      metadata: {
        email: userData.email,
        refresh_token: tokenData.refresh_token
          ? packSecretForStorage(tokenData.refresh_token)
          : null,
        scope: tokenData.scope,
      },
      createdBy: row.user_id,
    });

    // Redirect to this connection's own automations/connections page rather than trusting
    // return_to end-to-end — spaceId is validated/required at flow start, so resolving the
    // slug fresh here is more robust than depending on a frontend-supplied spaceKey.
    const spaceKey = await this.connectionsService.getSpaceKey(row.space_id);
    const target = spaceKey
      ? `/spaces/${spaceKey}/automations/connections`
      : (row.return_to ?? '/');
    const base = row.app_origin ?? appUrl;

    this.logger.log(
      `OAuth connect success — redirecting to ${base}${target} (spaceId=${row.space_id}, resolvedSpaceKey=${spaceKey ?? 'null'}, appOrigin=${row.app_origin ?? 'null'})`,
    );
    res.redirect(302, `${base}${target}`);
  }

  @Public()
  @Get('automation-slack')
  async slackCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const apiUrl =
      process.env.AUTOMATIONS_PUBLIC_API_URL ??
      process.env.PUBLIC_API_URL ??
      'http://localhost:3001/api/v1';

    if (!code || !state) {
      res.redirect(`${appUrl}/error?msg=missing+code+or+state`);
      return;
    }

    const row = await this.connectionsService.consumeOAuthState(state);

    if (!row) {
      res.redirect(`${appUrl}/error?msg=invalid+state`);
      return;
    }
    if (new Date(row.expires_at) < new Date()) {
      res.redirect(`${appUrl}/error?msg=state+expired`);
      return;
    }
    if (row.consumed_at) {
      res.redirect(`${appUrl}/error?msg=state+already+used`);
      return;
    }
    if (row.provider !== 'slack') {
      res.redirect(`${appUrl}/error?msg=provider+mismatch`);
      return;
    }

    const cb = `${apiUrl}/auth/callback/automation-slack`;

    const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID ?? '',
        client_secret: process.env.SLACK_CLIENT_SECRET ?? '',
        code,
        redirect_uri: cb,
      }),
    });

    const tokenData = (await tokenRes.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
      team?: { id: string; name: string };
      bot_user_id?: string;
      scope?: string;
      authed_user?: { id: string };
    };

    if (!tokenData.ok) {
      res.redirect(`${appUrl}/error?msg=slack+token+exchange+failed`);
      return;
    }

    const { access_token, team, bot_user_id, scope, authed_user } = tokenData;

    await this.connectionsService.upsertOAuthConnection({
      stateId: row.id,
      organizationId: row.organization_id,
      spaceId: row.space_id,
      provider: 'slack',
      displayName: team?.name ?? 'Slack',
      externalAccountId: team?.id ?? null,
      secret: access_token!,
      metadata: {
        team_name: team?.name,
        scopes: scope?.split(','),
        bot_user_id,
        authed_user_id: authed_user?.id,
      },
      createdBy: row.user_id,
    });

    // Redirect to this connection's own automations/connections page rather than trusting
    // return_to end-to-end — spaceId is validated/required at flow start, so resolving the
    // slug fresh here is more robust than depending on a frontend-supplied spaceKey.
    const spaceKey = await this.connectionsService.getSpaceKey(row.space_id);
    const target = spaceKey
      ? `/spaces/${spaceKey}/automations/connections`
      : (row.return_to ?? '/');
    const base = row.app_origin ?? appUrl;

    this.logger.log(
      `OAuth connect success — redirecting to ${base}${target} (spaceId=${row.space_id}, resolvedSpaceKey=${spaceKey ?? 'null'}, appOrigin=${row.app_origin ?? 'null'})`,
    );
    res.redirect(302, `${base}${target}`);
  }

  @Public()
  @Get('automation-notion')
  async notionCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
    const apiUrl =
      process.env.AUTOMATIONS_PUBLIC_API_URL ??
      process.env.PUBLIC_API_URL ??
      'http://localhost:3001/api/v1';

    if (!code || !state) {
      res.redirect(`${appUrl}/error?msg=missing+code+or+state`);
      return;
    }

    const row = await this.connectionsService.consumeOAuthState(state);

    if (!row) {
      res.redirect(`${appUrl}/error?msg=invalid+state`);
      return;
    }
    if (new Date(row.expires_at) < new Date()) {
      res.redirect(`${appUrl}/error?msg=state+expired`);
      return;
    }
    if (row.consumed_at) {
      res.redirect(`${appUrl}/error?msg=state+already+used`);
      return;
    }
    if (row.provider !== 'notion') {
      res.redirect(`${appUrl}/error?msg=provider+mismatch`);
      return;
    }

    const cb = `${apiUrl}/auth/callback/automation-notion`;
    const credentials = Buffer.from(
      `${process.env.NOTION_CLIENT_ID ?? ''}:${process.env.NOTION_CLIENT_SECRET ?? ''}`,
    ).toString('base64');

    const tokenRes = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: cb,
      }),
    });

    if (!tokenRes.ok) {
      res.redirect(`${appUrl}/error?msg=notion+token+exchange+failed`);
      return;
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      workspace_id?: string;
      workspace_name?: string;
      bot_id?: string;
    };

    await this.connectionsService.upsertOAuthConnection({
      stateId: row.id,
      organizationId: row.organization_id,
      spaceId: row.space_id,
      provider: 'notion',
      displayName: tokenData.workspace_name ?? 'Notion',
      externalAccountId: tokenData.workspace_id ?? null,
      secret: tokenData.access_token,
      metadata: {
        workspace_id: tokenData.workspace_id,
        workspace_name: tokenData.workspace_name,
        bot_id: tokenData.bot_id,
      },
      createdBy: row.user_id,
    });

    // Redirect to this connection's own automations/connections page rather than trusting
    // return_to end-to-end — spaceId is validated/required at flow start, so resolving the
    // slug fresh here is more robust than depending on a frontend-supplied spaceKey.
    const spaceKey = await this.connectionsService.getSpaceKey(row.space_id);
    const target = spaceKey
      ? `/spaces/${spaceKey}/automations/connections`
      : (row.return_to ?? '/');
    const base = row.app_origin ?? appUrl;

    this.logger.log(
      `OAuth connect success — redirecting to ${base}${target} (spaceId=${row.space_id}, resolvedSpaceKey=${spaceKey ?? 'null'}, appOrigin=${row.app_origin ?? 'null'})`,
    );
    res.redirect(302, `${base}${target}`);
  }
}
