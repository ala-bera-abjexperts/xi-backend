/**
 * @fileoverview Proves whether a SiteStudio custom domain is ACTUALLY served by this
 * deployment's edge, instead of assuming it. On-prem only.
 * @module src/site-studio/domains/site-studio-serving
 * @author Prince Jadiya
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as tls from 'tls';

/** Why a domain is (not) considered served — surfaced to the UI as guidance. */
export type ServingProbeReason =
  | 'served'
  | 'external-tls-assumed'
  | 'not-configured'
  | 'undeclared'
  | 'handshake-failed'
  | 'unreachable';

export interface ServingProbeResult {
  served: boolean;
  reason: ServingProbeReason;
  /** Operator-facing next step. Empty when `served`. */
  hint: string;
}

/**
 * The problem this exists to solve:
 *
 * On-prem, `DomainsService` used to mark every verified custom domain
 * `ssl_status='active'` unconditionally, so the UI showed a green **Live** chip. But the
 * on-prem edge only serves the hostnames it was configured with — a TLS ClientHello whose
 * SNI matches no site block gets no certificate and the handshake aborts. The result was a
 * domain reported Live while every visitor saw `ERR_SSL_PROTOCOL_ERROR`, with nothing
 * anywhere contradicting the claim.
 *
 * So we perform the visitor's own handshake: connect to our edge (reachable in-cluster via
 * the proxy's network alias) with SNI set to the customer's hostname. If the edge has a
 * certificate for that name the handshake completes; if it doesn't, it fails exactly as the
 * browser's would.
 *
 * We deliberately do NOT validate the certificate chain or hostname
 * (`rejectUnauthorized: false`). On-prem edges legitimately serve self-signed or internal-CA
 * certificates; the question here is "is this hostname routed and terminated at all", not
 * "would a public browser trust it". Applying full validation would report every selfsigned
 * deployment as broken. This mirrors the deploy script's own `_node_trusts_edge_ca` probe,
 * which sets `checkServerIdentity` aside for the same reason.
 */
@Injectable()
export class SiteStudioServingService {
  private readonly logger = new Logger(SiteStudioServingService.name);

  /** A handshake is fast or it is broken; visitors will not wait either. */
  private static readonly TIMEOUT_MS = 3_000;

  /**
   * Short-lived memo. `getDomains()` runs on every Domains-tab render and the cron sweeps
   * in batches, so without this a handful of domains would open a TLS connection per
   * request. Success is cached longer than failure: a working domain rarely stops working
   * mid-minute, while an operator who has just fixed one wants to see it flip quickly.
   */
  private static readonly TTL_OK_MS = 60_000;
  private static readonly TTL_FAIL_MS = 15_000;
  private readonly cache = new Map<
    string,
    { at: number; ttl: number; result: ServingProbeResult }
  >();

  constructor(private readonly config: ConfigService) {}

  private get isOnPremise(): boolean {
    return this.config.get<boolean>('onPrem.enabled') === true;
  }

  private get assumeExternalTls(): boolean {
    return this.config.get<boolean>('siteStudio.assumeExternalTls') === true;
  }

  private get edgeHost(): string | null {
    const configured = this.config.get<string>('siteStudio.edgeHost');

    if (configured) return configured;

    // Fall back to the app host so an older on-prem stack, whose backend.env predates
    // SITE_STUDIO_EDGE_HOST, still probes something meaningful instead of silently
    // degrading to "cannot check" on every domain.
    const appUrl = this.config.get<string>('appUrl');

    if (!appUrl) return null;

    try {
      return new URL(appUrl).hostname;
    } catch {
      return null;
    }
  }

  private get edgePort(): number {
    const configured = this.config.get<number>('siteStudio.edgePort');

    return Number.isFinite(configured) && Number(configured) > 0
      ? Number(configured)
      : 443;
  }

  /** Domains the deploy script says this edge was configured to serve. */
  private get declaredDomains(): string[] {
    return this.config.get<string[]>('siteStudio.customDomains') ?? [];
  }

  /** True when the edge serves any verified domain without a per-domain declaration. */
  private get autoDomains(): boolean {
    return this.config.get<boolean>('siteStudio.autoDomains') === true;
  }

  /**
   * Is `domain` served by this deployment?
   *
   * Cloud never calls this (Vercel owns serving and reports its own status). On-prem it is
   * the difference between a status the operator can trust and one that is merely hopeful.
   */
  async probe(domain: string): Promise<ServingProbeResult> {
    const host = domain.trim().toLowerCase();

    if (!host) {
      return {
        served: false,
        reason: 'unreachable',
        hint: 'No domain to check.',
      };
    }

    // An upstream load balancer terminates TLS. We cannot see it from in here, and a probe
    // against our own edge would fail for a domain that is in fact working perfectly.
    if (this.assumeExternalTls) {
      return {
        served: true,
        reason: 'external-tls-assumed',
        hint: '',
      };
    }

    const cached = this.cache.get(host);

    if (cached && Date.now() - cached.at < cached.ttl) return cached.result;

    const result = await this.runProbe(host);

    this.cache.set(host, {
      at: Date.now(),
      ttl: result.served
        ? SiteStudioServingService.TTL_OK_MS
        : SiteStudioServingService.TTL_FAIL_MS,
      result,
    });

    return result;
  }

  /** Drop a cached verdict so a just-fixed domain flips on the next read. */
  invalidate(domain: string): void {
    this.cache.delete(domain.trim().toLowerCase());
  }

  private async runProbe(host: string): Promise<ServingProbeResult> {
    const edge = this.edgeHost;

    if (!edge) {
      return {
        served: false,
        reason: 'not-configured',
        hint: 'This deployment does not know its own edge host, so the domain could not be checked. Re-run ./deploy.sh to refresh backend.env.',
      };
    }

    // In automatic mode there IS no per-domain list, so "you didn't declare it" would be
    // wrong advice. Otherwise, a domain absent from the declared list is the single most
    // likely cause, and naming it beats a generic handshake failure. Either way we still
    // probe first — an operator may serve it from a hand-written vhost.
    const declared = this.declaredDomains;
    const isDeclared =
      this.autoDomains || declared.length === 0 || declared.includes(host);

    const ok = await this.tlsHandshake(edge, this.edgePort, host);

    if (ok) return { served: true, reason: 'served', hint: '' };

    if (!isDeclared) {
      return {
        served: false,
        reason: 'undeclared',
        hint: `This server is not configured to serve "${host}". Either set SITE_STUDIO_AUTO_DOMAINS=1 in client.conf so every verified domain is served automatically, or add this one to SITE_STUDIO_CUSTOM_DOMAINS — then re-run ./deploy.sh.`,
      };
    }

    return {
      served: false,
      reason: 'handshake-failed',
      hint: this.autoDomains
        ? `The edge did not complete a TLS handshake for "${host}". Automatic domains are on, so check that DNS for this hostname points at this server, and that your certificate covers it (a wildcard for the apex, or ./certs/site-studio/${host}.crt and .key).`
        : `The edge did not complete a TLS handshake for "${host}". Check that a certificate covers it (SANs on ./certs/fullchain.pem, or ./certs/site-studio/${host}.crt and .key), then re-run ./deploy.sh.`,
    };
  }

  /**
   * Open a TLS connection to `edgeHost:port` presenting `sni`. Resolves true only when the
   * handshake completes — which is precisely what fails today for an unconfigured hostname.
   */
  private tlsHandshake(
    edgeHost: string,
    port: number,
    sni: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: boolean, socket?: tls.TLSSocket) => {
        if (settled) return;
        settled = true;
        try {
          socket?.destroy();
        } catch {
          // Destroying an already-errored socket is not interesting.
        }
        resolve(value);
      };

      try {
        const socket = tls.connect(
          {
            host: edgeHost,
            port,
            servername: sni,
            // See the class doc: reachability, not trust. An on-prem edge serving a
            // self-signed cert is a supported configuration, not a failure.
            rejectUnauthorized: false,
            timeout: SiteStudioServingService.TIMEOUT_MS,
          },
          () => done(true, socket),
        );

        socket.on('error', (err) => {
          this.logger.debug(
            `serving probe failed for "${sni}" via ${edgeHost}:${port}: ${(err as Error).message}`,
          );
          done(false, socket);
        });
        socket.on('timeout', () => done(false, socket));
      } catch (err) {
        this.logger.debug(
          `serving probe could not start for "${sni}": ${(err as Error).message}`,
        );
        resolve(false);
      }
    });
  }
}
