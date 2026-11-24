/**
 * @fileoverview Root application controller that exposes the health check endpoints:
 * `/health` (liveness — the process is up) and `/health/ready` (readiness — this replica
 * can serve traffic: not shutting down, database reachable). Used by load balancers,
 * Kubernetes probes and monitoring tools.
 * @module src/app.controller
 * @author Prince Jadiya
 */

import {
  Controller,
  Get,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './auth/decorators/public.decorator';
import { SupabaseAdminService } from './supabase/supabase-admin.service';

/** Readiness must answer well inside a probe's timeout, even when the database hangs. */
const READY_DB_TIMEOUT_MS = 2_000;

/**
 * Root controller providing application-level endpoints such as health checks.
 *
 * @example
 * // Injected automatically by NestJS via AppModule:
 * // GET /api/v1/health
 */
@ApiTags('Health')
@Controller()
export class AppController implements OnModuleDestroy {
  private shuttingDown = false;

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  /** First shutdown hook: stop advertising readiness while in-flight work drains. */
  onModuleDestroy(): void {
    this.shuttingDown = true;
  }

  /**
   * Returns the current health status of the API.
   *
   * This endpoint is public (no authentication required) and returns
   * the environment, server uptime in seconds, and an ISO timestamp.
   *
   * @returns {{ status: string; environment: string; uptime: number; timestamp: string }}
   *   The health status object
   */
  // Skip throttling so load-balancer health probes don't consume the bucket.
  // Without this, frequent /health pings (every few seconds) would burn through
  // the per-IP limit and cause real users sharing that IP to 429.
  @SkipThrottle()
  @Public()
  @Get('health')
  @ApiOperation({
    summary: 'Health check',
    description:
      'Returns the current status, environment, and uptime of the API. No authentication required.',
  })
  @ApiResponse({ status: 200, description: 'API is healthy' })
  getHealth() {
    return {
      status: 'ok',
      environment: process.env.NODE_ENV || 'development',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness probe. 503 while this replica is shutting down or cannot reach the database, so
   * the load balancer routes around it; `/health` stays the liveness probe and never touches
   * the database (a database outage must not restart every pod).
   */
  @SkipThrottle()
  @Public()
  @Get('health/ready')
  @ApiOperation({
    summary: 'Readiness check',
    description:
      'Returns 200 when this instance can serve traffic, 503 while it is shutting down or the database is unreachable. No authentication required.',
  })
  @ApiResponse({ status: 200, description: 'Instance is ready' })
  @ApiResponse({ status: 503, description: 'Instance is not ready' })
  async getReady() {
    if (this.shuttingDown) {
      throw new ServiceUnavailableException('Shutting down');
    }

    let dbOk = false;

    try {
      const { error } = await this.supabaseAdmin
        .getClient()
        .from('cron_run_state')
        .select('job_name', { head: true })
        .limit(1)
        .abortSignal(AbortSignal.timeout(READY_DB_TIMEOUT_MS));

      dbOk = !error;
    } catch {
      dbOk = false;
    }

    if (!dbOk) throw new ServiceUnavailableException('Database unreachable');

    return { status: 'ready', timestamp: new Date().toISOString() };
  }
}
