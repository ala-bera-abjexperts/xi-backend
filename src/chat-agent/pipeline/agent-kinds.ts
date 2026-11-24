/**
 * @fileoverview What differs per kind of proposal (XE-T353 1.20): where it is stored, what it needs
 * and when it runs. Everything that used to choose between "a page" and "a task" reads this.
 */

import { roleRank, SPACE_ROLES, type SpaceRoleName } from '../../spaces/space-member-rules.service';

export const MEMBER_KINDS = [
  'space_member_add',
  'space_member_role',
  'space_member_permissions',
  'space_member_remove',
] as const;

export type AgentMemberKind = (typeof MEMBER_KINDS)[number];

export type AgentEntity =
  | 'task'
  | 'wiki_page'
  | 'space'
  | 'process'
  | 'plan'
  | 'plan_link'
  | AgentSuggestionKind
  | 'space_member';

const MEMBER_SET = new Set<string>(MEMBER_KINDS);

/**
 * 1.23: what Robert suggests a plan lacks. Each is one row he adds to an existing plan (dates: on
 * an item he created that has none), its own object under the id its card reserved.
 */
export const SUGGESTION_KINDS = [
  'plan_dependency',
  'plan_dates',
  'plan_risk',
  'plan_stakeholder',
  'plan_baseline',
] as const;
export type AgentSuggestionKind = (typeof SUGGESTION_KINDS)[number];
const SUGGESTION_SET = new Set<string>(SUGGESTION_KINDS);
export const isSuggestionKind = (kind: string | undefined): kind is AgentSuggestionKind =>
  !!kind && SUGGESTION_SET.has(kind);

export const isMemberKind = (kind: string): kind is AgentMemberKind =>
  MEMBER_SET.has(kind);

/** Changes who holds power. These come only from the words of the person asking, never from data. */
export const isGovernanceKind = (kind: string): boolean =>
  kind === 'space' || isMemberKind(kind);

/** The kinds added by 1.20; a plan without any keeps its order and its behaviour exactly. */
export const isNewKind = (kind: string): boolean =>
  isGovernanceKind(kind) || kind === 'process';

/** A product plan and its items (1.22). "Plan" alone in chat-agent means the model's batch of cards. */
export const isPlanKind = (kind: string | undefined): boolean =>
  kind === 'plan' || kind === 'plan_item' || kind === 'plan_link' || isSuggestionKind(kind);

/** A task or page may hang under these without being their child in the task or page tree. */
export const isContainerKind = (kind: string | undefined): boolean =>
  kind === 'space' || kind === 'process' || kind === 'plan';

export function entityOf(kind: string): AgentEntity {
  if (kind === 'wiki_page' || kind === 'space' || kind === 'process' || kind === 'plan' || kind === 'plan_link')
    return kind;
  if (isSuggestionKind(kind)) return kind;
  return isMemberKind(kind) ? 'space_member' : 'task';
}

/** Where the object an action reserved lives; null when there is no row under that id. */
export function tableOf(kind: string): string | null {
  if (isMemberKind(kind)) return null;
  if (kind === 'wiki_page') return 'wiki_pages';
  if (kind === 'space') return 'spaces';
  if (kind === 'process') return 'business_processes';
  if (kind === 'plan') return 'plans';
  // 1.22.1: a link is the plan_tasks row it made; the task is a person's.
  if (kind === 'plan_link') return 'plan_tasks';
  // 1.23: dates have no row of their own (what they wrote is on the card).
  if (kind === 'plan_dependency') return 'task_relationships';
  if (kind === 'plan_risk') return 'plan_risks';
  if (kind === 'plan_stakeholder') return 'plan_stakeholders';
  if (kind === 'plan_baseline') return 'plan_baselines';
  if (kind === 'plan_dates') return null;
  return 'tasks';
}

/** The space permission a proposal is checked against. */
export function permOf(kind: string): string {
  if (kind === 'wiki_page') return 'create_wiki_pages';
  if (kind === 'process') return 'create_processes';
  // A plan item needs edit access on its plan, which is no space key alone: AgentPlansService asks.
  if (kind === 'plan' || kind === 'plan_item' || kind === 'plan_link')
    return kind === 'plan' ? 'create_plans' : 'edit_plans';
  // A baseline needs the plan's admin level, as the human route: delete_plans in the space.
  if (kind === 'plan_baseline') return 'delete_plans';
  if (isSuggestionKind(kind)) return 'edit_plans';
  if (isMemberKind(kind)) return 'manage_members';
  return 'create_tasks';
}

/**
 * Order inside one Confirm. Parents first; members who lose access last, so a person removing or
 * demoting themselves does not break the rest of their own request.
 */
export function rankOf(kind: string): number {
  if (kind === 'space') return 0;
  if (kind === 'space_member_add') return 1;
  if (kind === 'process' || kind === 'plan') return 2;
  if (kind === 'wiki_page') return 4;
  if (isMemberKind(kind)) return 5;
  // 1.23: dependencies before the dates that follow from them; a baseline last, so it holds them.
  if (kind === 'plan_dependency') return 6;
  if (kind === 'plan_dates') return 7;
  if (kind === 'plan_baseline') return 8;
  return 3;
}

export { roleRank, SPACE_ROLES };
export type AgentSpaceRole = SpaceRoleName;

export const PROCESS_REQUEST_TYPES = [
  'Risiko',
  'Geschäftsprozessbewertung',
  'Prozessbewertung',
  'Servicebewertung',
  'Assetbewertung',
  'Schwachstelle',
  'Maßnahme',
  'Assetgroup',
] as const;

export const PROCESS_SCORE_KEYS = [
  'vuln_c_p',
  'vuln_c_i',
  'vuln_i_p',
  'vuln_i_i',
  'vuln_a_p',
  'vuln_a_i',
  'action_c_p',
  'action_c_i',
  'action_i_p',
  'action_i_i',
  'action_a_p',
  'action_a_i',
] as const;

/** The first letters of a name as a space key: stable, so a Confirm sees what the card showed. */
export function spaceKeyBase(name: string): string {
  const letters = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 6);
  if (letters.length >= 2) return letters;
  // Only symbols or emoji: a key from a hash of the name (never random, see above).
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `S${hash.toString(36).toUpperCase().slice(0, 4).padEnd(2, '0')}`;
}

/** The base, or the base with the lowest number that makes it free. */
export function freeSpaceKey(name: string, taken: Set<string>): string {
  const base = spaceKeyBase(name);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/** One level of the organization's process hierarchy (hierarchy-config), as far as Robert needs it. */
export interface ProcessLevel {
  id: string;
  requestType: string;
  parentLevelId: string | null;
  allowedChildren: string[];
}

export interface ProcessPlacement {
  levelId: string | null;
  /** The type taken from the parent, when none was named. */
  requestType?: string;
  problem?: 'level_not_allowed' | 'level_needs_parent';
  /** The types that fit here. */
  allowed: string[];
}

const typesOf = (levels: ProcessLevel[]) => [...new Set(levels.map((l) => l.requestType))];

/**
 * Where a process goes in the hierarchy, by the same rule as the process form. A type may have two
 * levels (Assetgroup under Prozess or under Service): the one allowed under this parent counts.
 */
export function placeProcess(
  levels: ProcessLevel[],
  parent: { levelId: string | null; requestType: string } | null,
  requestType: string | null,
): ProcessPlacement {
  if (!levels.length) return { levelId: null, allowed: [] };
  const fits = parent
    ? (() => {
        const above =
          levels.find((l) => l.id === parent.levelId) ?? levels.find((l) => l.requestType === parent.requestType);
        return (above?.allowedChildren ?? []).flatMap((id) => levels.filter((l) => l.id === id));
      })()
    : levels.filter((l) => l.parentLevelId === null);
  const allowed = typesOf(fits);
  if (!requestType) {
    // A process at the top could be many things; under a parent the ladder says what comes next.
    const next = parent ? fits[0] : undefined;
    return next ? { levelId: next.id, requestType: next.requestType, allowed } : { levelId: null, allowed };
  }
  const level = fits.find((l) => l.requestType === requestType);
  if (level) return { levelId: level.id, allowed };
  return { levelId: null, problem: parent ? 'level_not_allowed' : 'level_needs_parent', allowed };
}

/** The ladder for the prompt: each type once, with the types allowed directly under it. */
export function promptLevels(levels: ProcessLevel[]): { type: string; root: boolean; children: string[] }[] {
  return typesOf(levels).map((type) => {
    const own = levels.filter((l) => l.requestType === type);
    return {
      type,
      root: own.some((l) => l.parentLevelId === null),
      children: typesOf(own.flatMap((l) => l.allowedChildren.flatMap((id) => levels.filter((c) => c.id === id)))),
    };
  });
}
