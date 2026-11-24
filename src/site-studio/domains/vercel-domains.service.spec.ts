import type { ConfigService } from '@nestjs/config';

import { VercelDomainsService } from './vercel-domains.service';

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('VercelDomainsService', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  describe('feature flag (unconfigured)', () => {
    it('is not configured when token/projectId are missing', () => {
      expect(new VercelDomainsService(makeConfig({})).isConfigured()).toBe(
        false,
      );
      expect(
        new VercelDomainsService(
          makeConfig({ 'vercel.token': 't' }),
        ).isConfigured(),
      ).toBe(false);
    });

    it('no-ops every method without hitting the network', async () => {
      const fetchMock = jest.fn();

      global.fetch = fetchMock as unknown as typeof fetch;
      const svc = new VercelDomainsService(makeConfig({}));

      await expect(svc.addDomain('docs.acme.com')).resolves.toEqual({
        ok: false,
        verification: [],
      });
      await expect(svc.getStatus('docs.acme.com')).resolves.toEqual({
        status: 'pending',
        misconfigured: false,
        verification: [],
        attached: false,
      });
      await expect(svc.removeDomain('docs.acme.com')).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('configured', () => {
    function configured(): VercelDomainsService {
      return new VercelDomainsService(
        makeConfig({
          'vercel.token': 'tok',
          'vercel.projectId': 'proj',
          'vercel.teamId': 'team',
        }),
      );
    }

    it('adds a domain (200 OK => ok:true)', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(configured().addDomain('docs.acme.com')).resolves.toEqual({
        ok: true,
        verification: [],
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('surfaces Vercel verification records from the add response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          verified: false,
          verification: [
            {
              type: 'TXT',
              domain: '_vercel.docs.acme.com',
              value: 'vc-domain-verify=abc',
              reason: 'pending',
            },
          ],
        }),
      }) as unknown as typeof fetch;

      const res = await configured().addDomain('docs.acme.com');

      expect(res.ok).toBe(true);
      expect(res.verification).toEqual([
        {
          type: 'TXT',
          name: '_vercel.docs.acme.com',
          value: 'vc-domain-verify=abc',
        },
      ]);
    });

    it('treats a 409 as idempotent success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({}),
      }) as unknown as typeof fetch;

      await expect(
        configured().addDomain('docs.acme.com'),
      ).resolves.toMatchObject({ ok: true });
    });

    it('returns ok:false on a genuine add failure', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'forbidden' } }),
      }) as unknown as typeof fetch;

      await expect(configured().addDomain('docs.acme.com')).resolves.toEqual({
        ok: false,
        verification: [],
      });
    });

    it('reports active only when verified AND not misconfigured', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ verified: true }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ misconfigured: false }),
        }) as unknown as typeof fetch;

      await expect(
        configured().getStatus('docs.acme.com'),
      ).resolves.toMatchObject({
        status: 'active',
        misconfigured: false,
        attached: true,
      });
    });

    it('reports pending + the outstanding record when not yet verified', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            verified: false,
            verification: [
              { type: 'TXT', domain: '_vercel.docs.acme.com', value: 'vc=1' },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ misconfigured: true }),
        }) as unknown as typeof fetch;

      const res = await configured().getStatus('docs.acme.com');

      expect(res.status).toBe('pending');
      expect(res.misconfigured).toBe(true);
      expect(res.verification).toHaveLength(1);
    });

    it('reports pending + attached:false when the domain is not on the project (404)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
      }) as unknown as typeof fetch;

      await expect(
        configured().getStatus('docs.acme.com'),
      ).resolves.toMatchObject({ status: 'pending', attached: false });
    });

    it('never throws — a network error surfaces as error status', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('down')) as unknown as typeof fetch;

      await expect(
        configured().getStatus('docs.acme.com'),
      ).resolves.toMatchObject({ status: 'error' });
      await expect(
        configured().removeDomain('docs.acme.com'),
      ).resolves.toBeUndefined();
    });
  });
});
