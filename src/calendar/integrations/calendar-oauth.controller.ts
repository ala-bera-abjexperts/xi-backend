import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';

import { Public } from '../../auth/decorators/public.decorator';
import type { CalendarProvider } from './calendar-accounts.service';
import { CalendarAccountsService } from './calendar-accounts.service';
import { readState } from './calendar-oauth.state';
import { CalendarProvidersService } from './calendar-providers.service';

/**
 * Where a provider sends the person back after they approve access.
 *
 * Kept apart from the other calendar controllers, and without the licence decorator, because the
 * licence guard rejects a request that carries no signed-in user — which a provider callback never does.
 * The signed state is what proves who started the flow.
 */
@ApiExcludeController()
@Controller('calendar/oauth')
export class CalendarOauthController {
  constructor(
    private readonly accounts: CalendarAccountsService,
    private readonly providers: CalendarProvidersService,
  ) {}

  @Public()
  @Get(':provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const opened = readState(state);

    // Where they started, when the state carried it; the signature makes it untamperable and it is
    // only ever their own address. Without it, the configured default, exactly as before.
    const base =
      opened?.returnTo ?? process.env.FRONTEND_URL ?? process.env.APP_URL ?? '';
    const back = `${base.replace(/\/$/, '')}/calendar/integrations`;
    const fail = (reason: string) =>
      res.redirect(
        `${back}?connected=${encodeURIComponent(provider)}&error=${encodeURIComponent(reason)}`,
      );

    if (error) {
      fail(error);

      return;
    }

    if (!opened || !code) {
      fail('expired');

      return;
    }

    // The address someone came back to must be the one their sign-in started for.
    if (opened.provider !== provider) {
      fail('mismatch');

      return;
    }

    try {
      const api = this.providers.get(provider);
      const tokens = await api.exchangeCode(code, state);
      const who = await api.identity(tokens.accessToken);

      const saved = await this.accounts.save({
        organizationId: opened.organizationId,
        userId: opened.userId,
        provider: provider as CalendarProvider,
        externalAccountId: who.id || null,
        displayName: who.email,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
      });

      // One Zoom login per person: a different Zoom user replaces the one connected before.
      if (provider === 'zoom') {
        await this.accounts.keepOnly(saved, (_provider, token) =>
          api.revoke?.(token),
        );
      }

      res.redirect(`${back}?connected=${encodeURIComponent(provider)}`);
    } catch (failure) {
      fail(failure instanceof Error ? failure.message : 'failed');
    }
  }
}
