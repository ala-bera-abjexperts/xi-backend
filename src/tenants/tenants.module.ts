/**
 * @fileoverview NestJS module declaring the tenants feature. Pulls in nothing
 * extra — `SupabaseModule` is `@Global()` so `SupabaseAdminService` is in scope
 * everywhere, and `ConfigService` comes from the global `ConfigModule`.
 * @module src/tenants/tenants.module
 */

import { Module } from '@nestjs/common';
import { ImpersonationModule } from '../impersonation/impersonation.module';
import { PublicTenantsController } from './public-tenants.controller';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  // ImpersonationModule exports ImpersonationService and imports only
  // AuditLogsModule (not TenantsModule), so there is no circular dependency.
  imports: [ImpersonationModule],
  controllers: [TenantsController, PublicTenantsController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
