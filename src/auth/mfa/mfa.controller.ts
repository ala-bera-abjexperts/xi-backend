/**
 * @fileoverview MFA controller — endpoints for TOTP enrollment, challenge, verify,
 * unenroll, factor list, and assurance-level lookup. All endpoints require an
 * authenticated user (access_token cookie or Bearer header).
 *
 * Cookie behavior: `verify` rotates the access_token + refresh_token cookies to
 * the new aal2 tokens on success — same Set-Cookie contract as `/auth/signin`.
 *
 * @module src/auth/mfa/mfa.controller
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  MfaService,
  type MfaChallengeResult,
  type MfaEnrollResult,
  type MfaFactor,
  type MfaVerifyResult,
} from './mfa.service';
import {
  ChallengeMfaDto,
  EnrollMfaDto,
  UnenrollMfaDto,
  VerifyMfaDto,
} from './dto/enroll-mfa.dto';
import {
  clearMfaPendingCookie,
  readMfaPendingCookie,
  readCookieConfig,
  setAuthCookies,
} from '../cookies.util';
import { getSessionAssuranceTokenPayload } from './session-assurance.util';
import { ImpersonationBlocked } from '../decorators/impersonation-blocked.decorator';
import { AllowPendingMfa } from '../decorators/allow-pending-mfa.decorator';
import { AllowWithoutSso } from '../decorators/allow-without-sso.decorator';
import { PasskeysService } from '../passkeys/passkeys.service';

/**
 * Reads the access token from the request — same contract as the auth guard.
 * Order of precedence: Authorization header → access_token cookie.
 */
function readAccessToken(req: Request): string {
  const [type, headerToken] = req.headers.authorization?.split(' ') ?? [];
  if (type === 'Bearer' && headerToken) return headerToken;
  const typedReq = req as Request & { cookies?: Record<string, string> };
  const cookieToken = (typedReq.cookies?.['access_token'] ?? undefined) as
    | string
    | undefined;
  if (!cookieToken) {
    throw new BadRequestException('access_token missing');
  }
  return cookieToken;
}

@ApiTags('MFA')
@ApiBearerAuth()
@AllowWithoutSso()
@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfaService: MfaService,
    private readonly configService: ConfigService,
    private readonly passkeysService: PasskeysService,
  ) {}

  private readonly logger = new Logger(MfaController.name);

  @ImpersonationBlocked()
  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enroll a TOTP factor',
    description:
      'Starts MFA enrollment for the authenticated user. Returns the QR code, ' +
      'TOTP secret, and provisioning URI. The factor is in `unverified` state ' +
      'until /auth/mfa/verify is called with a valid TOTP code.',
  })
  @ApiResponse({ status: 200, description: 'Enroll initiated' })
  async enroll(
    @Req() req: Request,
    @Body() body: EnrollMfaDto,
  ): Promise<MfaEnrollResult> {
    const token = readAccessToken(req);
    return this.mfaService.enroll(token, body.friendlyName);
  }

  @ImpersonationBlocked()
  @AllowPendingMfa()
  @Post('challenge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Issue an MFA challenge',
    description:
      'Begins a TOTP verification cycle. The frontend then prompts the user for ' +
      'the 6-digit code, then calls /auth/mfa/verify with the challenge ID.',
  })
  @ApiResponse({ status: 200, description: 'Challenge issued' })
  async challenge(
    @Req() req: Request,
    @Body() body: ChallengeMfaDto,
  ): Promise<MfaChallengeResult> {
    const token = readAccessToken(req);
    return this.mfaService.challenge(token, body.factorId);
  }

  @ImpersonationBlocked()
  @AllowPendingMfa()
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify a TOTP code (promotes session to aal2)',
    description:
      'Verifies the 6-digit TOTP code against an outstanding challenge. On ' +
      'success, rotates the auth cookies to the new aal2 token pair.',
  })
  @ApiResponse({ status: 200, description: 'Verified — cookies rotated' })
  @ApiResponse({ status: 401, description: 'Invalid code' })
  async verify(
    @Req() req: Request,
    @Body() body: VerifyMfaDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MfaVerifyResult> {
    const token = readAccessToken(req);
    const result = await this.mfaService.verify(
      token,
      body.factorId,
      body.challengeId,
      body.code,
    );
    const cookieConfig = readCookieConfig(this.configService);
    const requestCookies = (
      req as Request & { cookies?: Record<string, string | undefined> }
    ).cookies;
    const pendingTrustedDevice =
      requestCookies?.[
        this.passkeysService.getPendingTrustedDeviceCookieName()
      ];
    let trustedDevice: Awaited<
      ReturnType<PasskeysService['finalizeTrustedDevice']>
    > | null = null;
    let remainingPendingDevice: string | null = null;

    if (pendingTrustedDevice) {
      try {
        trustedDevice = await this.passkeysService.finalizeTrustedDevice(
          result.access_token,
          pendingTrustedDevice,
          requestCookies?.[this.passkeysService.getTrustedDeviceCookieName()],
        );
      } catch (err) {
        // Trusting the device is a convenience, never a gate on sign-in. The
        // pending cookie can be stale, tampered with, expired, or bound to a
        // different session — and finalizeTrustedDevice throws on all of them.
        // Letting that escape skipped setAuthCookies below, so a bad pending
        // cookie locked the user out of TOTP entirely until they cleared it by
        // hand. Degrade to a warning like trustCurrentDeviceAfterEnrollment
        // does; dropping this account's slot below stops the retry from looping
        // on the same failure without evicting a concurrent sign-in's slot.
        this.logger.warn(
          `mfa verify: trusted-device finalization failed: ${err instanceof Error ? err.message : err}`,
        );
        remainingPendingDevice = this.passkeysService.dropPendingTrustedDevice(
          pendingTrustedDevice,
          result.access_token,
        );
      }
    }

    setAuthCookies(res, result, cookieConfig);
    clearMfaPendingCookie(res, cookieConfig);

    if (trustedDevice) {
      this.writePasskeyCookie(
        res,
        this.passkeysService.getTrustedDeviceCookieName(),
        trustedDevice.trustedDeviceValue,
        this.passkeysService.getTrustedDeviceMaxAgeSeconds(),
      );
      this.writePasskeyCookie(
        res,
        this.passkeysService.getAssuranceCookieName(),
        trustedDevice.assuranceValue,
        this.passkeysService.getAssuranceCookieMaxAgeSeconds(),
      );
    }

    // clearMfaPendingCookie above wipes the whole pending-device cookie; write
    // back whatever slots survive so other accounts keep their step-up state.
    if (pendingTrustedDevice) {
      this.writePasskeyCookie(
        res,
        this.passkeysService.getPendingTrustedDeviceCookieName(),
        trustedDevice?.pendingTrustedDeviceValue ?? remainingPendingDevice,
        this.passkeysService.getPendingTrustedDeviceMaxAgeSeconds(),
      );
    }

    return result;
  }

  @ImpersonationBlocked()
  @Post('unenroll')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove an MFA factor' })
  @ApiResponse({ status: 200, description: 'Factor removed' })
  async unenroll(
    @Req() req: Request,
    @Body() body: UnenrollMfaDto,
  ): Promise<{ success: true }> {
    const token = readAccessToken(req);
    await this.mfaService.unenroll(token, body.factorId);
    return { success: true };
  }

  @AllowPendingMfa()
  @Get('factors')
  @ApiOperation({ summary: "List the user's MFA factors" })
  @ApiResponse({ status: 200, description: 'Factor list' })
  async factors(@Req() req: Request): Promise<MfaFactor[]> {
    const token = readAccessToken(req);
    return this.mfaService.listFactors(token);
  }

  // System-overhead endpoint: the Next.js middleware calls this on every
  // protected-page navigation to decide whether TOTP gating is required.
  // Counting it against the user's regular rate budget caused legitimate
  // navigation to 429 and bounce aal1 users to /auth/login. Exempt it from
  // the throttler — auth, security-sensitive MFA endpoints (verify, enroll,
  // challenge, unenroll) remain throttled.
  @SkipThrottle()
  @AllowPendingMfa()
  @Get('aal')
  @ApiOperation({
    summary: 'Get current + required MFA assurance level',
    description:
      'Returns `{ currentLevel, nextLevel, currentAuthenticationMethods }`. ' +
      'Used by the Next.js middleware to decide whether to gate on TOTP.',
  })
  @ApiResponse({ status: 200, description: 'AAL info' })
  async aal(@Req() req: Request): Promise<{
    currentLevel: string | null;
    nextLevel: string | null;
    mfaRequired: boolean;
    authenticationMethod: string | null;
    stepUpReason: string | null;
    recentTotpRequired: boolean;
    currentAuthenticationMethods: { method: string; timestamp: number }[];
  }> {
    const token = readAccessToken(req);
    const typedReq = req as Request & {
      cookies?: Record<string, string | undefined>;
    };

    const sub = getSessionAssuranceTokenPayload(token)?.sub;

    return this.mfaService.getAal(token, {
      // The guard already verified this token; the sub only decides whether an
      // mfa_pending marker belongs to this account or to a co-signed-in one.
      forceMfa: readMfaPendingCookie(
        typedReq.cookies,
        readCookieConfig(this.configService),
        typeof sub === 'string' ? sub : undefined,
      ),
    });
  }

  private writePasskeyCookie(
    res: Response,
    name: string,
    value: string | null,
    maxAgeSeconds: number,
  ): void {
    const cookieConfig = readCookieConfig(this.configService);
    const options = {
      httpOnly: true,
      secure: cookieConfig.secure,
      sameSite: cookieConfig.sameSite,
      path: '/',
      ...(cookieConfig.domain ? { domain: cookieConfig.domain } : {}),
    };

    if (!value) {
      res.clearCookie(name, options);
      return;
    }

    res.cookie(name, value, {
      ...options,
      maxAge: maxAgeSeconds * 1000,
    });
  }
}
