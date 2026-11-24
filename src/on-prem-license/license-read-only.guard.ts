/**
 * @fileoverview Read-only mode for an on-prem box past its licence grace (D4).
 * @module on-prem-license/license-read-only.guard
 *
 * Once a box has run 14 days without a valid licence (or the vendor locked
 * it), users may still sign in and READ everything, but every write is refused
 * with 403 LICENSE_READ_ONLY. The licence page (system-license/*) and the
 * auth flows stay writable so an admin can always check in or import a
 * licence file to get out of read-only mode.
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { OnpremLicenseStateService } from './onprem-license.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Writes that must keep working in read-only mode (path after /api/v1). */
const ALLOWED_WRITE_PREFIXES = [
  '/auth/',
  '/system-license/',
  // Server configuration: an admin must be able to fix e.g. LICENSE_API_URL or SMTP.
  '/system-config/',
  '/mfa/',
  '/passkeys/',
  '/sso/',
  '/oauth/',
];

@Injectable()
export class LicenseReadOnlyGuard implements CanActivate {
  constructor(private readonly state: OnpremLicenseStateService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const req = context
      .switchToHttp()
      .getRequest<{ method?: string; originalUrl?: string; url?: string }>();

    if (SAFE_METHODS.has((req.method ?? 'GET').toUpperCase())) return true;

    const path = (req.originalUrl ?? req.url ?? '').replace(/^\/api\/v1/, '');

    if (ALLOWED_WRITE_PREFIXES.some((p) => path.startsWith(p))) return true;

    if (!(await this.state.current()).readOnly) return true;

    throw new ForbiddenException({
      code: 'LICENSE_READ_ONLY',
      message:
        'This installation is read-only because it has no valid licence. An administrator can check in or import a licence file under System → Licence.',
    });
  }
}
