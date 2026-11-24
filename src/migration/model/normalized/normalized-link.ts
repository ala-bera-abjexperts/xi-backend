/**
 * @fileoverview Source-agnostic issue link. Maps in Phase 7 to `task_relationships` —
 * both ends resolved through the crosswalk; second pass so both issues exist first.
 */

export interface NormalizedLink {
  sourceId: string;
  /** Link type name (e.g. "Blocks", "Relates"). */
  type: string;
  direction: 'inward' | 'outward';
  otherIssueSourceId: string;
  /** Directional label (e.g. "blocks" vs "is blocked by"). */
  relationName: string;
}

/**
 * A link TYPE as the source defines it, independent of any particular link.
 *
 * Needed because `NormalizedLink` only carries the label for the direction it was seen from, so a
 * link type reconstructed from a link alone would have half its descriptions invented. Creating a
 * relation type named "Causes" whose inward description reads "is causes by" is the kind of visible
 * sloppiness that undermines a migration, so the type is read from the source instead.
 */
export interface NormalizedLinkType {
  sourceId: string;
  /** Type name, e.g. "Blocks". */
  name: string;
  /** Label from the source side, e.g. "blocks". */
  outward: string;
  /** Label from the target side, e.g. "is blocked by". */
  inward: string;
}

/**
 * A REMOTE link (Jira's Link → Web Link): a URL on any system with a title, attached to one
 * issue. This is how a PDF or Confluence page is typically "attached" as a link in Jira, and it
 * is NOT part of `fields.issuelinks` — it has its own REST resource. Maps to a task comment so
 * the reference survives migration instead of vanishing.
 */
export interface NormalizedRemoteLink {
  sourceId: string;
  url: string;
  title: string;
  summary?: string;
}
