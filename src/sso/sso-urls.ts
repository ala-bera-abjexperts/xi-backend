/**
 * @fileoverview Public URLs of the SAML service provider and the SCIM endpoint.
 *
 * The SP Entity ID, ACS and metadata URLs are pasted into the customer's IdP,
 * so they are derived from one stable base and the connection id only.
 *
 * @module src/sso/sso-urls
 * @author Prince Jadiya
 */

import type { ConfigService } from '@nestjs/config';

/** Public API base with no trailing slash (env: `PUBLIC_API_URL`). */
function publicApiUrl(config: ConfigService): string {
  return (config.get<string>('publicApiUrl') ?? '').replace(/\/$/, '');
}

/**
 * Base URL the SAML SP routes are served from. `SAML_SP_BASE_URL` must be a
 * browser-facing host under `COOKIE_DOMAIN`, or the ACS cannot set cookies.
 *
 * @param {ConfigService} config - Nest config service
 * @returns {string} The base URL, without a trailing slash
 */
export function getSamlSpBaseUrl(config: ConfigService): string {
  const base = config.get<string>('saml.spBaseUrl');

  return base ? base.replace(/\/$/, '') : publicApiUrl(config);
}

/**
 * SP URLs for one connection. The Entity ID is the metadata URL.
 *
 * @param {string} baseUrl - From {@link getSamlSpBaseUrl}
 * @param {string} connectionId - `sso_connections.id`
 */
export function getSamlSpUrls(
  baseUrl: string,
  connectionId: string,
): {
  spEntityId: string;
  acsUrl: string;
  metadataUrl: string;
  loginUrl: string;
} {
  const root = `${baseUrl}/auth/saml/${connectionId}`;

  return {
    spEntityId: `${root}/metadata`,
    acsUrl: `${root}/acs`,
    metadataUrl: `${root}/metadata`,
    loginUrl: `${root}/login`,
  };
}

/**
 * SCIM 2.0 base URL given to Microsoft Entra ID as the "Tenant URL".
 *
 * @param {ConfigService} config - Nest config service
 */
export function getScimBaseUrl(config: ConfigService): string {
  return `${publicApiUrl(config)}/scim/v2`;
}
