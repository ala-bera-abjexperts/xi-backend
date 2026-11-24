/**
 * @fileoverview Licence statuses that still grant entitlements.
 * @module licensing/licensing.constants
 *
 * The ONE backend source for "live". It used to be copied in seven places,
 * which drifted. The frontend mirrors it in src/models/licensing.model.ts.
 * Anything not listed here (cancelled, expired) drops the tenant to the free
 * tier; only a tenant that never held a licence is grandfathered.
 */

import type { OrganizationLicenseStatus } from './dto/licensing.dto';

export const LIVE_LICENSE_STATUSES: readonly OrganizationLicenseStatus[] = [
  'trialing',
  'active',
  'past_due',
  'suspended',
];
