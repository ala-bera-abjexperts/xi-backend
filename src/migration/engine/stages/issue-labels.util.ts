/**
 * @fileoverview Sanitizes Jira issue labels before they reach `tasks.labels`.
 *
 * Pure and dependency-free ON PURPOSE — `issues.stage.ts` imports NestJS services and
 * (transitively) `sanitizeRichText` → jsdom, which will not transform under this repo's Jest config.
 *
 * Why sanitize at all, when the labels come straight from Jira's own API?
 *
 * `CreateTaskDto.labels` is validated with `@IsArray()` and NOTHING ELSE (create-task.dto.ts:146-149)
 * — no `@IsString({ each: true })`, no length cap, no size cap. `TasksService` then writes the array
 * verbatim into `tasks.labels`, a `jsonb DEFAULT '[]'` column (tasks.service.ts:1222). So the DTO
 * will reject nothing and the database will accept anything: a null in the array, a 40 KB string, or
 * ten thousand entries all land in the task UI unchallenged.
 *
 * Jira labels are free-form and user-created, so all three are reachable on a real instance. The
 * failure would not be an exception — it would be a task detail page that renders junk, which is
 * this project's signature failure mode: no error, just wrong data.
 *
 * Case sensitivity is deliberate. Jira treats `Billing` and `billing` as DISTINCT labels, so
 * case-insensitive dedupe would silently merge two real labels into one and lose information.
 *
 * @module src/migration/engine/stages/issue-labels.util
 */

/**
 * Longest single label kept. Jira Server itself caps labels at 255 characters, so this only ever
 * trims values that arrived from an import or an older instance.
 */
const MAX_LABEL_LENGTH = 255;

/**
 * Most labels kept per issue. Jira imposes no limit; this bounds what one malformed issue can put
 * into a jsonb column and onto a task card.
 */
const MAX_LABELS = 100;

/**
 * Normalize whatever Jira returned into an array of clean, unique label strings.
 *
 * Order is preserved: Jira returns labels in its own order and the first occurrence wins, so the
 * result is stable across re-runs rather than dependent on Set iteration of a mutated array.
 *
 * @param raw  `NormalizedIssue.labels`, typed `string[]` but sourced from untyped JSON.
 * @returns    Sanitized labels, or `[]` when there is nothing usable. Never `null`/`undefined`, so
 *             callers can spread the result without a further guard.
 */
export function sanitizeLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of raw) {
    if (out.length >= MAX_LABELS) break;

    // Non-strings are dropped rather than coerced: `String({})` yields '[object Object]', which is
    // exactly the kind of junk that reached the task UI when custom field values were coerced.
    if (typeof entry !== 'string') continue;

    // Trim BEFORE slicing so leading whitespace does not eat the character budget, then trim the
    // end again: the slice can land mid-gap and leave a trailing space, which would make two labels
    // that differ only past the cut dedupe inconsistently.
    const trimmed = entry.trim().slice(0, MAX_LABEL_LENGTH).trimEnd();

    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;

    seen.add(trimmed);
    out.push(trimmed);
  }

  return out;
}
