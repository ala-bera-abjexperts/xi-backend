/**
 * @fileoverview Git integration ticket 9: the development notification types, their preference defaults and
 * their text. One renderer serves both the stored row (English, re-translated by the web app from `type` +
 * `metadata`) and the email, in the recipient's language through the mail catalogs (`notif.git.*`).
 * @module src/notifications/git-notifications
 */

/** Notification type = preference key. Email is off by default except for failed builds; "linked" is opt-in. */
export const GIT_NOTIFICATION_DEFAULTS = {
  git_pr_merged: { inApp: true, email: false },
  git_build_failed: { inApp: true, email: true },
  git_build_fixed: { inApp: true, email: false },
  git_pr_linked: { inApp: false, email: false },
} as const;

export type GitNotificationType = keyof typeof GIT_NOTIFICATION_DEFAULTS;

export function isGitNotificationType(
  type: unknown,
): type is GitNotificationType {
  return (
    typeof type === 'string' &&
    Object.prototype.hasOwnProperty.call(GIT_NOTIFICATION_DEFAULTS, type)
  );
}

/** What git-activity.service stores in `notifications.metadata`. */
export interface IGitNotificationMetadata {
  task_key?: string | null;
  space_key?: string | null;
  provider?: 'github' | 'gitlab' | 'azure_devops';
  /** Events combined into this notification (bursts). */
  count?: number;
  actor_name?: string | null;
  actor_login?: string | null;
  /** pr_linked: linked by the key rather than by a person. */
  auto?: boolean;
  subject?: {
    number?: number;
    title?: string;
    url?: string | null;
    branch?: string | null;
    repository?: string | null;
  };
}

export type GitTranslate = (
  key: string,
  vars?: Record<string, unknown>,
) => string;

/** Only http(s) links leave the system (email, bell, History). */
export function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  try {
    const url = new URL(value);

    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** Title, body and the link to the provider ("View build") of one git notification, in `t`'s language. */
export function gitNotificationText(
  t: GitTranslate,
  type: GitNotificationType,
  raw: Record<string, unknown> | null | undefined,
): { title: string; body: string; linkLabel: string; linkUrl: string | null } {
  const meta = (raw ?? {}) as IGitNotificationMetadata;
  const subject = meta.subject ?? {};
  // Only GitLab says "merge request"; Azure DevOps uses GitHub's "pull request" texts.
  const provider = meta.provider === 'gitlab' ? 'gitlab' : 'github';
  const count = Math.max(1, Number(meta.count) || 1);
  const vars = {
    task: meta.task_key ?? '',
    Request: t(`notif.git.requestTitle.${provider}`),
    request: t(`notif.git.request.${provider}`),
    requests: t(`notif.git.requests.${provider}`),
    number: subject.number ?? '',
    title: subject.title ?? '',
    build: subject.title ?? '',
    branch: subject.branch ?? '',
    repository: subject.repository ?? '',
    actor: meta.actor_name || meta.actor_login || t('notif.git.someone'),
    count,
  };
  const many = count > 1;
  const body = many
    ? 'bodyMany'
    : type === 'git_pr_linked' && meta.auto
      ? 'bodyAuto'
      : 'body';

  return {
    title: t(`notif.git.${type}.${many ? 'titleMany' : 'title'}`, vars),
    body: t(`notif.git.${type}.${body}`, vars),
    linkLabel: t(
      type === 'git_build_failed' || type === 'git_build_fixed'
        ? 'notif.git.link.build'
        : `notif.git.link.${provider}`,
    ),
    linkUrl: httpUrl(subject.url),
  };
}
