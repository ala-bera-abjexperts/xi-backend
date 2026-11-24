/**
 * @fileoverview Env switches for HTTP hardening, written by the on-prem deploy into
 * backend.env. Both default to on (unset = today's cloud behaviour); only an explicit
 * `false`/`0` turns them off.
 * @module src/common/http-hardening
 */
import type { HelmetOptions } from 'helmet';

const isOff = (v: string | undefined) =>
  ['false', '0'].includes((v ?? '').trim().toLowerCase());

/** `SWAGGER_ENABLED=false|0` → `/api/v1/docs` is not mounted (404). */
export const isSwaggerEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  !isOff(env.SWAGGER_ENABLED);

/** `HSTS_ENABLED=false|0` → no Strict-Transport-Security header (plain-HTTP installs). */
export const helmetOptions = (
  env: NodeJS.ProcessEnv = process.env,
): HelmetOptions =>
  isOff(env.HSTS_ENABLED) ? { strictTransportSecurity: false } : {};
