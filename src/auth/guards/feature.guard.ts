import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { EntitlementsService } from '../../licensing/entitlements.service';
import { REQUIRE_FEATURE_KEY } from '../decorators/require-feature.decorator';
import { SUPER_ADMIN_ROLE } from './super-admin.guard';
import type { RequestUser } from '../interfaces/request-user.interface';

/**
 * Enforces license-feature entitlements on routes decorated with
 * `@RequireFeature(...)`. Registered as a global APP_GUARD that runs AFTER the
 * auth/impersonation guards (so `request.user` is populated).
 *
 * Layering: the {@link EntitlementsService} describes ENTITLEMENTS; this guard
 * applies POLICY (e.g. denying cancelled/expired tenants even though the resolver
 * grandfathers them). Frontend gating (Phase 3) is UX; THIS is the security boundary.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  private readonly logger = new Logger(FeatureGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Collect required features from BOTH class and handler metadata, dedup'd.
    const classKeys =
      this.reflector.get<string[]>(REQUIRE_FEATURE_KEY, context.getClass()) ??
      [];
    const handlerKeys =
      this.reflector.get<string[]>(REQUIRE_FEATURE_KEY, context.getHandler()) ??
      [];

    const requiredKeys = Array.from(new Set([...classKeys, ...handlerKeys]));

    if (requiredKeys.length === 0) {
      // Either no @RequireFeature on this route, or an empty array (coding error).
      // Be defensive: warn if metadata was present but empty, then no-op allow.
      if (classKeys.length === 0 && handlerKeys.length === 0) {
        return true;
      }

      this.logger.warn(
        '@RequireFeature was applied with an empty key list; treating as no-op.',
      );

      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: RequestUser }>();
    const user = request.user;

    // No user → an upstream auth guard should already have rejected this. Defensive deny.
    if (!user) {
      throw new ForbiddenException({
        code: 'FEATURE_NOT_ENTITLED',
        message: 'Authentication required',
      });
    }

    // Super-Admin bypass — mirror SuperAdminGuard's checks EXACTLY.
    const metadata = user.appMetadata ?? {};
    const hasAuthClaim =
      metadata.role === SUPER_ADMIN_ROLE || metadata.is_super_admin === true;
    const isSuperAdmin =
      hasAuthClaim && user.role === SUPER_ADMIN_ROLE && user.isActive !== false;

    // A real SA with no impersonation overlay bypasses all feature checks.
    // While impersonating, we FALL THROUGH and enforce the IMPERSONATED tenant's
    // entitlements (user.organizationId is already the impersonated org).
    if (isSuperAdmin && !user.impersonation) {
      return true;
    }

    // No active org → cannot resolve entitlements. Keep the error shape consistent
    // for the frontend (403 FEATURE_NOT_ENTITLED rather than 400).
    if (!user.organizationId) {
      throw new ForbiddenException({
        code: 'FEATURE_NOT_ENTITLED',
        message: 'No active organization context',
        required_features: requiredKeys,
      });
    }

    const entitlements =
      await this.entitlementsService.getEffectiveEntitlements(
        user.organizationId,
      );

    // Helper: extract route path from the Express request for log enrichment.
    const route =
      (request as { route?: { path?: string }; path?: string }).route?.path ??
      (request as { path?: string }).path ??
      'unknown';

    // Policy layer. A cancelled/expired tenant is LOCKED TO THE FREE TIER, not
    // denied outright.
    //
    // This used to blanket-deny every gated route the moment the status was
    // cancelled or expired. That branch was unreachable in practice (the
    // resolver could never report those statuses, which is the bug this work
    // fixes), and reaching it as written would have denied free-tier modules
    // too: module_wiki, module_lists and module_boards are all gated, so the
    // "platform stays usable at free scope" requirement would have been broken
    // by the guard before the entitlements were ever consulted.
    //
    // So the per-key check below is now the only decision, and the entitlements
    // it reads already resolve to the free set for a locked tenant. The
    // LICENSE_INACTIVE code is preserved for the denial itself, because the
    // frontend needs to tell "renew to get this back" apart from "this was
    // never in your plan".
    const licenseInactive =
      entitlements.licenseStatus === 'cancelled' ||
      entitlements.licenseStatus === 'expired';

    for (const key of requiredKeys) {
      if (!entitlements.has(key)) {
        this.logFeatureGateDecision({
          decision: 'deny',
          organization_id: user.organizationId,
          user_id: user.userId,
          required_features: requiredKeys,
          missing_feature: key,
          license_status: entitlements.licenseStatus,
          grandfathered: entitlements.grandfathered,
          reason: licenseInactive ? 'license_inactive' : 'feature_not_entitled',
          route,
        });

        throw new ForbiddenException(
          licenseInactive
            ? {
                code: 'LICENSE_INACTIVE',
                message: `License is ${entitlements.licenseStatus}. Renew to regain access.`,
                feature_key: key,
                license_status: entitlements.licenseStatus,
                required_features: requiredKeys,
              }
            : {
                code: 'FEATURE_NOT_ENTITLED',
                message: `Feature '${key}' is not included in your current license.`,
                feature_key: key,
                license_status: entitlements.licenseStatus,
                grandfathered: entitlements.grandfathered,
              },
        );
      }
    }

    // ALLOW path: structured log emitted with sampling. DENY is always logged
    // above (zero sampling); ALLOWs are sampled because they can flood logs
    // at high traffic. Default rate is 0.01 (1%); env override:
    // `LICENSING_LOG_ALLOW_SAMPLE_RATE=0.05` for 5%, `=1` for every event,
    // `=0` to suppress entirely.
    if (Math.random() < this.getAllowSampleRate()) {
      this.logFeatureGateDecision({
        decision: 'allow',
        organization_id: user.organizationId,
        user_id: user.userId,
        required_features: requiredKeys,
        missing_feature: undefined,
        license_status: entitlements.licenseStatus,
        grandfathered: entitlements.grandfathered,
        reason: 'all_features_granted',
        route,
      });
    }

    return true;
  }

  /**
   * Read the ALLOW-event sample rate from env. Clamped to [0, 1]; defaults to
   * 0.01 if unset or invalid. Read per-call (not cached) so ops can adjust at
   * runtime by restarting the process — no rolling deploy needed.
   */
  private getAllowSampleRate(): number {
    const raw = process.env.LICENSING_LOG_ALLOW_SAMPLE_RATE;
    if (raw === undefined || raw === '') return 0.01;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 0.01;

    return Math.max(0, Math.min(1, parsed));
  }

  /**
   * Single emission point for the `feature_gate_decision` event. NestJS's
   * default Logger stringifies objects via `util.inspect`; if the deployment
   * uses a structured logger (Pino, Winston), the object payload is preserved
   * verbatim. Stringification is a safe fallback either way.
   */
  private logFeatureGateDecision(payload: {
    decision: 'allow' | 'deny';
    organization_id: string;
    user_id: string;
    required_features: string[];
    missing_feature: string | undefined;
    license_status: string | null;
    grandfathered: boolean;
    reason: string;
    route: string;
  }): void {
    this.logger.log({ event: 'feature_gate_decision', ...payload });
  }
}
