/**
 * @fileoverview Response shape for the on-prem "System Overview" host metrics endpoint.
 * @module src/system-metrics/interfaces/system-metrics.interface
 */

export interface ISystemMetricValue {
  /** null when this one metric failed to read (e.g. restricted container permissions) — the
   * other metrics still return normally, so the UI can show a single "unavailable" tile. */
  percent: number | null;
  error?: string;
}

export interface ISystemCpuMetric extends ISystemMetricValue {
  cores: number | null;
  /** Kubernetes only: true when `cores` is the container's CPU limit, false when the container
   * has no limit and the figure is the node's core count. Absent outside Kubernetes. */
  limited?: boolean;
}

export interface ISystemRamMetric extends ISystemMetricValue {
  usedBytes: number | null;
  totalBytes: number | null;
  /** Kubernetes only: true when `totalBytes` is the container's memory limit. */
  limited?: boolean;
}

export interface ISystemDiskMetric extends ISystemMetricValue {
  freeBytes: number | null;
  totalBytes: number | null;
  path: string;
}

/**
 * One live Node.js process belonging to THIS server — never a host-wide process scan (that
 * would leak unrelated services/other users' processes on a shared box). Today this is always
 * exactly this backend's own process, but the array shape is forward-compatible with a future
 * multi-process deployment without an API change.
 */
export interface INodeProcessInfo {
  pid: number;
  role: string;
  nodeVersion: string;
  uptimeSeconds: number;
  cpuPercent: number | null;
  memoryRssBytes: number | null;
  memoryHeapUsedBytes: number | null;
  memoryHeapTotalBytes: number | null;
  error?: string;
}

/** One pod of a component, as the status service reads it from the Kubernetes API. */
export interface IClusterPod {
  name: string;
  node: string;
  phase: string;
  ready: boolean;
  restarts: number;
  reason: string | null;
  startedAt: string | null;
  terminating: boolean;
}

export interface IClusterComponent {
  id: string;
  name: string;
  group: string | null;
  state: string;
  notes: string[];
  latencyMs: number | null;
  error: string | null;
  single: boolean | null;
  ready: number | null;
  desired: number | null;
  pods: IClusterPod[];
}

/**
 * Kubernetes/OpenShift only: every component and pod, from the in-cluster status service. Never
 * throws into the response: anything that goes wrong becomes `available: false` with a reason.
 */
export type IClusterHealth =
  | {
      available: true;
      generatedAt: string | null;
      stale: boolean;
      overall: string;
      statusPageUrl: string | null;
      podDataError: string | null;
      warnings: string[];
      components: IClusterComponent[];
      incidents: { id: number; title: string; impact: string; status: string; startedAt: string; latest: string }[];
    }
  | { available: false; reason: 'not_configured' | 'unreachable' | 'unauthorized' | 'error' };

export interface ISystemMetrics {
  /** 'pod' on Kubernetes/OpenShift (figures are the answering container's), 'host' otherwise. */
  scope?: 'host' | 'pod';
  /** Kubernetes only: the pod that answered this request. */
  podName?: string;
  /** Kubernetes only; null everywhere else (SaaS, Docker installs). */
  cluster?: IClusterHealth | null;
  cpu: ISystemCpuMetric;
  ram: ISystemRamMetric;
  disk: ISystemDiskMetric;
  processes: INodeProcessInfo[];
  /** Seconds since this backend process started — same source as GET /health. */
  uptimeSeconds: number;
  sampledAt: string;
}
