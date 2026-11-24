import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../decorators/public.decorator';
import { ImpersonationBlocked } from '../decorators/impersonation-blocked.decorator';
import { AllowWithoutSso } from '../decorators/allow-without-sso.decorator';
import {
  clearMfaPendingCookie,
  readCookieConfig,
  setAuthCookies,
  setMfaPendingCookie,
} from '../cookies.util';
import {
  RenamePasskeyDto,
  VerifyPasskeyAuthenticationDto,
  VerifyPasskeyRegistrationDto,
} from './dto/passkeys.dto';
import { PasskeysService } from './passkeys.service';

function readAccessToken(req: Request): string {
  const [type, headerToken] = req.headers.authorization?.split(' ') ?? [];
  if (type === 'Bearer' && headerToken) return headerToken;
  const cookieToken = readRequestCookie(req, 'access_token');
  if (!cookieToken) throw new BadRequestException('access_token missing');
  return cookieToken;
}

function readRequestCookie(req: Request, name: string): string | undefined {
  const rawCookies = (req as unknown as { cookies?: unknown }).cookies;
  if (
    !rawCookies ||
    typeof rawCookies !== 'object' ||
    Array.isArray(rawCookies)
  ) {
    return undefined;
  }

  const value = (rawCookies as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

@ApiTags('Passkeys')
@ApiBearerAuth()
@AllowWithoutSso()
@Controller('auth/passkeys')
export class PasskeysController {
  constructor(
    private readonly passkeysService: PasskeysService,
    private readonly configService: ConfigService,
  ) {}

  @ImpersonationBlocked()
  @Post('registration/options')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async startRegistration(@Req() req: Request) {
    return this.passkeysService.startRegistration(
      readAccessToken(req),
      this.readOrigin(req),
    );
  }

  @ImpersonationBlocked()
  @Post('registration/verify')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async verifyRegistration(
    @Req() req: Request,
    @Body() body: VerifyPasskeyRegistrationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const accessToken = readAccessToken(req);
    const countryCode = this.readCountryCode(req);
    const passkey = await this.passkeysService.verifyRegistration(
      body as never,
      accessToken,
      this.readOrigin(req),
    );
    const trustedDeviceValue =
      await this.passkeysService.trustCurrentDeviceAfterEnrollment({
        accessToken,
        currentTrustedDeviceCookie: readRequestCookie(
          req,
          this.passkeysService.getTrustedDeviceCookieName(),
        ),
        countryCode,
      });

    if (trustedDeviceValue) {
      this.writePasskeyCookie(
        res,
        this.passkeysService.getTrustedDeviceCookieName(),
        trustedDeviceValue,
        this.passkeysService.getTrustedDeviceMaxAgeSeconds(),
      );
    }

    return passkey;
  }

  @Public()
  @Post('authentication/options')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async startAuthentication(@Req() req: Request) {
    return this.passkeysService.startAuthentication(this.readOrigin(req));
  }

  @Public()
  @Post('authentication/verify')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async verifyAuthentication(
    @Req() req: Request,
    @Body() body: VerifyPasskeyAuthenticationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.passkeysService.verifyAuthentication(
      body as never,
      {
        origin: this.readOrigin(req),
        trustedDeviceCookie: readRequestCookie(
          req,
          this.passkeysService.getTrustedDeviceCookieName(),
        ),
        pendingTrustedDeviceCookie: readRequestCookie(
          req,
          this.passkeysService.getPendingTrustedDeviceCookieName(),
        ),
        countryCode: this.readCountryCode(req),
      },
    );
    const cookieConfig = readCookieConfig(this.configService);

    setAuthCookies(res, result.tokens, cookieConfig);
    if (result.response.mfaRequired) {
      // Bind the marker to this account so it cannot gate a second account
      // signed in on the same parent domain.
      setMfaPendingCookie(res, cookieConfig, result.authUserId);
    } else {
      clearMfaPendingCookie(res, cookieConfig);
    }

    this.writePasskeyCookie(
      res,
      this.passkeysService.getTrustedDeviceCookieName(),
      result.cookies.trustedDeviceValue,
      this.passkeysService.getTrustedDeviceMaxAgeSeconds(),
    );
    this.writePasskeyCookie(
      res,
      this.passkeysService.getPendingTrustedDeviceCookieName(),
      result.cookies.pendingTrustedDeviceValue,
      this.passkeysService.getPendingTrustedDeviceMaxAgeSeconds(),
    );
    this.writePasskeyCookie(
      res,
      this.passkeysService.getAssuranceCookieName(),
      result.cookies.assuranceValue,
      this.passkeysService.getAssuranceCookieMaxAgeSeconds(),
    );

    return result.response;
  }

  @Post('trusted-device/finalize')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async finalizeTrustedDevice(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertAllowedRequestOrigin(req);
    const result = await this.passkeysService.finalizeTrustedDevice(
      readAccessToken(req),
      readRequestCookie(
        req,
        this.passkeysService.getPendingTrustedDeviceCookieName(),
      ),
      readRequestCookie(req, this.passkeysService.getTrustedDeviceCookieName()),
    );

    this.writePasskeyCookie(
      res,
      this.passkeysService.getTrustedDeviceCookieName(),
      result.trustedDeviceValue,
      this.passkeysService.getTrustedDeviceMaxAgeSeconds(),
    );
    this.writePasskeyCookie(
      res,
      this.passkeysService.getPendingTrustedDeviceCookieName(),
      result.pendingTrustedDeviceValue,
      this.passkeysService.getPendingTrustedDeviceMaxAgeSeconds(),
    );
    this.writePasskeyCookie(
      res,
      this.passkeysService.getAssuranceCookieName(),
      result.assuranceValue,
      this.passkeysService.getAssuranceCookieMaxAgeSeconds(),
    );

    return { success: true };
  }

  @ImpersonationBlocked()
  @Get()
  async listPasskeys(@Req() req: Request) {
    this.assertAllowedRequestOrigin(req);
    return this.passkeysService.listPasskeys(readAccessToken(req));
  }

  @ImpersonationBlocked()
  @Patch(':passkeyId')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async renamePasskey(
    @Req() req: Request,
    @Param('passkeyId', new ParseUUIDPipe({ version: '4' }))
    passkeyId: string,
    @Body() body: RenamePasskeyDto,
  ) {
    this.assertAllowedRequestOrigin(req);
    return this.passkeysService.renamePasskey(
      readAccessToken(req),
      passkeyId,
      body.friendlyName,
    );
  }

  @ImpersonationBlocked()
  @Delete(':passkeyId')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async deletePasskey(
    @Req() req: Request,
    @Param('passkeyId', new ParseUUIDPipe({ version: '4' }))
    passkeyId: string,
  ) {
    this.assertAllowedRequestOrigin(req);
    await this.passkeysService.deletePasskey(readAccessToken(req), passkeyId);
    return { success: true };
  }

  private readOrigin(req: Request): string {
    return req.headers.origin || '';
  }

  private assertAllowedRequestOrigin(req: Request): void {
    const requestOrigin = this.readRequestOrigin(req);
    const allowedOrigin =
      this.configService.get<string>('passkeys.origin') || '';

    if (!requestOrigin || requestOrigin !== allowedOrigin) {
      throw new BadRequestException('Invalid passkey origin');
    }
  }

  private readRequestOrigin(req: Request): string {
    const headerOrigin = this.readOrigin(req);
    if (headerOrigin) return headerOrigin;

    const referer = req.headers.referer;
    if (!referer || Array.isArray(referer)) return '';

    try {
      return new URL(referer).origin;
    } catch {
      return '';
    }
  }

  private readCountryCode(req: Request): string | null {
    const headerName = this.configService.get<string>('passkeys.countryHeader');
    if (!headerName) return null;
    const value = req.headers[headerName];
    if (value === undefined) return null;

    // Degrade to null instead of throwing. A missing country is deliberately
    // treated as neutral (not risky), so an UNPARSEABLE one must be too —
    // otherwise the edge decides whether the user can log in at all. Real
    // values that are not two letters do occur: Vercel sends `T1` for Tor exit
    // nodes, and some edges send an empty string for unknown geography.
    // Blocking sign-in on those is a worse failure than losing the signal.
    if (Array.isArray(value) || typeof value !== 'string') return null;

    const normalized = value.trim().toUpperCase();

    return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
  }

  private writePasskeyCookie(
    res: Response,
    name: string,
    value: string | null,
    maxAgeSeconds: number,
  ): void {
    const cookieConfig = readCookieConfig(this.configService);
    const baseOpts = {
      httpOnly: true,
      secure: cookieConfig.secure,
      sameSite: cookieConfig.sameSite,
      ...(cookieConfig.domain ? { domain: cookieConfig.domain } : {}),
    };

    if (!value) {
      res.clearCookie(name, { ...baseOpts, path: '/' });
      return;
    }

    res.cookie(name, value, {
      ...baseOpts,
      path: '/',
      maxAge: maxAgeSeconds * 1000,
    });
  }
}
