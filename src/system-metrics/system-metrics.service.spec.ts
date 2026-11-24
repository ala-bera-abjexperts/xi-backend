import { totalmem } from 'os';
import { SystemMetricsService, isKubernetesOnPrem } from './system-metrics.service';

/** Test double: cgroup files, environment and the status-service call are injected. */
class TestService extends SystemMetricsService {
  constructor(
    files: Record<string, string | (() => string)>,
    env: NodeJS.ProcessEnv,
    fetchImpl?: typeof fetch,
  ) {
    super();
    this.readText = async (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return typeof v === 'function' ? v() : v;
    };
    this.env = env;
    if (fetchImpl) this.fetchImpl = fetchImpl;
  }
}

const K8S = { IS_ON_PREMISE: 'true', DEPLOY_PLATFORM: 'kubernetes', STATUS_INTERNAL_URL: 'http://status:8080', STATUS_API_TOKEN: 'tok' };
const okFetch = (body: unknown, status = 200) =>
  jest.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

let usage = 1_000_000;
const CGROUP_V2 = {
  '/sys/fs/cgroup/memory.max': '2147483648\n',
  '/sys/fs/cgroup/memory.current': String(600 * 1024 * 1024),
  '/sys/fs/cgroup/memory.stat': `anon 1\ninactive_file ${100 * 1024 * 1024}\nactive_file 5\n`,
  '/sys/fs/cgroup/cpu.max': '50000 100000\n',
  '/sys/fs/cgroup/cpu.stat': () => `usage_usec ${(usage += 50_000)}\nuser_usec 1\n`,
};

describe('isKubernetesOnPrem', () => {
  it('needs both on-prem and DEPLOY_PLATFORM=kubernetes', () => {
    expect(isKubernetesOnPrem({ IS_ON_PREMISE: 'true', DEPLOY_PLATFORM: 'kubernetes' })).toBe(true);
    expect(isKubernetesOnPrem({ IS_ON_PREMISE: '1', DEPLOY_PLATFORM: 'Kubernetes' })).toBe(true);
    expect(isKubernetesOnPrem({ IS_ON_PREMISE: 'false', DEPLOY_PLATFORM: 'kubernetes' })).toBe(false);
    expect(isKubernetesOnPrem({ IS_ON_PREMISE: 'true' })).toBe(false);
    expect(isKubernetesOnPrem({})).toBe(false);
  });
});

describe('SystemMetricsService', () => {
  it('SaaS / Docker: response unchanged, no cluster call', async () => {
    const f = okFetch({ components: [] });
    const s = new TestService({}, { IS_ON_PREMISE: 'false', DEPLOY_PLATFORM: 'kubernetes', ...{ STATUS_INTERNAL_URL: 'x', STATUS_API_TOKEN: 'y' } }, f);
    const m = await s.getMetrics();
    expect(m.scope).toBeUndefined();
    expect(m.cluster).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
    expect(m.ram.limited).toBeUndefined();
  });

  it('Kubernetes: container limits (cgroup v2), working-set memory, pod name, cluster data', async () => {
    const s = new TestService(CGROUP_V2, K8S, okFetch({ components: [{ id: 'api', pods: [] }], warnings: [] }));
    const m = await s.getMetrics();
    expect(m.scope).toBe('pod');
    expect(typeof m.podName).toBe('string');
    expect(m.ram).toMatchObject({ limited: true, totalBytes: 2147483648, usedBytes: 500 * 1024 * 1024, percent: 24.4 });
    expect(m.cpu).toMatchObject({ limited: true, cores: 0.5 });
    expect(m.cpu.percent).toBeGreaterThan(0);
    expect(m.cluster).toMatchObject({ available: true });
  });

  it('Kubernetes without limits ("max"): node figures, flagged as unlimited', async () => {
    const s = new TestService(
      { ...CGROUP_V2, '/sys/fs/cgroup/memory.max': 'max', '/sys/fs/cgroup/cpu.max': 'max 100000' },
      K8S,
      okFetch({ components: [] }),
    );
    const m = await s.getMetrics();
    expect(m.ram).toMatchObject({ limited: false, totalBytes: totalmem() });
    expect(m.cpu.limited).toBe(false);
  });

  it('cgroup v1 is read when v2 files are absent', async () => {
    const s = new TestService(
      {
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(1024 ** 3),
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(512 * 1024 ** 2),
        '/sys/fs/cgroup/memory/memory.stat': 'total_inactive_file 0\n',
      },
      K8S,
      okFetch({ components: [] }),
    );
    const m = await s.getMetrics();
    expect(m.ram).toMatchObject({ limited: true, totalBytes: 1024 ** 3, percent: 50 });
  });

  it('no readable cgroup at all: falls back to the node reading, never throws', async () => {
    const s = new TestService({}, K8S, okFetch({ components: [] }));
    const m = await s.getMetrics();
    expect(m.ram.percent).not.toBeNull();
    expect(m.cpu.cores).toBeGreaterThan(0);
  });

  describe('readCluster', () => {
    it('not configured without URL or token', async () => {
      expect(await new TestService({}, { ...K8S, STATUS_API_TOKEN: '' }).readCluster()).toEqual({ available: false, reason: 'not_configured' });
      expect(await new TestService({}, { ...K8S, STATUS_INTERNAL_URL: '' }).readCluster()).toEqual({ available: false, reason: 'not_configured' });
    });
    it('sends the bearer token to the internal URL', async () => {
      const f = okFetch({ components: [] });
      await new TestService({}, { ...K8S, STATUS_INTERNAL_URL: 'http://status:8080/' }, f).readCluster();
      const [url, init] = (f as unknown as jest.Mock).mock.calls[0];
      expect(url).toBe('http://status:8080/api/v1/cluster');
      expect(init.headers.Authorization).toBe('Bearer tok');
    });
    it('maps failures to reasons', async () => {
      expect(await new TestService({}, K8S, okFetch({}, 401)).readCluster()).toEqual({ available: false, reason: 'unauthorized' });
      expect(await new TestService({}, K8S, okFetch({}, 404)).readCluster()).toEqual({ available: false, reason: 'unauthorized' });
      expect(await new TestService({}, K8S, okFetch({}, 500)).readCluster()).toEqual({ available: false, reason: 'error' });
      expect(await new TestService({}, K8S, okFetch({ nope: 1 })).readCluster()).toEqual({ available: false, reason: 'error' });
      const boom = jest.fn(async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      expect(await new TestService({}, K8S, boom).readCluster()).toEqual({ available: false, reason: 'unreachable' });
    });
    it('a status-service outage never removes the pod metrics', async () => {
      const boom = jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;
      const m = await new TestService(CGROUP_V2, K8S, boom).getMetrics();
      expect(m.cluster).toEqual({ available: false, reason: 'unreachable' });
      expect(m.ram.percent).toBe(24.4);
    });
  });
});
