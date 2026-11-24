/**
 * @fileoverview Application entry point that bootstraps the NestJS server with security middleware,
 * global pipes/filters/interceptors, CORS configuration, and Swagger API documentation.
 * @module src/main
 * @author Prince Jadiya
 */

import { createHash } from 'crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { ConsoleLogger, Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import express from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { SupabaseAdminService } from './supabase/supabase-admin.service';
import { setupMetrics } from './common/metrics/metrics';
import { helmetOptions, isSwaggerEnabled } from './common/http-hardening';
import {
  type OriginCacheEntry,
  type SupabaseLookupClient,
  isAllowedConfiguredOrSubdomainOrigin,
  isPublicSiteStudioCorsPath,
  isVerifiedSiteStudioCustomDomainOrigin,
} from './common/cors/site-studio-cors.util';
/**
 * Bootstraps the NestJS application with all global configuration.
 *
 * Sets up the following in order:
 * 1. Helmet security headers
 * 2. Global API prefix (`api/v1`)
 * 3. CORS with configurable frontend origin
 * 4. Global validation pipe (whitelist + transform + forbid non-whitelisted)
 * 5. Global exception filter and interceptors (logging + uniform response)
 * 6. Swagger/OpenAPI documentation at `/api/v1/docs` (unless SWAGGER_ENABLED=false)
 *
 * @returns {Promise<void>} Resolves once the server is listening
 *
 * @example
 * // The bootstrap function is invoked at module load:
 * void bootstrap();
 */
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // LOG_FORMAT=json: one JSON object per line, for cluster log collectors.
    logger:
      process.env.LOG_FORMAT === 'json'
        ? new ConsoleLogger({ json: true })
        : console,
    rawBody: true,
  });

  // Prometheus metrics, on their own port (METRICS_PORT) — never on the public one. Installed
  // first so the histogram times every request, including those rejected by later middleware.
  const metricsMiddleware = setupMetrics(process.env.METRICS_PORT);
  if (metricsMiddleware) app.use(metricsMiddleware);

  // Raise JSON body limit from the default 100 KB to 10 MB.
  // Wiki pages with rich EditorJS content (tables, code, pasted HTML) can exceed 100 KB.
  // SCIM clients (Microsoft Entra ID) send `application/scim+json`.
  app.useBodyParser('json', {
    limit: '10mb',
    type: ['application/json', 'application/scim+json'],
  });
  app.useBodyParser('urlencoded', { extended: true, limit: '10mb' });

  // HSTS_ENABLED=false (on-prem over plain HTTP) drops Strict-Transport-Security.
  app.use(helmet(helmetOptions()));

  // gzip/deflate the response body. This API returns large JSON (task and wiki
  // lists, dashboard widget payloads, the /auth/bootstrap aggregate), all of it
  // previously uncompressed — typically 6-10x larger on the wire than gzip.
  //
  // SSE MUST BE EXCLUDED. `compression` buffers output to build a compressed
  // stream, which for an event stream means events sit in the buffer instead of
  // reaching the client. There are three live SSE endpoints — on-prem update
  // progress, automation run streams and migration run streams — and all three
  // would appear to hang rather than fail loudly, which is the worst kind of
  // regression. The default filter does not know about SSE, so check for it
  // explicitly before delegating.
  //
  // `compression.filter` still handles the rest: it honours a client's
  // `x-no-compression` header and skips content types that are already
  // compressed (images, zips, video).
  app.use(
    compression({
      filter: (req: express.Request, res: express.Response) => {
        const contentType = String(res.getHeader('Content-Type') ?? '');

        if (contentType.includes('text/event-stream')) return false;

        return compression.filter(req, res);
      },
    }),
  );

  // Raw body capture for webhook HMAC signature verification.
  // Must run before NestJS JSON body parsing so the raw bytes are preserved.
  // Only applied to the webhook path — all other routes use standard JSON parsing.
  app.use('/api/v1/webhooks', (req, res, next) => {
    express.raw({ type: '*/*', limit: '10mb' })(req, res, () => {
      const typedReq = req as express.Request & { rawBody: string };
      const body: unknown = typedReq.body;
      typedReq.rawBody = Buffer.isBuffer(body) ? body.toString('utf8') : '';
      (next as express.NextFunction)();
    });
  });

  // Cookie parsing — required by AuthController/SupabaseAuthGuard to read access_token
  // and refresh_token cookies set by NestJS on signin/verify-otp/refresh.
  app.use(cookieParser());

  // Trust the reverse proxy so `req.ip` reflects the real client, not the
  // proxy's internal address. Without this, every user behind Vercel/Nginx/ALB
  // shares a single throttler bucket. The TRUST_PROXY_HOPS env controls how
  // many proxy hops to trust:
  //   - 0 (default in local dev): never trust X-Forwarded-For
  //   - 1 (default in prod): trust a single proxy in front of the app
  //   - N: trust N proxies (e.g. CloudFront → ALB → app would be 2)
  // Setting this too high lets clients spoof their IP via X-Forwarded-For.
  // See https://expressjs.com/en/guide/behind-proxies.html for the semantics.
  const trustProxyHops = parseInt(
    process.env.TRUST_PROXY_HOPS ??
      (process.env.NODE_ENV === 'production' ? '1' : '0'),
    10,
  );
  const expressApp = app.getHttpAdapter().getInstance() as {
    set: (k: string, v: unknown) => void;
  };

  expressApp.set(
    'trust proxy',
    Number.isFinite(trustProxyHops) ? trustProxyHops : 0,
  );

  // Global prefix
  app.setGlobalPrefix('api/v1');

  // Single source of truth for the CORS Access-Control-Allow-Headers list.
  // Used by BOTH the custom SiteStudio preflight middleware below AND the
  // global `app.enableCors({ allowedHeaders: ... })` block — these two must
  // stay byte-identical or browsers preflight one list while the app
  // enforces another.
  //
  // `X-Tenant-Slug` + `X-Forwarded-Host` were added for subdomain mode;
  // both are server-stamped (middleware / reverse proxy), never client-supplied,
  // but the browser preflight requires them in the allow-list when ANY request
  // might include them.
  const CORS_ALLOWED_HEADERS = [
    'Authorization',
    'Content-Type',
    'X-Organization-Id',
    'X-Tenant-Slug',
    'X-Forwarded-Host',
    'X-Requested-With',
    'X-Wiki-Schema',
  ] as const;

  // CORS — accept multiple origins via comma-separated ALLOWED_ORIGINS env var.
  // credentials:true requires explicit origins (cannot use '*'); browsers won't accept
  // cross-origin Set-Cookie without it.
  const rawOrigins =
    process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '';

  // Fail-loud guard: in production, never accept a localhost fallback. A
  // missing CORS allowlist in prod is a deploy mistake, not a default to
  // paper over.
  if (process.env.NODE_ENV === 'production' && !rawOrigins.trim()) {
    throw new Error(
      'CORS allowlist not configured: set ALLOWED_ORIGINS (comma-separated) or FRONTEND_URL',
    );
  }

  const allowedOrigins = (rawOrigins || 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const supabaseAdmin = app.get(SupabaseAdminService);
  const siteStudioOriginCache = new Map<string, OriginCacheEntry>();
  // Read from the environment rather than ConfigService: this middleware is installed
  // before the router, on the raw Express app, so it must not depend on Nest DI. Same
  // parsing as config/configuration.ts's onPrem.enabled.
  const isOnPremiseDeployment = ['true', '1', 'yes'].includes(
    (process.env.IS_ON_PREMISE ?? '').trim().toLowerCase(),
  );

  app.use(
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const origin = req.headers.origin;
      const path = req.path || req.url || '';

      if (!origin || !isPublicSiteStudioCorsPath(path)) {
        next();
        return;
      }

      const allowed =
        isAllowedConfiguredOrSubdomainOrigin(origin, allowedOrigins) ||
        (await isVerifiedSiteStudioCustomDomainOrigin(
          origin,
          supabaseAdmin.getClient() as unknown as SupabaseLookupClient,
          siteStudioOriginCache,
          Date.now(),
          undefined,
          // On-prem only: allow an http:// custom-domain origin. Such a deployment may
          // legitimately terminate TLS at an upstream LB and forward plain HTTP, or be
          // mid-bring-up before certificates exist. Cloud stays https-only.
          isOnPremiseDeployment,
        ));

      if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader(
          'Access-Control-Allow-Methods',
          'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        );
        res.setHeader(
          'Access-Control-Allow-Headers',
          CORS_ALLOWED_HEADERS.join(','),
        );
        res.setHeader('Access-Control-Max-Age', '86400');
      }

      if (req.method === 'OPTIONS') {
        res.status(allowed ? 204 : 403).send();
        return;
      }

      next();
    },
  );

  app.enableCors({
    origin: (origin, cb) => {
      // Allow same-origin / non-browser callers (curl, server-to-server) with no Origin header.
      if (!origin) return cb(null, true);

      // Tenant subdomain mode serves the app from customer subdomains while the
      // browser calls the API origin directly. Accept either exact configured
      // origins or subdomains under those configured roots; authorization still
      // comes from the auth guard's membership checks, never from Origin.
      if (isAllowedConfiguredOrSubdomainOrigin(origin, allowedOrigins)) {
        return cb(null, true);
      }

      // Disallow without throwing: omitting Access-Control-Allow-Origin is
      // sufficient for browsers to block the response. Throwing here would
      // surface as a 500 on the server side, which is misleading.
      //
      // Log it: a rejection here is invisible server-side but surfaces in the
      // browser as a bare "CORS error" with no status, which is indistinguishable
      // from a proxy-level rejection or a pre-cors() body-parser error. Without
      // this line there is no way to tell those apart from production logs.
      Logger.warn(
        `[cors] rejected origin=${origin} allowed=[${allowedOrigins.join(', ')}]`,
        'CORS',
      );

      return cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    // Without these a cross-origin browser cannot read the file name the server chose, or how
    // long a 429 asks it to wait (the frontend's retry policy honours Retry-After).
    exposedHeaders: ['Content-Disposition', 'Retry-After'],
    credentials: true,
    maxAge: 86400,
  });

  // Pre-router error handler.
  //
  // The body parsers (10mb json/urlencoded) run BEFORE cors() and before Nest's
  // router. AllExceptionsFilter is a Nest filter, not Express error middleware,
  // so it never sees their failures: a 413 (payload too large) or a 400 (malformed
  // JSON) fell through to Express's DEFAULT handler and was returned as HTML with
  // NO Access-Control-Allow-Origin. The browser cannot read such a response and
  // reports it as a generic "CORS error" — which is how a plain oversized-payload
  // failure ends up looking like a header problem in the console.
  //
  // Registered here (after enableCors, still before the router) so it catches
  // everything registered above it. Errors raised inside Nest are handled by
  // AllExceptionsFilter and never reach this handler; if a response has already
  // started we delegate to Express rather than trying to rewrite headers.
  app.use(
    (err: unknown, req: Request, res: Response, next: NextFunction): void => {
      if (res.headersSent) {
        next(err);

        return;
      }

      const origin = req.headers.origin;

      if (
        typeof origin === 'string' &&
        origin.length > 0 &&
        isAllowedConfiguredOrSubdomainOrigin(origin, allowedOrigins)
      ) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
      }

      const candidate = err as {
        status?: unknown;
        statusCode?: unknown;
        message?: unknown;
      };
      const rawStatus =
        typeof candidate?.status === 'number'
          ? candidate.status
          : typeof candidate?.statusCode === 'number'
            ? candidate.statusCode
            : 500;
      const status = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
      const message =
        typeof candidate?.message === 'string'
          ? candidate.message
          : 'Request failed';

      Logger.warn(
        `[pre-router] ${req.method} ${req.originalUrl} -> ${status}: ${message}`,
        'Bootstrap',
      );

      // Same envelope AllExceptionsFilter emits, so clients parse it identically.
      res.status(status).json({
        statusCode: status,
        hasError: true,
        data: null,
        message,
      });
    },
  );

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Global filters & interceptors
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new ResponseInterceptor(),
  );

  // Swagger API Documentation. SWAGGER_ENABLED=false (on-prem) leaves /api/v1/docs a 404.
  const swaggerEnabled = isSwaggerEnabled();
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('XISUITE API')
      .setDescription(
        'Backend API for the XISUITE risk management platform. ' +
          'Provides authentication, authorization, invitation management, ' +
          'and permission-based access control powered by Supabase Auth.',
      )
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Enter the Supabase access token obtained from supabase.auth.getSession()',
        },
        'bearer',
      )
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'xis_tm_ API key or access token',
          description:
            'A Test Management API key (xis_tm_…) or an access token from POST /test-management/authenticate. Accepted only on the routes that list this scheme.',
        },
        'tm-api-key',
      )
      .addTag('Health', 'API health check')
      .addTag(
        'Authentication',
        'User signup, verification, and password recovery',
      )
      .addTag(
        'Invitations',
        'Organization and space invitation management (CRUD, accept, resend)',
      )
      .addTag(
        'test-management',
        'Test cases, executions and results; CI pipelines call the routes marked tm-api-key with an API key or access token',
      )
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/v1/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'list',
        filter: true,
        showRequestDuration: true,
      },
    });
  }

  // SIGTERM/SIGINT run the Nest shutdown hooks: readiness flips to 503, the automation scheduler
  // drains and releases its lease, then the HTTP server closes.
  app.enableShutdownHooks();

  const port = process.env.PORT || 3001;
  await app.listen(port);

  // Behind a cloud load balancer, Node's 5s keep-alive default is shorter than the LB's idle
  // timeout, so the LB reuses sockets Node already closed (sporadic 502s). Opt-in: unset = unchanged.
  const keepAliveMs = Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS);
  if (keepAliveMs > 0) {
    const server = app.getHttpServer();
    server.keepAliveTimeout = keepAliveMs;
    server.headersTimeout = keepAliveMs + 1000;
  }

  // Without Redis the throttler counts per process, so N replicas multiply every limit by N.
  if (
    process.env.DEPLOY_PLATFORM?.toLowerCase() === 'kubernetes' &&
    !process.env.REDIS_URL
  ) {
    Logger.warn(
      '[throttle] DEPLOY_PLATFORM=kubernetes without REDIS_URL — rate limits are per pod, so each replica multiplies the effective limit. Set REDIS_URL.',
      'Bootstrap',
    );
  }

  // Boot diagnostics. Each line is a single grep target for prod ops:
  //  - [jwt-secret] — first 8 chars of SHA-256(SUPABASE_JWT_SECRET). The Next.js
  //    middleware logs the same prefix on first verified request. Mismatch ⇒
  //    JWT secrets are not in sync across tiers ⇒ silent 401 cascade.
  //  - [cookies] — resolved cookie config. Cross-subdomain prod needs
  //    sameSite=none, secure=true, domain set to the apex (e.g. .xisuite.cloud).
  const configService = app.get(ConfigService);
  const jwtSecret = configService.get<string>('supabase.jwtSecret') ?? '';
  const jwtSecretFingerprint = jwtSecret
    ? createHash('sha256').update(jwtSecret).digest('hex').slice(0, 8)
    : 'MISSING';
  const cookies = configService.get<{
    domain: string;
    secure: boolean;
    sameSite: string;
    accessMaxAge: number;
    refreshMaxAge: number;
  }>('cookies');

  Logger.log(`Application running on port ${port}`, 'Bootstrap');
  if (swaggerEnabled) {
    Logger.log(
      `Swagger docs at http://localhost:${port}/api/v1/docs`,
      'Bootstrap',
    );
  }
  Logger.log(`[jwt-secret] sha256=${jwtSecretFingerprint}`, 'Bootstrap');
  Logger.log(
    `[cookies] domain=${cookies?.domain || '(host-only)'} sameSite=${cookies?.sameSite} secure=${cookies?.secure} accessMaxAge=${cookies?.accessMaxAge}s refreshMaxAge=${cookies?.refreshMaxAge}s`,
    'Bootstrap',
  );
}
void bootstrap();
