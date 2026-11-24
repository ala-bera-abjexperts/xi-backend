/**
 * @fileoverview Global NestJS module that provides Supabase client services to the entire application.
 * Exports both user-scoped and admin-scoped Supabase clients for RLS-respecting and elevated operations.
 * @module src/supabase/supabase.module
 * @author Prince Jadiya
 */

import { Global, Module } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { SupabaseAdminService } from './supabase-admin.service';

/**
 * Global module that registers and exports {@link SupabaseService} and {@link SupabaseAdminService}.
 *
 * Because this module is decorated with `@Global()`, any module in the application can inject
 * these services without explicitly importing `SupabaseModule`.
 *
 * @example
 * // Any service can inject the Supabase clients:
 * constructor(private readonly supabaseAdmin: SupabaseAdminService) {}
 */
@Global()
@Module({
  providers: [SupabaseService, SupabaseAdminService],
  exports: [SupabaseService, SupabaseAdminService],
})
export class SupabaseModule {}
