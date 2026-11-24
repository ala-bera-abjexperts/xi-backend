/** Where a submission was made. `task` and `site_studio` are derived server-side, never claimed. */
export type SubmissionSurface = 'wiki' | 'task' | 'site_studio';

export const CLIENT_SUBMISSION_SURFACES = ['wiki'] as const;

export type ClientSubmissionSurface =
  (typeof CLIENT_SUBMISSION_SURFACES)[number];

const SURFACE_SETTING: Record<SubmissionSurface, string> = {
  wiki: 'create_from_wiki',
  task: 'create_from_tasks',
  site_studio: 'create_from_site_studio',
};

const SURFACE_LABEL: Record<SubmissionSurface, string> = {
  wiki: 'wiki',
  task: 'task',
  site_studio: 'Site Studio',
};

/**
 * Outcome columns to stamp on the inserted submission when the form's ticket switch for
 * this surface is off; `{}` otherwise. Only `=== false` turns it off, so existing forms
 * keep creating tickets. Stamped at insert so the approval and paid paths honour it later.
 */
export function surfaceTicketOutcome(
  settings: Record<string, unknown> | null | undefined,
  surface: SubmissionSurface | undefined,
): { task_creation_status?: 'skipped'; task_creation_detail?: string } {
  if (!surface) return {};

  const integration = settings?.task_integration as
    | Record<string, unknown>
    | undefined;

  // A disabled integration records its own reason inside the task creator.
  if (!integration?.enabled || integration[SURFACE_SETTING[surface]] !== false)
    return {};

  return {
    task_creation_status: 'skipped',
    task_creation_detail: `Ticket creation is turned off for ${SURFACE_LABEL[surface]} submissions`,
  };
}
