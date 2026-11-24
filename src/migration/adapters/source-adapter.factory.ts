/**
 * @fileoverview Builds the correct source adapter for a decrypted connection.
 *
 * Steps: SSRF-validate the base URL → build an auth strategy + HTTP client → detect Cloud vs
 * Server (hostname heuristic, then a live probe) → return the matching adapter. Throws a
 * descriptive error on any unsafe URL or undetectable target; callers surface it as a failed test.
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { buildAuthStrategy } from './http/auth-strategy';
import { AtlassianHttpClient } from './http/atlassian-http-client';
import { validateBaseUrl } from './http/url-safety';
import { JiraCloudAdapter } from './jira/jira-cloud.adapter';
import { JiraServerAdapter } from './jira/jira-server.adapter';
import { ConfluenceCloudAdapter } from './confluence/confluence-cloud.adapter';
import { ConfluenceServerAdapter } from './confluence/confluence-server.adapter';
import type {
  ISourceAdapter,
  SourceAuthType,
  SourceDeployment,
  SourceProduct,
} from './source-adapter.interface';

export interface DecryptedConnectionContext {
  product: SourceProduct;
  /** Previously verified deployment; null keeps live capability detection. */
  deployment?: SourceDeployment | null;
  baseUrl: string;
  authType: SourceAuthType;
  authUsername?: string | null;
  /** The decrypted credential (password / API token / PAT). */
  secret: string;
  /** Allow RFC1918 targets — set true only for on-prem installs reaching an internal server. */
  allowPrivateNetworks?: boolean;
  /** Allow plain HTTP — required for the on-prem test boxes (http://…:8080). */
  allowInsecureHttp?: boolean;
}

interface JiraServerInfo {
  deploymentType?: string;
}

/** Same derivation as `app.module.ts` — private-network targets are on-prem-only. */
function isOnPremiseDeployment(): boolean {
  return ['true', '1', 'yes'].includes(
    (process.env.IS_ON_PREMISE || '').trim().toLowerCase(),
  );
}

@Injectable()
export class SourceAdapterFactory {
  private readonly logger = new Logger(SourceAdapterFactory.name);

  async create(ctx: DecryptedConnectionContext): Promise<ISourceAdapter> {
    // SSRF guard: an org admin must not be able to probe the SaaS's internal network,
    // so the private-network opt-in is only honored on on-premise deployments.
    const allowPrivateNetworks =
      ctx.allowPrivateNetworks === true && isOnPremiseDeployment();

    const safety = await validateBaseUrl(ctx.baseUrl, {
      allowPrivateNetworks,
      allowInsecureHttp: ctx.allowInsecureHttp,
    });

    if (!safety.ok || !safety.origin) {
      const reason =
        ctx.allowPrivateNetworks === true && !allowPrivateNetworks
          ? `${safety.reason ?? 'unsafe target'} (private-network targets are only allowed on on-premise XISUITE deployments)`
          : (safety.reason ?? 'unsafe target');

      throw new BadRequestException(`Base URL rejected: ${reason}`);
    }

    const auth = buildAuthStrategy(ctx.authType, ctx.secret, ctx.authUsername);
    const http = new AtlassianHttpClient(safety.origin, auth, {
      pinnedIp: safety.resolvedIp,
      // Attachment downloads may 3xx to a media host; re-validate those hops with the same policy.
      allowPrivateNetworks,
      allowInsecureHttp: ctx.allowInsecureHttp,
      // Server/DC installs are routinely under a context path (`/jira`, `/statistik.at/jira`);
      // it used to be discarded with the origin, turning every request into a 404.
      basePath: safety.basePath,
    });
    const isCloudHost = /\.atlassian\.net$/i.test(
      new URL(safety.origin).hostname,
    );

    if (ctx.product === 'jira') {
      if (isCloudHost) return new JiraCloudAdapter(http);
      if (ctx.deployment === 'cloud') return new JiraCloudAdapter(http);
      if (ctx.deployment === 'server') return new JiraServerAdapter(http);

      // serverInfo is available on both Server and Cloud and reports deploymentType.
      const info = await http.getJson<JiraServerInfo>('/rest/api/2/serverInfo');

      return info.deploymentType === 'Cloud'
        ? new JiraCloudAdapter(http)
        : new JiraServerAdapter(http);
    }

    // Confluence
    if (isCloudHost) return new ConfluenceCloudAdapter(http);
    if (ctx.deployment === 'cloud') return new ConfluenceCloudAdapter(http);
    if (ctx.deployment === 'server') return new ConfluenceServerAdapter(http);

    // Cloud exposes /wiki/api/v2; Server/DC 404s it.
    const probe = await http.probe('/wiki/api/v2/spaces?limit=1');

    return probe.ok
      ? new ConfluenceCloudAdapter(http)
      : new ConfluenceServerAdapter(http);
  }
}
