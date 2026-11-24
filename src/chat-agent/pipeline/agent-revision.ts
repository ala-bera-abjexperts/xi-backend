/**
 * @fileoverview Follow-up changes to an open wiki page proposal (1.17): what a request asks for,
 * the open page translated into the handles of the new run, and which card edits carry over.
 * Pure: the worker loads the proposal, this module only reads and rewrites it.
 *
 * Handles (m7, P2, T1, W1, i2) belong to one run's context. The proposal's own handle map
 * (AgentWikiHandles) says what each stood for, so the blocks can be shown to the model again in
 * the handles of the run that revises them; what the new run cannot reference is left out.
 */
import type { WikiBlock } from './agent-wiki-render';

/** A request to change something, in English or German. */
const CHANGE =
  /(?<![\p{L}\p{N}])(add|append|insert|remove|delete|drop|change|replace|rename|reword|rewrite|update|move|swap|fix|correct|translate|shorten|shorter|longer|expand|more detail(s|ed)?|less detail|instead|make (it|the|this)|turn (it|the|this)|put (it|the)|f[üu]ge?|hinzu|entfern\w*|l[öo]sch\w*|[äa]nder\w*|ersetz\w*|umbenenn\w*|verschieb\w*|[üu]bersetz\w*|k[üu]rz\w*|l[äa]nger|ausf[üu]hrlicher|statt(dessen)?|mach (es|sie|die|den|das|daraus))(?![\p{L}\p{N}])/iu;

/** A request for another page, which never revises the open one. */
const NEW_PAGE =
  /(?<![\p{L}\p{N}])(another|a new|new|second|separate|extra|additional|weitere|neue[nrs]?|zweite|separate|zus[äa]tzliche)\s+(wiki\s+)?(page|seite|wiki ?seite)(?![\p{L}\p{N}])/iu;

const UNDO =
  /(?<![\p{L}\p{N}])(undo|go back|revert|previous version|the version before|r[üu]ckg[äa]ngig|vorherige version|zur[üu]ck zur (letzten|vorherigen))(?![\p{L}\p{N}])/iu;

export const isChangeRequest = (request: string): boolean =>
  CHANGE.test(request);

/** A request to put the page into another language ("in German", "übersetze", "auf Englisch"). */
const TRANSLATE =
  /(?<![\p{L}\p{N}])(translate|translation|in (german|english)|[üu]bersetz\w*|auf (deutsch|englisch))(?![\p{L}\p{N}])/iu;
export const asksTranslation = (request: string): boolean =>
  TRANSLATE.test(request);
export const asksNewPage = (request: string): boolean => NEW_PAGE.test(request);
export const isUndo = (request: string): boolean => UNDO.test(request);

/** What one run's handles stand for (the parts of AgentWikiHandles a block can name). */
export interface RunHandles {
  messages: Record<string, string>;
  people: Record<string, { userId: string; name: string }>;
  tasks: Record<string, { key: string }>;
  pages: Record<string, { id: string }>;
  items?: Record<string, number>;
}

const invert = <T>(map: Record<string, T>, id: (v: T) => string) =>
  new Map(Object.entries(map).map(([handle, v]) => [id(v), handle]));

/**
 * The blocks of a proposal in the handles of another run. A citation of a message the new run
 * does not have goes (its words stay), a person it does not know is their name, a task is its
 * key (resolved again as the invoker), a page it cannot reference and an unconfirmed task item
 * of the old run are left out.
 */
export function rehandle(
  blocks: WikiBlock[],
  old: RunHandles,
  next: RunHandles,
  createdItems: Map<number, string> = new Map(),
): WikiBlock[] {
  const message = invert(next.messages, (id) => id);
  const person = invert(next.people, (p) => p.userId);
  const task = invert(next.tasks, (t) => t.key.toUpperCase());
  const page = invert(next.pages, (p) => p.id);
  const itemOf = new Map(
    Object.entries(old.items ?? {}).map(([h, n]) => [h, n]),
  );

  const text = (value: string): string =>
    value
      .replace(/\[(m\d+)\]/g, (_, h: string) => {
        const id = old.messages[h];
        const now = id ? message.get(id) : undefined;
        return now ? `[${now}]` : '';
      })
      .replace(/@(P\d+)\b/g, (all, h: string) => {
        const p = old.people[h];
        if (!p) return all.slice(1);
        const now = person.get(p.userId);
        return now ? `@${now}` : p.name;
      });

  const ref = (r: string): string | null => {
    const h = r.trim();
    if (/^m\d+$/.test(h)) {
      const id = old.messages[h];
      return (id && message.get(id)) ?? null;
    }
    if (/^P\d+$/.test(h)) {
      const p = old.people[h];
      return (p && person.get(p.userId)) ?? null;
    }
    if (/^T\d+$/.test(h)) {
      const key = old.tasks[h]?.key;
      return key ? (task.get(key.toUpperCase()) ?? key) : null;
    }
    if (/^W\d+$/.test(h)) {
      const id = old.pages[h]?.id;
      return (id && page.get(id)) ?? null;
    }
    if (/^i\d+$/.test(h)) {
      const n = itemOf.get(h);
      return n !== undefined ? (createdItems.get(n) ?? null) : null;
    }
    return h; // A task key as written ("AMBER-T25"): stays.
  };

  return blocks
    .map((b) => ({
      ...b,
      text: b.text === null ? null : text(b.text),
      title: b.title === null ? null : text(b.title),
      items: b.items.map(text),
      rows: b.rows.map((r) => r.map(text)),
      refs: b.refs.map(ref).filter((r): r is string => !!r),
    }))
    .filter((b) => !(b.type === 'include_page' && !b.refs.length));
}

/** Card fields a follow-up may set again; any other card edit is the person's and stays. */
const NAMES_FIELD: Record<string, RegExp> = {
  title:
    /(?<![\p{L}\p{N}])(rename|re-?title|title|call it|name it|titel|umbenenn\w*|nenn (es|sie))(?![\p{L}\p{N}])/iu,
  parentPage:
    /(?<![\p{L}\p{N}])(under|below|beneath|parent( page)?|unter(halb)?|elternseite)(?![\p{L}\p{N}])/iu,
  space: /(?<![\p{L}\p{N}])(space|bereich|move (it )?to)(?![\p{L}\p{N}])/iu,
  publish:
    /(?<![\p{L}\p{N}])(publish|draft|ver[öo]ffentlich\w*|entwurf)(?![\p{L}\p{N}])/iu,
  labels: /(?<![\p{L}\p{N}])(labels?|tags?)(?![\p{L}\p{N}])/iu,
};

/** The card edits that stay, without the fields this request asks to set itself. */
export function carriedOverrides(
  overrides: Record<string, unknown> | null | undefined,
  request: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(overrides ?? {}).filter(
      ([key]) => !NAMES_FIELD[key]?.test(request),
    ),
  );
}

/** Revisions in a row one card may get; then the person finishes the page in the wiki. */
export const MAX_REVISIONS = 5;

export type RevisionLine =
  | 'stale'
  | 'created'
  | 'closed'
  | 'which'
  | 'limit'
  | 'nothing_to_undo';

/** Robert's fixed lines around a revision, in the request's language (du in German). */
export function revisionLine(
  code: RevisionLine,
  lang: 'de' | 'en',
  titles: string[] = [],
): string {
  const quoted = titles.map((t) => (lang === 'de' ? `„${t}“` : `"${t}"`));
  const either = quoted.join(lang === 'de' ? ' oder ' : ' or ');
  const de: Record<RevisionLine, string> = {
    stale:
      'Die Seite wurde geändert oder bestätigt, während ich daran gearbeitet habe, deshalb habe ich sie so gelassen. Bitte frag noch einmal beim aktuellen Vorschlag.',
    created: `Die Seite ${quoted[0] ?? ''} wurde schon erstellt; ändere sie bitte im Wiki.`,
    closed:
      'Dieser Vorschlag ist geschlossen. Frag mich nach einer neuen Seite, wenn du sie noch brauchst.',
    which: `Welche Seite soll ich ändern: ${either}?`,
    limit: `Diese Seite wurde schon ${MAX_REVISIONS}-mal geändert. Bestätige sie und mach im Wiki weiter.`,
    nothing_to_undo: 'Es gibt keine frühere Version dieser Seite.',
  };
  const en: Record<RevisionLine, string> = {
    stale:
      'The page changed or was confirmed while I was working on it, so I left it as it is. Please ask again on the current card.',
    created: `The page ${quoted[0] ?? ''} was already created; please change it in the wiki.`,
    closed:
      'That proposal is closed. Ask me for a new page if you still need it.',
    which: `Which page should I change: ${either}?`,
    limit: `This page was changed ${MAX_REVISIONS} times already. Confirm it and finish it in the wiki.`,
    nothing_to_undo: 'There is no earlier version of this page to go back to.',
  };
  return (lang === 'de' ? de : en)[code].replace(/\s+/g, ' ');
}
