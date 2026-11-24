/**
 * @fileoverview Reads this backend process's host CPU/RAM/disk for the on-prem
 * "System Overview" tab. Single-instance assumption: this reads the answering
 * container's own view of the machine, same as the lease-id pattern in
 * backup.constants.ts / migration-cron.service.ts — accurate for the current
 * one-VPS deployment, would need revisiting if this backend is ever scaled to
 * multiple replicas.
 * @module src/system-metrics/system-metrics.service
 */
import { Injectable, Logger } from '@nestjs/common';
import { cpus, freemem, hostname, totalmem } from 'os';
import { readFile } from 'fs/promises';
import checkDiskSpace from 'check-disk-space';
import type {
  IClusterHealth,
  INodeProcessInfo,
  ISystemCpuMetric,
  ISystemDiskMetric,
  ISystemMetrics,
  ISystemRamMetric,
} from './interfaces/system-metrics.interface';

/** Delay between the two os.cpus() samples used to compute a real (not cumulative-since-boot) CPU %. */
const CPU_SAMPLE_INTERVAL_MS = 200;

/** Named so the "alert when free space < 10GB" threshold isn't a magic number at the call site. */
export const HDD_ALERT_THRESHOLD_BYTES = 10 * 1024 ** 3;

/** Status service call budget: the tab must stay fast even when that service hangs. */
const CLUSTER_TIMEOUT_MS = 3_000;

/** cgroup v1 reports "no limit" as a huge number (PAGE_COUNTER_MAX), not "max". */
const CGROUP_V1_UNLIMITED = 2 ** 60;

/** On-prem Kubernetes/OpenShift only. SaaS and Docker installs never take these code paths. */
export function isKubernetesOnPrem(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    /^(1|true|yes|on)$/i.test(env.IS_ON_PREMISE ?? '') &&
    (env.DEPLOY_PLATFORM ?? '').toLowerCase() === 'kubernetes'
  );
}

function snapshotCpuTicks() {
  return cpus().map((core) => {
    const { user, nice, sys, idle, irq } = core.times;

    return { idle, total: user + nice + sys + idle + irq };
  });
}

@Injectable()
export class SystemMetricsService {
  private readonly logger = new Logger(SystemMetricsService.name);

  /** Overridable in tests (cgroup files, environment, network). */
  protected readText = (path: string) => readFile(path, 'utf8');
  protected env: NodeJS.ProcessEnv = process.env;
  protected fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  private async readNumber(path: string): Promise<number | null> {
    try {
      const v = (await this.readText(path)).trim();
      if (v === 'max') return Infinity;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /** Container memory: limit and working set (usage minus inactive file cache, as `kubectl top`). */
  private async readPodRam(): Promise<ISystemRamMetric> {
    try {
      let limit = await this.readNumber('/sys/fs/cgroup/memory.max');
      let usage = await this.readNumber('/sys/fs/cgroup/memory.current');
      let statPath = '/sys/fs/cgroup/memory.stat';
      let inactiveKey = 'inactive_file';
      if (usage === null) {
        limit = await this.readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes');
        usage = await this.readNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes');
        statPath = '/sys/fs/cgroup/memory/memory.stat';
        inactiveKey = 'total_inactive_file';
      }
      if (usage === null) return this.readRam(); // no readable cgroup: node figures as before
      let inactive = 0;
      try {
        const m = new RegExp(`^${inactiveKey} (\\d+)$`, 'm').exec(await this.readText(statPath));
        if (m) inactive = Number(m[1]);
      } catch {
        /* working set falls back to raw usage */
      }
      const usedBytes = Math.max(0, usage - inactive);
      const limited = limit !== null && Number.isFinite(limit) && limit < CGROUP_V1_UNLIMITED;
      const totalBytes = limited ? (limit as number) : totalmem();
      return {
        percent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null,
        usedBytes,
        totalBytes,
        limited,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`readPodRam failed: ${message}`);
      return { ...this.readRam(), limited: false };
    }
  }

  /** Container CPU: its own usage over the sample window, against its limit (or the node's cores). */
  private async readPodCpu(): Promise<ISystemCpuMetric> {
    try {
      const usageMicros = async (): Promise<number | null> => {
        try {
          const m = /^usage_usec (\d+)$/m.exec(await this.readText('/sys/fs/cgroup/cpu.stat'));
          if (m) return Number(m[1]);
        } catch {
          /* try v1 */
        }
        const ns = await this.readNumber('/sys/fs/cgroup/cpuacct/cpuacct.usage');
        return ns === null ? null : ns / 1000;
      };
      let limitCores: number | null = null;
      try {
        const [quota, period] = (await this.readText('/sys/fs/cgroup/cpu.max')).trim().split(/\s+/);
        if (quota !== 'max' && Number(period) > 0) limitCores = Number(quota) / Number(period);
      } catch {
        const quota = await this.readNumber('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
        const period = await this.readNumber('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
        if (quota !== null && quota > 0 && period) limitCores = quota / period;
      }
      const before = await usageMicros();
      const t0 = Date.now();
      await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_INTERVAL_MS));
      const after = await usageMicros();
      if (before === null || after === null) return this.readCpu(); // no cgroup: node figures
      const elapsedMicros = Math.max(1, (Date.now() - t0) * 1000);
      const usedCores = Math.max(0, after - before) / elapsedMicros;
      const limited = limitCores !== null && limitCores > 0;
      const cores = limited ? (limitCores as number) : cpus().length;
      return {
        percent: cores > 0 ? Math.min(100, Math.round((usedCores / cores) * 1000) / 10) : null,
        cores: Math.round(cores * 100) / 100,
        limited,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`readPodCpu failed: ${message}`);
      return { ...(await this.readCpu()), limited: false };
    }
  }

  /**
   * Every component and pod, from the in-cluster status service (it holds the read-only
   * Kubernetes role; this backend has none). Any failure is a reason, never an exception.
   */
  async readCluster(): Promise<IClusterHealth> {
    const base = (this.env.STATUS_INTERNAL_URL ?? '').trim().replace(/\/+$/, '');
    const token = (this.env.STATUS_API_TOKEN ?? '').trim();
    if (!base || !token) return { available: false, reason: 'not_configured' };
    try {
      const res = await this.fetchImpl(`${base}/api/v1/cluster`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(CLUSTER_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        return { available: false, reason: 'unauthorized' };
      }
      if (!res.ok) return { available: false, reason: 'error' };
      const body = (await res.json()) as Record<string, unknown>;
      if (!Array.isArray(body?.components)) return { available: false, reason: 'error' };
      return { ...(body as object), available: true } as IClusterHealth;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`readCluster failed: ${message}`);
      return { available: false, reason: 'unreachable' };
    }
  }

  /**
   * A single os.cpus() read is cumulative ticks since boot, not instantaneous load — sampling
   * once and reporting it directly is a well-known correctness bug. Two samples ~200ms apart
   * and the idle/total delta between them gives the actual percentage busy over that window.
   */
  private async readCpu(): Promise<ISystemCpuMetric> {
    try {
      const before = snapshotCpuTicks();

      await new Promise((resolve) =>
        setTimeout(resolve, CPU_SAMPLE_INTERVAL_MS),
      );

      const after = snapshotCpuTicks();

      if (before.length === 0 || before.length !== after.length) {
        throw new Error(
          'os.cpus() returned no cores or an inconsistent core count',
        );
      }

      const perCorePercent = before.map((b, i) => {
        const a = after[i];
        const idleDelta = a.idle - b.idle;
        const totalDelta = a.total - b.total;

        return totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;
      });

      const percent =
        perCorePercent.reduce((sum, p) => sum + p, 0) / perCorePercent.length;

      return { percent: Math.round(percent * 10) / 10, cores: before.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      this.logger.warn(`readCpu failed: ${message}`);

      return { percent: null, cores: null, error: message };
    }
  }

  private readRam(): ISystemRamMetric {
    try {
      const totalBytes = totalmem();
      const freeBytes = freemem();
      const usedBytes = totalBytes - freeBytes;

      return {
        percent:
          totalBytes > 0
            ? Math.round((usedBytes / totalBytes) * 1000) / 10
            : null,
        usedBytes,
        totalBytes,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      this.logger.warn(`readRam failed: ${message}`);

      return {
        percent: null,
        usedBytes: null,
        totalBytes: null,
        error: message,
      };
    }
  }

  /**
   * Path is configurable (SYSTEM_METRICS_DISK_PATH) rather than hardcoded: a container's `/`
   * may not be the volume actually backed by the host's real disk, and only ops knows which
   * mount point is the one that matters for a given deployment.
   */
  private async readDisk(): Promise<ISystemDiskMetric> {
    const path = process.env.SYSTEM_METRICS_DISK_PATH?.trim() || '/';

    try {
      const { free, size } = await checkDiskSpace(path);

      return {
        percent:
          size > 0 ? Math.round(((size - free) / size) * 1000) / 10 : null,
        freeBytes: free,
        totalBytes: size,
        path,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      this.logger.warn(`readDisk failed for path "${path}": ${message}`);

      return {
        percent: null,
        freeBytes: null,
        totalBytes: null,
        path,
        error: message,
      };
    }
  }

  /**
   * This server's own live Node.js process(es) — deliberately NOT a host-wide `ps` scan, which
   * would expose unrelated services or other users' processes on a shared box. Today that is
   * always exactly one entry (this process); the array shape stays correct if that ever changes.
   *
   * Same two-sample delta technique as readCpu(): `process.cpuUsage()` returns cumulative
   * microseconds since process start, so a single read would only ever grow, never reflect
   * current load.
   */
  private async readProcesses(): Promise<INodeProcessInfo[]> {
    const role = 'XiSuite Backend API';

    try {
      const before = process.cpuUsage();
      const startedAt = Date.now();

      await new Promise((resolve) =>
        setTimeout(resolve, CPU_SAMPLE_INTERVAL_MS),
      );

      const afterDelta = process.cpuUsage(before);
      const elapsedMicros = (Date.now() - startedAt) * 1000;
      const cpuPercent =
        elapsedMicros > 0
          ? Math.round(
              ((afterDelta.user + afterDelta.system) / elapsedMicros) * 1000,
            ) / 10
          : null;

      const mem = process.memoryUsage();

      return [
        {
          pid: process.pid,
          role,
          nodeVersion: process.version,
          uptimeSeconds: Math.floor(process.uptime()),
          cpuPercent,
          memoryRssBytes: mem.rss,
          memoryHeapUsedBytes: mem.heapUsed,
          memoryHeapTotalBytes: mem.heapTotal,
        },
      ];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      this.logger.warn(`readProcesses failed: ${message}`);

      return [
        {
          pid: process.pid,
          role,
          nodeVersion: process.version,
          uptimeSeconds: Math.floor(process.uptime()),
          cpuPercent: null,
          memoryRssBytes: null,
          memoryHeapUsedBytes: null,
          memoryHeapTotalBytes: null,
          error: message,
        },
      ];
    }
  }

  async getMetrics(): Promise<ISystemMetrics> {
    if (isKubernetesOnPrem(this.env)) {
      // The answering pod's own container figures, plus the whole cluster from the status
      // service, all in parallel: latency stays one sample window (or the 3 s cluster budget).
      const [cpu, ram, disk, processes, cluster] = await Promise.all([
        this.readPodCpu(),
        this.readPodRam(),
        this.readDisk(),
        this.readProcesses(),
        this.readCluster(),
      ]);
      return {
        scope: 'pod',
        podName: hostname(),
        cluster,
        cpu,
        ram,
        disk,
        processes,
        uptimeSeconds: Math.floor(process.uptime()),
        sampledAt: new Date().toISOString(),
      };
    }

    // CPU, disk, and process readings each take real time (a sampling delay, or a filesystem
    // call); running them together with the synchronous RAM read is a straightforward, cheap
    // parallelization — total latency stays close to one CPU_SAMPLE_INTERVAL_MS window, not the
    // sum of all of them.
    const [cpu, disk, processes] = await Promise.all([
      this.readCpu(),
      this.readDisk(),
      this.readProcesses(),
    ]);
    const ram = this.readRam();

    return {
      cpu,
      ram,
      disk,
      processes,
      uptimeSeconds: Math.floor(process.uptime()),
      sampledAt: new Date().toISOString(),
    };
  }
}
