/**
 * @fileoverview Service that creates per-request Supabase clients authenticated with the user's JWT.
 * These clients respect Row Level Security (RLS) policies, ensuring `auth.uid()` resolves correctly.
 * @module src/supabase/supabase.service
 * @author Prince Jadiya
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Creates Supabase clients scoped to individual users via their JWT access token.
 *
 * Unlike {@link SupabaseAdminService}, clients created by this service operate under
 * the user's identity and are subject to RLS policies.
 *
 * @example
 * // Inject in a controller or service:
 * constructor(private readonly supabase: SupabaseService) {}
 *
 * // Create a user-scoped client:
 * const client = this.supabase.createClientForUser(accessToken);
 */
@Injectable()
export class SupabaseService {
  /** @private Supabase project URL from configuration */
  private readonly supabaseUrl: string;

  /** @private Supabase anonymous/public key from configuration */
  private readonly supabaseAnonKey: string;

  /**
   * @param {ConfigService} configService - NestJS config service for reading Supabase settings
   */
  constructor(private configService: ConfigService) {
    this.supabaseUrl = this.configService.get<string>('supabase.url')!;
    this.supabaseAnonKey = this.configService.get<string>('supabase.anonKey')!;
  }

  /**
   * Create a Supabase client authenticated with the user's JWT.
   * This preserves RLS policies - auth.uid() resolves correctly.
   *
   * @param {string} accessToken - The user's Supabase JWT access token
   * @returns {SupabaseClient} A Supabase client instance scoped to the user's identity
   */
  createClientForUser(accessToken: string): SupabaseClient<any, any> {
    return createClient(this.supabaseUrl, this.supabaseAnonKey, {
      global: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    });
  }
}
