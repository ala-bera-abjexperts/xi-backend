/**
 * @fileoverview HTTP surface for Super-Admin impersonation under
 * `/admin/impersonation`. Start/active/history require Super-Admin authority;
 * stop deliberately does not (its path is in the guard's impersonation-bypass
 * list, so the caller is always the SA's real context, and stop must succeed
 * even if the row was already revoked server-side).
 *
 * The raw session token never appears in a response body — it is written only
 * as an HttpOnly cookie via {@link setImpersonationCookie}.
 *
 * @module src/impersonation/impersonation.controller
 * @author Prince Jadiya
 */

import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';

import { RequireSuperAdmin } from '../auth/decorators/require-super-admin.decorator';
import { AllowWithoutSso } from '../auth/decorators/allow-without-sso.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  clearImpersonationCookie,
  clearImpersonationReturnToCookie,
  readCookieConfig,
  readImpersonationCookie,
  setImpersonationCookie,
  setImpersonationReturnToCookie,
} from '../auth/cookies.util';
import { ImpersonationService } from './impersonation.service';
import { StartImpersonationDto } from './dto/start-impersonation.dto';
import { ImpersonationHistoryQueryDto } from './dto/impersonation-history-query.dto';

const DEFAULT_DURATION_MINUTES = 30;

@ApiTags('Admin Impersonation')
@ApiBearerAuth()
@AllowWithoutSso()
@Controller('admin/impersonation')
export class ImpersonationController {
  constructor(
    private readonly service: ImpersonationService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Starts an impersonation session and writes the session cookie.
   */
  @Post('start')
  @RequireSuperAdmin()
  @UseGuards(SuperAdminGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async start(
    @Body() body: StartImpersonationDto,
    @CurrentUser() user: RequestUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{
    data: unknown;
    expiresAt: string;
    target: { slug: string; tenantName: string; userEmail: string };
  }> {
    // Defensive: a real SA context never carries an impersonation overlay here
    // (the path is in the guard's bypass list), but reject if it somehow does.
    if (user.impersonation) {
      throw new ConflictException('Already impersonating — stop first');
    }

    const result = await this.service.start(
      user.userId,
      user.authUserId,
      user.email,
      body,
      {
        ip: req.ip ?? req.socket?.remoteAddress,
        userAgent: req.headers['user-agent'],
      },
    );

    const cookieCfg = readCookieConfig(this.configService);

    setImpersonationCookie(
      res,
      result.token,
      cookieCfg,
      (body.durationMinutes ?? DEFAULT_DURATION_MINUTES) * 60,
    );
    setImpersonationReturnToCookie(
      res,
      body.returnTo ?? '',
      cookieCfg,
      (body.durationMinutes ?? DEFAULT_DURATION_MINUTES) * 60,
    );

    return {
      data: result.session,
      expiresAt: result.expiresAt,
      target: {
        slug: result.targetSlug,
        tenantName: result.targetTenantName,
        userEmail: result.targetUserEmail,
      },
    };
  }

  /**
   * Stops the active impersonation session (if any) and clears the cookie.
   * Always clears the cookie, even when no server-side session was found.
   */
  @Post('stop')
  @HttpCode(HttpStatus.OK)
  async stop(
    @CurrentUser() user: RequestUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: { stopped: true } }> {
    const cookieCfg = readCookieConfig(this.configService);
    const cookie = readImpersonationCookie(
      req.cookies as Record<string, string | undefined> | undefined,
    );

    if (cookie) {
      await this.service.stopByToken(cookie, 'user_stopped');
    }

    clearImpersonationCookie(res, cookieCfg);
    clearImpersonationReturnToCookie(res, cookieCfg);

    return { data: { stopped: true } };
  }

  /**
   * Returns the SA's active session, or null.
   */
  @Get('active')
  @RequireSuperAdmin()
  @UseGuards(SuperAdminGuard)
  async active(@CurrentUser() user: RequestUser): Promise<{ data: unknown }> {
    return { data: await this.service.getActiveForSuperAdmin(user.userId) };
  }

  /**
   * Lists impersonation history with filters and pagination.
   */
  @Get('history')
  @RequireSuperAdmin()
  @UseGuards(SuperAdminGuard)
  async history(
    @Query() query: ImpersonationHistoryQueryDto,
  ): Promise<{ data: unknown[]; total: number }> {
    return this.service.listHistory(query);
  }
}
