/** Source-agnostic identity carried by watcher relationship stages. */
export interface NormalizedWatcher {
  /** Deployment-native stable identity: accountId on Cloud, user key/name on Server. */
  sourceId: string;
  /** Legacy login alias when the source exposes one. Never used instead of a stronger source id. */
  username?: string;
  /** Match hint only. It is normalized before leaving the adapter. */
  email?: string;
  displayName: string;
  /** null when the source does not expose account activity; strict consumers must not assume it. */
  active: boolean | null;
}

/** Jira's unpaginated per-issue watcher response after normalization. */
export interface NormalizedWatcherList {
  watchers: NormalizedWatcher[];
  total: number;
}
