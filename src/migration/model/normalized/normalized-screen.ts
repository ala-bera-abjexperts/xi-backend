/**
 * @fileoverview Source-agnostic screen (field layout) and its tabs.
 *
 * Jira Server DOES expose screens over REST, contrary to what this file used to claim:
 * `/rest/api/2/screens`, `/screens/{id}/tabs` and `/screens/{id}/tabs/{tabId}/fields` all return
 * real data on 8.22 (verified live). Tabs are the closest Jira analogue to an XISUITE field group,
 * so the `field_groups` stage reproduces them instead of inventing one catch-all group.
 */

export interface NormalizedScreenTab {
  /** Stable tab id on the source. */
  sourceId: string;
  name: string;
  /** Field ids on this tab, system and custom alike (`summary`, `customfield_10112`, ...). */
  fieldSourceIds: string[];
}

export interface NormalizedScreen {
  sourceId: string;
  name: string;
  tabs: NormalizedScreenTab[];
  /** Explicitly audited metadata fallbacks used when Cloud hides screen configuration. */
  migrationWarnings?: string[];
}
