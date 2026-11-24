/**
 * @fileoverview Single-tenant helpers for on-premise deployments.
 *
 * Unlike OnPremUpdatesModule (imported only when IS_ON_PREMISE, because its ROUTES
 * must not exist in cloud), this module is imported unconditionally and is safe in
 * SaaS: it registers no controllers, and OnPremiseTenantService short-circuits on
 * `onPrem.enabled`. Importing it always keeps the auth wiring identical across both
 * builds, so there is no cloud-only code path that goes untested on-premise.
 *
 * @module src/on-premise/on-premise.module
 * @author Prince Jadiya
 */

import { Global, Module } from '@nestjs/common';
import { OnPremiseTenantService } from './on-premise-tenant.service';

@Global()
@Module({
  providers: [OnPremiseTenantService],
  exports: [OnPremiseTenantService],
})
export class OnPremiseModule {}
