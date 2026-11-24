/**
 * @fileoverview Service that provides a singleton Supabase admin client using the service role key.
 * This client bypasses RLS and is used for server-side operations such as user management,
 * invitation generation, and permission lookups.
 * @module src/supabase/supabase-admin.service
 * @author Prince Jadiya
 */

import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Singleton Supabase admin client that uses the service role key to bypass Row Level Security.
 *
 * Initializes on module startup via `OnModuleInit` and disables auto-refresh and session
 * persistence since this is a server-side, stateless client.
 *
 * @example
 * // Inject and use the admin client:
 * constructor(private readonly supabaseAdmin: SupabaseAdminService) {}
 *
 * const client = this.supabaseAdmin.getClient();
 * const { data } = await client.from('users').select('*');
 */
@Injectable()
export class SupabaseAdminService implements OnModuleInit {
  /** @private The singleton Supabase admin client instance */
  private client!: SupabaseClient<any, any>;

  /**
   * @param {ConfigService} configService - NestJS config service for reading Supabase settings
   */
  constructor(private configService: ConfigService) {}

  /**
   * Lifecycle hook called once the module is initialized.
   * Creates the Supabase admin client with the service role key, disabling
   * token auto-refresh and session persistence for server-side use.
   */
  onModuleInit() {
    const url = this.configService.get<string>('supabase.url')!;
    const serviceRoleKey = this.configService.get<string>(
      'supabase.serviceRoleKey',
    )!;

    this.client = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        experimental: { passkey: true },
      },
    });
  }

  /**
   * Returns the singleton Supabase admin client.
   *
   * @returns {SupabaseClient} The admin-level Supabase client that bypasses RLS
   */
  getClient(): SupabaseClient<any, any> {
    return this.client;
  }

  /**
   * Creates a short-lived auth client for user-session operations such as
   * password sign-in, OTP verification, refresh, and auth-code exchange.
   *
   * Keep these calls off the singleton admin client: supabase-js stores auth
   * state on the client instance, so a successful user sign-in can make later
   * database calls run as that user and unexpectedly hit RLS.
   */
  createAuthClient(): SupabaseClient<any, any> {
    const url = this.configService.get<string>('supabase.url')!;
    const anonKey = this.configService.get<string>('supabase.anonKey')!;

    return createClient(url, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }
}
