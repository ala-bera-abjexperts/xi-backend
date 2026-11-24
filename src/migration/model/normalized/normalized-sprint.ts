/**
 * @fileoverview Source-agnostic sprint. Maps in Phase 7 to `SprintsService.create` —
 * never set the trigger-owned `sprints.sprint_number`. On Jira Server some sprints only
 * appear as serialized greenhopper strings on issues; the adapter regex-parses those.
 */

export interface NormalizedSprint {
  /** Stable sprint id (numeric as string). */
  sourceId: string;
  name: string;
  goal?: string;
  state: 'future' | 'active' | 'closed';
  /** ISO-8601 when reported. */
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  /** Board this sprint belongs to (originBoardId when reported). */
  boardSourceId?: string;
}
