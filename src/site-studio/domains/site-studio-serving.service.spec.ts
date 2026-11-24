/**
 * @fileoverview Specs for the on-prem serving probe — the check whose absence let a
 * custom domain report "Live" while every visitor got ERR_SSL_PROTOCOL_ERROR.
 * @module src/site-studio/domains/site-studio-serving.service.spec
 * @author Prince Jadiya
 */
import type { ConfigService } from '@nestjs/config';
import * as tls from 'tls';

import { SiteStudioServingService } from './site-studio-serving.service';

jest.mock('tls');

const connectMock = tls.connect as unknown as jest.Mock<
  unknown,
  [tls.ConnectionOptions, () => void]
>;

/** A fake TLS socket whose handshake either succeeds or errors. */
function socketThat(outcome: 'connect' | 'error' | 'timeout') {
  const handlers: Record<string, (arg?: unknown) => void> = {};

  const socket = {
    on(event: string, cb: (arg?: unknown) => void) {
      handlers[event] = cb;

      return socket;
    },
    destroy: jest.fn(),
  };

  connectMock.mockImplementation((_opts: unknown, onSecure: () => void) => {
    // Defer so the caller can attach its error/timeout handlers first, exactly as the
    // real socket does.
    setImmediate(() => {
      if (outcome === 'connect') onSecure();
      else if (outcome === 'error') {
        handlers['error']?.(new Error('wrong version number'));
      } else handlers['timeout']?.();
    });

    return socket;
  });

  return socket;
}

function makeService(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'onPrem.enabled': true,
    'siteStudio.edgeHost': 'app.acme.com',
    'siteStudio.edgePort': 443,
    'siteStudio.customDomains': ['landing.customer.com'],
    'siteStudio.assumeExternalTls': false,
    appUrl: 'https://app.acme.com',
    ...overrides,
  };

  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;

  return new SiteStudioServingService(config);
}

/** Typed view of the options the service passed to tls.connect on its first call. */
function firstConnectOptions(): tls.ConnectionOptions {
  return connectMock.mock.calls[0][0];
}

describe('SiteStudioServingService.probe', () => {
  beforeEach(() => {
    connectMock.mockReset();
  });

  it('reports served when the edge completes a handshake for the SNI', async () => {
    socketThat('connect');
    const svc = makeService();

    const result = await svc.probe('landing.customer.com');

    expect(result.served).toBe(true);
    expect(result.reason).toBe('served');
    // The whole point: SNI must carry the CUSTOMER's hostname, not our edge's, because
    // that is the handshake a visitor performs and the one that currently fails.
    expect(firstConnectOptions()).toMatchObject({
      host: 'app.acme.com',
      port: 443,
      servername: 'landing.customer.com',
    });
  });

  it('reports NOT served when the handshake fails — the reported bug', async () => {
    socketThat('error');
    const svc = makeService();

    const result = await svc.probe('landing.customer.com');

    expect(result.served).toBe(false);
    expect(result.reason).toBe('handshake-failed');
    expect(result.hint).toContain('certificate');
  });

  it('names the exact fix when the domain was never declared in client.conf', async () => {
    socketThat('error');
    const svc = makeService({
      'siteStudio.customDomains': ['other.example.com'],
    });

    const result = await svc.probe('landing.customer.com');

    expect(result.served).toBe(false);
    expect(result.reason).toBe('undeclared');
    expect(result.hint).toContain('SITE_STUDIO_CUSTOM_DOMAINS');
  });

  it('treats a handshake timeout as not served', async () => {
    socketThat('timeout');
    const svc = makeService();

    await expect(svc.probe('landing.customer.com')).resolves.toMatchObject({
      served: false,
    });
  });

  it('trusts the operator when an upstream LB owns TLS, without connecting', async () => {
    socketThat('error'); // would fail if it were actually probed
    const svc = makeService({ 'siteStudio.assumeExternalTls': true });

    const result = await svc.probe('landing.customer.com');

    expect(result.served).toBe(true);
    expect(result.reason).toBe('external-tls-assumed');
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('says so instead of guessing when the edge host is unknown', async () => {
    const svc = makeService({
      'siteStudio.edgeHost': undefined,
      appUrl: undefined,
    });

    const result = await svc.probe('landing.customer.com');

    expect(result.served).toBe(false);
    expect(result.reason).toBe('not-configured');
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('falls back to the app host when edgeHost is absent (older backend.env)', async () => {
    socketThat('connect');
    const svc = makeService({ 'siteStudio.edgeHost': undefined });

    await svc.probe('landing.customer.com');

    expect(firstConnectOptions()).toMatchObject({
      host: 'app.acme.com',
    });
  });

  it('caches a verdict so a tab refresh is not one TLS connection per domain', async () => {
    socketThat('connect');
    const svc = makeService();

    await svc.probe('landing.customer.com');
    await svc.probe('landing.customer.com');

    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('invalidate() lets a just-fixed domain flip without waiting for the TTL', async () => {
    socketThat('error');
    const svc = makeService();

    await expect(svc.probe('landing.customer.com')).resolves.toMatchObject({
      served: false,
    });

    socketThat('connect'); // operator ran ./deploy.sh
    svc.invalidate('landing.customer.com');

    await expect(svc.probe('landing.customer.com')).resolves.toMatchObject({
      served: true,
    });
  });

  it('normalizes case and whitespace, and rejects an empty host', async () => {
    socketThat('connect');
    const svc = makeService();

    await svc.probe('  LANDING.Customer.com ');
    expect(firstConnectOptions()).toMatchObject({
      servername: 'landing.customer.com',
    });

    await expect(svc.probe('   ')).resolves.toMatchObject({ served: false });
  });
});
