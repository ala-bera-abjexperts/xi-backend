/** The selected sprint plus the 9 before it. */
const VELOCITY_WINDOW = 10;

export interface VelocitySprint {
  id: string;
  name: string;
  status: string;
  start_date: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface VelocityBar {
  id: string;
  name: string;
  status: string;
  /** null: tasks were completed, but none has an estimate. Not the same as a real 0. */
  points: number | null;
  completedTasks: number;
  unestimatedTasks: number;
}

/** A usable estimate from a raw custom field value, or null. */
export function parseStoryPoints(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Started sprints, oldest first. `sprint_number` can't order them: it has gaps and repeats, and
 * `sort_order` is the backlog order. Planning sprints have no velocity yet, so they are left out.
 */
export function orderStartedSprints<T extends VelocitySprint>(
  sprints: T[],
): T[] {
  const startedAt = (sprint: T) =>
    new Date(
      sprint.start_date ?? sprint.completed_at ?? sprint.created_at,
    ).getTime();

  return sprints
    .filter((sprint) => sprint.status !== 'planning')
    .sort((a, b) => startedAt(a) - startedAt(b));
}

/** The requested sprint when it is on this board, otherwise the latest completed, otherwise the latest. */
export function pickVelocitySprint<T extends VelocitySprint>(
  ordered: T[],
  requestedId?: string,
): T | undefined {
  return (
    ordered.find((sprint) => sprint.id === requestedId) ??
    [...ordered].reverse().find((sprint) => sprint.status === 'completed') ??
    ordered[ordered.length - 1]
  );
}

/** The sprints to chart: up to 10, ending at the selected one. */
export function velocityWindow<T extends VelocitySprint>(
  ordered: T[],
  selected: T,
): T[] {
  const end = ordered.indexOf(selected) + 1;

  return ordered.slice(Math.max(0, end - VELOCITY_WINDOW), end);
}

/** One bar per sprint, from the raw estimate of each task completed in it. */
export function buildVelocityBars(
  sprints: VelocitySprint[],
  estimatesBySprint: Map<string, unknown[]>,
): VelocityBar[] {
  return sprints.map(({ id, name, status }) => {
    const raw = estimatesBySprint.get(id) ?? [];
    const estimates = raw
      .map(parseStoryPoints)
      .filter((points): points is number => points !== null);

    return {
      id,
      name,
      status,
      points:
        raw.length > 0 && estimates.length === 0
          ? null
          : round(estimates.reduce((sum, points) => sum + points, 0)),
      completedTasks: raw.length,
      unestimatedTasks: raw.length - estimates.length,
    };
  });
}

/** The average to compare against: earlier completed sprints that have data. In-progress ones can still change. */
export function previousVelocityAverage(bars: VelocityBar[]): number | null {
  const previous = bars
    .slice(0, -1)
    .filter((bar) => bar.status === 'completed' && bar.points !== null);

  if (previous.length === 0) return null;

  return round(
    previous.reduce((sum, bar) => sum + (bar.points as number), 0) /
      previous.length,
  );
}
