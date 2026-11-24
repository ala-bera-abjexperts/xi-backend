/**
 * @fileoverview Robert's wiki page body: the typed blocks the model returns, turned into the wiki2
 * TipTap document. Pure: every id comes in through `refs`, which the resolver filled with the
 * invoker's permissions, so the model never writes a node, an attribute, an id or a URL.
 *
 * Only nodes both the server whitelist (tiptap-sanitizer.ts) and the editor register are emitted:
 * one unknown node rejects the save or blanks the editor. Live macros that render per reader are
 * fine; snapshot attributes (entityMention titles, wikiLink titles, include titles) are never set,
 * because every reader of the page would see them whatever their access.
 */
import { cleanUntrusted } from './agent-prompt';

export const WIKI_BLOCK_TYPES = [
  'heading',
  'paragraph',
  'bullets',
  'numbered',
  'checklist',
  'quote',
  'code',
  'divider',
  'table',
  'callout',
  'toggle',
  'columns',
  'status',
  'decisions',
  'toc',
  'properties',
  'excerpt',
  'task_cards',
  'child_pages',
  'include_page',
  'pages_by_label',
  'chart',
  'task_table',
  'decision_report',
  'properties_report',
  'recent_updates',
  'contributors',
  'labels_list',
  'space_attachments',
] as const;

export const CHART_TYPES = ['bar', 'pie', 'line', 'area'] as const;

export type WikiBlockType = (typeof WIKI_BLOCK_TYPES)[number];

export const CALLOUT_VARIANTS = [
  'info',
  'note',
  'tip',
  'warning',
  'success',
  'danger',
] as const;

export const STATUS_COLORS = [
  'grey',
  'green',
  'blue',
  'red',
  'yellow',
  'purple',
] as const;

export const MAX_WIKI_BLOCKS = 150;
export const MAX_TASK_CARDS = 20;
/** Source links listed under Sources; inline citations beyond them still link. */
const MAX_SOURCES = 10;
const MAX_TABLE_COLUMNS = 12;
const MAX_TABLE_ROWS = 50;
const MAX_CHART_POINTS = 12;
const MAX_CHART_SERIES = 5;
/** The columns of Robert's live task table (TICKET_COLUMN_IDS in the editor). */
/** Stands for a space of this request in a live table, until Confirm has created it. */
export const SPACE_PLACEHOLDER = '00000000-0000-4000-8000-000000000001';

const TASK_TABLE_COLUMNS = ['key', 'summary', 'status', 'assignee', 'dueDate'];
const MAX_ITEMS = 100;
const MAX_BLOCK_CHARS = 5_000;
/** Plain text of the whole page; the search vector stops at 400k and a chat draft never needs it. */
const MAX_PAGE_CHARS = 100_000;
/** What the wiki's link whitelist always sets, so the saved document equals the rendered one. */
const LINK_REL = 'noopener noreferrer nofollow';

export interface WikiBlock {
  type: WikiBlockType;
  level: number | null;
  text: string | null;
  title: string | null;
  items: string[];
  rows: string[][];
  variant: string | null;
  language: string | null;
  refs: string[];
  labels: string[];
}

/** A task card target: an existing task, or a task item of this request created first. */
export type WikiTaskRef = { key: string; spaceId: string | null } | { item: number };

export interface WikiRenderRefs {
  language: 'de' | 'en' | 'other';
  /** This page's reserved id, for the child-page tree. */
  pageId: string;
  spaceKey: string | null;
  /** "P2" → an active member of the organization. */
  person(handle: string): { userId: string; name: string } | null;
  /** "m7" → the in-app link to that message, or null when it is not a source of this run. */
  message(handle: string): string | null;
  /** "T1", "AMBER-T25" or "i2" → a task the invoker can view, or an item of this request. */
  task(ref: string): WikiTaskRef | null;
  /** "W1" → a page the invoker can view. */
  page(ref: string): { id: string } | null;
  /** Tasks the server found for a task_cards block that names labels (block index → tasks). */
  labelled(blockIndex: number): WikiTaskRef[] | null;
  /** The messages the model said the page is based on ("m7"), for Sources when it cites none inline. */
  sources?: string[];
  /** Task items of this request; a page created with them shows them as cards. */
  runItems?: number[];
  /** "Ala Bera, 29 Oct 09:15" for a source message, the text of its link. */
  messageLabel?(handle: string): string | null;
  /** The model says it wrote the page from general knowledge. */
  generalKnowledge?: boolean;
  /** The page's space, for the live task table. */
  spaceId?: string | null;
  /** A status name or key of the page's space → its id. */
  status?(name: string): string | null;
  /** Whether a wiki label exists in the page's space. */
  label?(name: string): boolean;
  /** Every number stated in the conversation and the T/W material (numberCandidates). A chart shows only these. */
  numbers?: ReadonlySet<string>;
}

export interface WikiRenderResult {
  doc: { type: 'doc'; content: TipTapNode[] };
  /** Refs the model named that did not resolve (shown to the invoker, never rendered). */
  unknown: string[];
  trimmed: boolean;
  /** No content worth a page. */
  empty: boolean;
  /** Same-request items the document shows, so the executor fills them in after they exist. */
  items: number[];
  /** Macros the server could not build as asked (chart_unverified, unknown_label, unknown_status). */
  notes: string[];
}

export interface TipTapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/**
 * An HTML tag by its real name. Only these are taken out of plain text, so "x < 5 … y > 2" and
 * "a <-> b" stay as written (audit 2026-11-10).
 */
export const HTML_TAG =
  /<\/?(?:a|abbr|article|aside|b|big|blockquote|body|br|button|caption|center|code|col|dd|del|details|div|dl|dt|em|embed|figcaption|figure|font|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|ins|kbd|label|li|link|main|mark|meta|nav|object|ol|option|p|pre|q|s|script|section|select|small|source|span|strike|strong|style|sub|summary|sup|svg|table|tbody|td|textarea|tfoot|th|thead|title|tr|u|ul|video)(?=[\s/>])[^<>]*>/gi;

/** Plain text: no tags, no markdown images, links reduced to their words, no invisible characters, capped. */
export function plainText(text: string | null | undefined, max = MAX_BLOCK_CHARS): string {
  return cleanUntrusted(text ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(HTML_TAG, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);
}

const TOKEN =
  /\*\*([^*\n]+)\*\*|(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])|`([^`\n]+)`|\[([mF]\d+)\]|@(P\d+)\b|\[d:(\d{4}-\d{2}-\d{2})\]/gu;

const DATE_TOKEN = /\[d:(\d{4}-\d{2}-\d{2})\]/g;

/** "2026-11-28" → midday UTC of that day in epoch ms (the date node's timestamp), or null when no such day. */
export function dateStamp(iso: string): number | null {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d, 12);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? t : null;
}

const MONTHS: Record<string, number> = Object.fromEntries(
  [
    ['jan', 'january', 'januar', 'jän', 'jänner'],
    ['feb', 'february', 'februar'],
    ['mar', 'march', 'mär', 'märz', 'maerz'],
    ['apr', 'april'],
    ['may', 'mai'],
    ['jun', 'june', 'juni'],
    ['jul', 'july', 'juli'],
    ['aug', 'august'],
    ['sep', 'sept', 'september'],
    ['oct', 'october', 'okt', 'oktober'],
    ['nov', 'november'],
    ['dec', 'december', 'dez', 'dezember'],
  ].flatMap((names, i) => names.map((n) => [n, i + 1])),
);
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
/** Full dates with a year only (2026-12-15, 15.12.2026, 15 December 2026, December 15, 2026): nothing is guessed. */
const WRITTEN_DATE = new RegExp(
  `(?<![\\d:\\[-])(?:(\\d{4})-(\\d{2})-(\\d{2})|(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})|(\\d{1,2})\\.?\\s+(${MONTH})\\.?\\s+(\\d{4})|(?<!\\p{L})(${MONTH})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4}))(?![\\d\\]])`,
  'giu',
);

/** Dates written out in full become date tokens, so they show as dates the reader can open. */
function markDates(text: string): string {
  const pad = (n: string | number) => String(n).padStart(2, '0');
  return text.replace(WRITTEN_DATE, (all, y1, m1, d1, d2, m2, y2, d3, mn3, y3, mn4, d4, y4) => {
    const [y, m, d] = y1
      ? [y1, m1, d1]
      : y2
        ? [y2, m2, d2]
        : y3
          ? [y3, MONTHS[String(mn3).toLowerCase()], d3]
          : [y4, MONTHS[String(mn4).toLowerCase()], d4];
    const iso = `${y}-${pad(m)}-${pad(d)}`;
    return dateStamp(iso) === null ? all : `[d:${iso}]`;
  });
}

/** Date tokens where only text can go (titles, properties): "28 Nov 2026" / "28.11.2026". */
function datesAsText(text: string, language: WikiRenderRefs['language']): string {
  return tokensAsText(markDates(text), language);
}

/** Date tokens already marked, written as text: inside bold, italic or code a chip cannot sit. */
function tokensAsText(text: string, language: WikiRenderRefs['language']): string {
  return text.replace(DATE_TOKEN, (_, iso: string) => {
    const t = dateStamp(iso);
    if (t === null) return iso;
    return new Date(t).toLocaleDateString(language === 'de' ? 'de-DE' : 'en-GB', {
      day: 'numeric',
      month: language === 'de' ? '2-digit' : 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  });
}

/**
 * Inline text with the only markup Robert may use: **bold**, _italic_, `code`, a source citation
 * [m7] (a link to that message) and a person @P2 (a mention). Anything else stays literal text.
 */
function inline(
  raw: string | null | undefined,
  refs: WikiRenderRefs,
  cite: Map<string, number>,
): TipTapNode[] {
  const text = markDates(plainText(raw));
  const out: TipTapNode[] = [];
  const push = (value: string, marks?: TipTapNode['marks']) => {
    if (value) out.push(marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
  };
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    push(text.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    if (m[1]) push(tokensAsText(m[1], refs.language), [{ type: 'bold' }]);
    else if (m[2]) push(tokensAsText(m[2], refs.language), [{ type: 'italic' }]);
    else if (m[3]) push(tokensAsText(m[3], refs.language), [{ type: 'code' }]);
    else if (m[4]) {
      const href = refs.message(m[4]);
      if (!href) continue;
      if (!cite.has(m[4])) cite.set(m[4], cite.size + 1);
      push(`[${cite.get(m[4])}]`, [{ type: 'link', attrs: { href, target: '_self', rel: LINK_REL } }]);
    } else if (m[5]) {
      const who = refs.person(m[5]);
      if (who)
        out.push({ type: 'userMention', attrs: { userId: who.userId, userName: who.name } });
    } else if (m[6]) {
      const t = dateStamp(m[6]);
      if (t !== null) out.push({ type: 'date', attrs: { timestamp: String(t) } });
      else push(m[6]);
    }
  }
  push(text.slice(last));
  return out;
}

const NUMBER = /\d(?:[\d.,'’]*\d)?(?:\s*(k|tsd\.?|mio\.?|million|m)\b)?/gi;
const canonical = (n: number) => String(Number(n.toFixed(6)));

/**
 * What a written number can mean: "1.500" is 1500 in German and 1.5 in English, "12k" is 12000.
 * Ordered by the reading of `language` first, so a chart writes the value its reader means.
 */
export function numberCandidates(written: string, language: WikiRenderRefs['language'] = 'en'): string[] {
  const m = /^(\d(?:[\d.,'’]*\d)?)\s*(k|tsd\.?|mio\.?|million|m)?$/i.exec(written.trim());
  if (!m) return [];
  const digits = m[1].replace(/['’]/g, '');
  const scale = !m[2] ? 1 : /^(k|tsd)/i.test(m[2]) ? 1_000 : 1_000_000;
  const read = (decimal: '.' | ','): number | null => {
    const thousands = decimal === '.' ? ',' : '.';
    const [whole, ...fraction] = digits.split(decimal);
    if (fraction.length > 1) return null;
    const groups = whole.split(thousands);
    if (groups.length > 1 && !groups.slice(1).every((g) => g.length === 3)) return null;
    const value = Number(`${groups.join('')}${fraction.length ? `.${fraction[0]}` : ''}`);
    return Number.isFinite(value) ? value * scale : null;
  };
  const order: ('.' | ',')[] = language === 'de' ? [',', '.'] : ['.', ','];
  return [...new Set(order.map(read).filter((n): n is number => n !== null).map(canonical))];
}

/** Every value a text's numbers can stand for (the facts a chart may use). */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(NUMBER)].flatMap((m) => {
    // A sheet's row: "120000,98000" is two values, not one number with a long fraction.
    const cells = m[0].split(/[,;]/);
    const columns = cells.length > 1 && !cells.slice(1).every((c) => /^\d{3}\b/.test(c)) && (cells.length > 2 || cells.every((c) => c.length > 3));
    return columns ? cells.flatMap((c) => numberCandidates(c, 'en')) : numberCandidates(m[0], 'en');
  });
}

/** Who a property is about: there a bare "P1" is a person, elsewhere it can be a priority. */
const PERSON_PROPERTY = /owner|assign|lead|author|attendee|contributor|responsible|verantwort|teilnehmer|autor|leitung/i;

/** A property value as text for people: no citation handles, and names instead of person handles. */
function propertyText(cell: string, key: string, refs: WikiRenderRefs): string {
  const named = (handle: string, whole: string) => refs.person(handle)?.name ?? whole;
  const text = cell.replace(/\s*\[[mF]\d+\]/g, '').replace(/@(P\d+)\b/g, (whole, h: string) => named(h, whole));
  return PERSON_PROPERTY.test(key) ? text.replace(/(?<![\w-])P\d+(?![\w-])/g, (h) => named(h, h)) : text;
}

/** A chart cell as a plain number its source states, or null: currency, % and spaces aside. */
function chartValue(cell: string, refs: WikiRenderRefs): string | null {
  const bare = plainText(cell, 50)
    .replace(/[€$£%]|\b(eur|usd|chf|gbp)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return numberCandidates(bare, refs.language).find((n) => refs.numbers?.has(n)) ?? null;
}

const para = (content: TipTapNode[]): TipTapNode =>
  content.length ? { type: 'paragraph', content } : { type: 'paragraph' };

const textPara = (value: string): TipTapNode => para(value ? [{ type: 'text', text: value }] : []);

const DECISIONS = /decision|decided|agreed|entscheid|beschl|vereinbar/i;
const ACTIONS = /action items?|next steps|to-?dos?|aufgaben|nächste schritte|massnahmen|maßnahmen/i;
const OPEN = /open questions?|unknowns?|offene fragen|offene punkte|needs your input/i;

/** A table of amounts or counts, and one of shares of a whole (a pie). */
const AMOUNTS = /budget|cost|kosten|amount|betrag|price|preis|spend|ausgaben|revenue|umsatz|eur\b|€|usd|\$|%|percent|prozent|count|anzahl|number of|split|verteilung|share|anteil/i;
const SHARES = /budget|split|verteilung|share|anteil|%|percent|prozent/i;

/** Headings that name the decision itself, where one paragraph is the decision. */
const DECISION_HEADING = /^(the )?(decision|decisions|entscheidung|entscheidungen|beschluss)$/i;

/** Shell commands written after a colon in a step: they go into a code block of their own. */
const COMMAND =
  /^(.*?\S)\s*:\s*((?:sudo\s+)?(?:kubectl|vault|docker|git|npm|pnpm|yarn|curl|psql|ssh|helm|aws|gcloud|az|terraform|systemctl|journalctl|make|python3?|node|openssl|security|xcrun|fastlane|gradle|\.\/[\w-]+)\s.+)$/;

/** Splits "Restart it: kubectl rollout restart ..., then kubectl ..." into the words and the commands. */
function splitCommand(text: string): { text: string; code: string } | null {
  const m = COMMAND.exec(text.trim());
  if (!m) return null;
  const code = m[2]
    .split(/,?\s+(?:and\s+)?then\s+(?:check[^:]*?with\s+)?|;\s+/i)
    .map((c) => c.trim().replace(/[.,]$/, ''))
    .filter(Boolean)
    .join('\n');
  return { text: m[1].replace(/\s+(with|using|via)$/i, ''), code };
}

/** Sentences that only fill space. */
const FILLER =
  /^(no (additional|further|other) (notes|information|details)|there (are|were) no (explicit |further )?(open questions|notes)|keine (weiteren )?(notizen|informationen|angaben|offenen fragen))\b/i;

/** Property names (left) a model sometimes swaps with their values. */
const PROPERTY_NAME =
  /^(date|datum|owner|eigent[uü]mer|verantwortlich(e|er)?|responsible|attendees|teilnehmer(innen)?|status|decision date|entscheidungsdatum|auditor|budget|go-?live|deadline|frist|project|projekt|cms|team|version|release)$/i;

/**
 * The key facts of a page as the reader needs them: a model also sends rows of punctuation,
 * swapped names and values, Robert as owner, or the page's own draft state and space.
 */
function cleanRows(rows: string[][]): { key: string; value: string }[] {
  return rows
    .map(([k, v]) => [plainText(k, 200), plainText(v ?? '', 1000)])
    .map(([k, v]) => (PROPERTY_NAME.test(v) && !PROPERTY_NAME.test(k) ? [v, k] : [k, v]))
    .filter(([k, v]) => /[\p{L}\p{N}]/u.test(k) && /[\p{L}\p{N}]/u.test(v))
    .filter(([k, v]) => !(/^(key|name|schl[uü]ssel|feld|field)$/i.test(k) && /^(value|wert)$/i.test(v)))
    .filter(([k, v]) => !/\brobert\b/i.test(`${k} ${v}`))
    .filter(([k, v]) => !/^(space|bereich|wiki)$/i.test(k) && !/^(draft|entwurf|published|ver[oö]ffentlicht)$/i.test(v))
    .slice(0, 30)
    .map(([key, value]) => ({ key, value }));
}

const LABELS = {
  en: {
    sources: 'Sources',
    source: 'Chat message',
    more: 'and {n} more',
    tasks: 'Tasks',
    general:
      'Robert wrote this page from general knowledge, not from your conversation or tasks. Check every step before you publish it.',
  },
  de: {
    sources: 'Quellen',
    source: 'Chatnachricht',
    more: 'und {n} weitere',
    tasks: 'Aufgaben',
    general:
      'Robert hat diese Seite aus allgemeinem Wissen geschrieben, nicht aus eurer Unterhaltung oder euren Aufgaben. Prüfe jeden Schritt, bevor du sie veröffentlichst.',
  },
};

export function renderWikiDoc(blocks: WikiBlock[], refs: WikiRenderRefs): WikiRenderResult {
  const unknown = new Set<string>();
  const notes = new Set<string>();
  // The macros a page shows once: one chart, one live table, one report of each kind.
  const once = new Set<WikiBlockType>();
  const hasOwnChart = blocks.some((b) => b.type === 'chart');
  const first = (type: WikiBlockType) => (once.has(type) ? false : (once.add(type), true));
  const items = new Set<number>();
  const cite = new Map<string, number>();
  const words = LABELS[refs.language === 'de' ? 'de' : 'en'];
  let trimmed = blocks.length > MAX_WIKI_BLOCKS;
  let chars = 0;
  let substance = 0;

  const line = (value: string | null | undefined) => inline(value, refs, cite);
  const codeBlock = (code: string): TipTapNode => ({
    type: 'codeBlock',
    attrs: { language: 'bash' },
    content: [{ type: 'text', text: cleanUntrusted(code).slice(0, MAX_BLOCK_CHARS) }],
  });
  // A step with a command keeps its words, and the command goes into a code block under it.
  const listItem = (entry: string): TipTapNode | null => {
    const split = splitCommand(plainText(entry));
    const c = line(split ? split.text : entry);
    if (!c.length) return null;
    return { type: 'listItem', content: split ? [para(c), codeBlock(split.code)] : [para(c)] };
  };
  const list = (type: 'bulletList' | 'orderedList', entries: string[]): TipTapNode | null => {
    const rows = entries
      .slice(0, MAX_ITEMS)
      .map(listItem)
      .filter((n): n is TipTapNode => !!n);
    return rows.length ? { type, content: rows } : null;
  };
  const shownTasks = new Set<string>();
  const card = (t: WikiTaskRef): TipTapNode => {
    if ('item' in t) {
      items.add(t.item);
      // Filled in by the executor once that task exists (agent-action-executor fillItems).
      return { type: 'taskCard', attrs: { config: { taskKey: '', spaceId: null, robertItem: t.item } } };
    }
    return { type: 'taskCard', attrs: { config: { taskKey: t.key, spaceId: t.spaceId } } };
  };

  const render = (b: WikiBlock, index: number): TipTapNode[] => {
    switch (b.type) {
      case 'heading': {
        const c = line(b.text);
        const level = Math.min(Math.max(b.level ?? 2, 1), 3);
        return c.length ? [{ type: 'heading', attrs: { level }, content: c }] : [];
      }
      case 'paragraph': {
        if (FILLER.test(plainText(b.text))) return [];
        const split = splitCommand(plainText(b.text));
        const c = line(split ? split.text : b.text);
        if (c.length) substance++;
        return c.length ? [para(c), ...(split ? [codeBlock(split.code)] : [])] : [];
      }
      case 'bullets':
      case 'numbered': {
        const node = list(b.type === 'bullets' ? 'bulletList' : 'orderedList', b.items);
        if (node) substance++;
        return node ? [node] : [];
      }
      case 'checklist': {
        const rows = b.items.slice(0, MAX_ITEMS).map((raw) => {
          const checked = /^\s*\[x\]\s*/i.test(raw);
          return { checked, content: line(raw.replace(/^\s*\[[ x]\]\s*/i, '')) };
        });
        const kept = rows.filter((r) => r.content.length);
        if (!kept.length) return [];
        substance++;
        return [
          {
            type: 'taskList',
            content: kept.map((r) => ({
              type: 'taskItem',
              attrs: { checked: r.checked },
              content: [para(r.content)],
            })),
          },
        ];
      }
      case 'quote': {
        const c = line(b.text);
        return c.length ? [{ type: 'blockquote', content: [para(c)] }] : [];
      }
      case 'code': {
        const code = cleanUntrusted(b.text ?? '').slice(0, MAX_BLOCK_CHARS);
        if (!code.trim()) return [];
        const language = /^[\w+#-]{1,30}$/.test(b.language ?? '') ? b.language : 'plaintext';
        return [{ type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text: code }] }];
      }
      case 'divider':
        return [{ type: 'horizontalRule' }];
      case 'table': {
        const rows = b.rows
          .slice(0, MAX_TABLE_ROWS)
          .map((r) => r.slice(0, MAX_TABLE_COLUMNS));
        const width = Math.max(0, ...rows.map((r) => r.length));
        if (rows.length < 2 || !width) return [];
        substance++;
        return [
          {
            type: 'table',
            content: rows.map((r, i) => ({
              type: 'tableRow',
              content: Array.from({ length: width }, (_, c) => ({
                type: i === 0 ? 'tableHeader' : 'tableCell',
                content: [para(line(r[c] ?? ''))],
              })),
            })),
          },
        ];
      }
      case 'callout': {
        const body = [
          ...(line(b.text).length ? [para(line(b.text))] : []),
          ...[list('bulletList', b.items)].filter((n): n is TipTapNode => !!n),
        ];
        if (!body.length) return [];
        substance++;
        const variant = (CALLOUT_VARIANTS as readonly string[]).includes(b.variant ?? '')
          ? b.variant
          : 'info';
        const title = plainText(datesAsText(b.title ?? '', refs.language), 200);
        return [{ type: 'callout', attrs: { variant, ...(title ? { title } : {}) }, content: body }];
      }
      case 'toggle': {
        const summary = plainText(datesAsText(b.title || b.text || '', refs.language), 200);
        const body = [
          ...(b.title && line(b.text).length ? [para(line(b.text))] : []),
          ...[list('bulletList', b.items)].filter((n): n is TipTapNode => !!n),
        ];
        if (!summary || !body.length) return [];
        return [
          {
            type: 'details',
            content: [
              { type: 'detailsSummary', content: [{ type: 'text', text: summary }] },
              { type: 'detailsContent', content: body },
            ],
          },
        ];
      }
      case 'columns': {
        const cols = b.items.slice(0, 3).map((c) => line(c)).filter((c) => c.length);
        if (cols.length < 2) return [];
        return [
          {
            type: 'columnList',
            content: cols.map((c) => ({ type: 'column', content: [para(c)] })),
          },
        ];
      }
      case 'status': {
        const color = (STATUS_COLORS as readonly string[]).includes(b.variant ?? '')
          ? b.variant
          : 'grey';
        const lozenges = b.items
          .map((s) => plainText(datesAsText(s, refs.language), 200))
          .filter(Boolean)
          .slice(0, 10)
          .map((t) => ({ type: 'status', attrs: { text: t, color } }));
        const label = line(b.text);
        if (!lozenges.length) return [];
        const spaced = lozenges.flatMap((n, i) => (i ? [{ type: 'text', text: ' ' }, n] : [n]));
        return [para(label.length ? [...label, { type: 'text', text: ' ' }, ...spaced] : spaced)];
      }
      case 'decisions': {
        const rows = b.items.slice(0, MAX_ITEMS).map((e) => line(e)).filter((c) => c.length);
        if (!rows.length) return [];
        substance++;
        return [
          {
            type: 'decisionList',
            content: rows.map((c) => ({
              type: 'decisionItem',
              attrs: { state: 'DECIDED' },
              content: [para(c)],
            })),
          },
        ];
      }
      case 'toc':
        return [{ type: 'confluenceToc', attrs: { params: { maxLevel: '3' } } }];
      case 'properties': {
        // Pairs as rows; models also send "Key: value" items or a flat [key, value, …] list.
        const fromItems = b.items.every((i) => i.includes(':'))
          ? b.items.map((i) => [i.slice(0, i.indexOf(':')), i.slice(i.indexOf(':') + 1)])
          : Array.from({ length: Math.floor(b.items.length / 2) }, (_, n) => [
              b.items[2 * n],
              b.items[2 * n + 1],
            ]);
        const rows = cleanRows(
          (b.rows.length ? b.rows : fromItems).map((r) => r.map((c) => datesAsText(propertyText(c ?? '', r[0] ?? '', refs), refs.language))),
        );
        return rows.length ? [{ type: 'contentProperties', attrs: { rows } }] : [];
      }
      case 'excerpt': {
        const c = line(b.text);
        if (!c.length) return [];
        substance++;
        return [{ type: 'excerpt', attrs: { name: 'summary' }, content: [para(c)] }];
      }
      case 'task_cards': {
        const found: WikiTaskRef[] = [];
        // Models sometimes list the handles under items; both count.
        // People (P2) are never tasks, and a label repeated as an entry is the label itself.
        const label = new Set(b.labels.map((l) => l.trim().toLowerCase()));
        const named = [...b.refs, ...b.items].filter((r) => r.trim() && !/^P\d+$/.test(r.trim()) && !label.has(r.trim().toLowerCase()));
        for (const r of named) {
          const t = refs.task(r.trim());
          if (t) found.push(t);
          else unknown.add(r.trim());
        }
        const labelled = b.labels.length ? (refs.labelled(index) ?? []) : [];
        const all = [...found, ...labelled];
        // Once per page: models list the same tasks on a heading and in the block under it.
        const unique = all.filter((t) => {
          const k = 'item' in t ? `i${t.item}` : t.key;
          if (shownTasks.has(k)) return false;
          shownTasks.add(k);
          return true;
        });
        if (!unique.length) return [];
        substance++;
        const shown = unique.slice(0, MAX_TASK_CARDS).map(card);
        const rest = unique.length - shown.length;
        return rest > 0 ? [...shown, textPara(words.more.replace('{n}', String(rest)))] : shown;
      }
      case 'child_pages':
        return [{ type: 'pageTree', attrs: { rootPageId: refs.pageId, depth: 2 } }];
      case 'include_page': {
        const out: TipTapNode[] = [];
        for (const r of b.refs.slice(0, 5)) {
          const p = refs.page(r.trim());
          if (p) out.push({ type: 'includePage', attrs: { pageId: p.id } });
          else unknown.add(r.trim());
        }
        return out;
      }
      case 'pages_by_label': {
        const labels = b.labels.map((l) => plainText(l, 100)).filter(Boolean).slice(0, 20);
        if (!labels.length) return [];
        return [
          {
            type: 'contentByLabel',
            attrs: {
              labels,
              ...(refs.spaceKey ? { spaceKeys: [refs.spaceKey] } : {}),
              limit: 20,
            },
          },
        ];
      }
      case 'chart': {
        const firstChart = first('chart');
        const chart = firstChart ? chartOf(b) : null;
        if (chart) {
          substance++;
          return [chart];
        }
        // The numbers stay readable as a table; they are only never drawn unverified. A page shows
        // one chart, and a second one being a table says nothing about its numbers.
        if (firstChart) notes.add('chart_unverified');
        return render({ ...b, type: 'table' }, index);
      }
      case 'task_table': {
        if (!refs.spaceId || !first('task_table')) return [];
        const statusIds = [
          ...new Set(b.items.map((s) => refs.status?.(plainText(s, 100)) ?? null).filter((id): id is string => !!id)),
        ];
        if (b.items.some((s) => plainText(s, 100)) && !statusIds.length) notes.add('unknown_status');
        const assigneeIds = [
          ...new Set(
            b.refs
              .map((r) => (/^P\d+$/.test(r.trim()) ? refs.person(r.trim())?.userId : null))
              .filter((id): id is string => !!id),
          ),
        ];
        const search = plainText(b.text, 100);
        const quick = {
          ...(statusIds.length ? { statusIds } : {}),
          ...(assigneeIds.length ? { assigneeIds } : {}),
          ...(search ? { search } : {}),
        };
        substance++;
        return [
          {
            type: 'ticketTable',
            attrs: {
              config: {
                mode: 'space',
                spaceId: refs.spaceId,
                ...(Object.keys(quick).length ? { quick } : {}),
                columns: TASK_TABLE_COLUMNS,
                maxRows: 20,
              },
            },
          },
        ];
      }
      case 'decision_report': {
        if (!refs.spaceKey) return [];
        const asked = b.labels.map((l) => plainText(l, 100)).filter(Boolean).slice(0, 20);
        const labels = asked.filter((l) => refs.label?.(l));
        // A label that is not in this space would report nothing, or someone else's decisions.
        if (asked.length && !labels.length) {
          notes.add('unknown_label');
          return [];
        }
        if (!first('decision_report')) return [];
        return [{ type: 'decisionReport', attrs: { labels, spaceKeys: [refs.spaceKey], limit: 50 } }];
      }
      case 'properties_report': {
        const label = b.labels.map((l) => plainText(l, 50)).find((l) => l && refs.label?.(l));
        if (!label) {
          notes.add('unknown_label');
          return [];
        }
        if (!first('properties_report')) return [];
        return [{ type: 'contentPropertiesReport', attrs: { label, limit: 30, sortBy: 'title' } }];
      }
      case 'recent_updates':
        return refs.spaceKey && first('recent_updates')
          ? [{ type: 'recentlyUpdated', attrs: { spaceKey: refs.spaceKey, limit: 10 } }]
          : [];
      case 'contributors':
        return first('contributors') ? [{ type: 'contributors', attrs: { limit: 10 } }] : [];
      case 'labels_list':
        return first('labels_list') ? [{ type: 'labelsList', attrs: {} }] : [];
      case 'space_attachments':
        return first('space_attachments') ? [{ type: 'spaceAttachments', attrs: { limit: 20 } }] : [];
      default:
        return [];
    }
  };

  /**
   * A chart from a table of stated numbers: a header (label, series…), 2–12 rows, 1–5 series,
   * every value one the sources state. Anything else is null and stays a plain table.
   */
  const chartOf = (b: WikiBlock): TipTapNode | null => {
    const rows = b.rows.map((r) => r.map((c) => plainText(c, 200)));
    const header = rows[0] ?? [];
    const data = rows.slice(1).filter((r) => r.some(Boolean));
    const series = header.length - 1;
    if (series < 1 || series > MAX_CHART_SERIES || data.length < 2 || data.length > MAX_CHART_POINTS) return null;
    const values = data.map((r) => r.slice(1, header.length).map((c) => (c ? chartValue(c, refs) : null)));
    if (data.some((r) => !r[0]) || values.some((r) => r.length !== series || r.some((v) => v === null))) return null;
    const type = (CHART_TYPES as readonly string[]).includes(b.variant ?? '') && !(b.variant === 'pie' && series > 1)
      ? b.variant
      : 'bar';
    const title = plainText(datesAsText(b.title || b.text || '', refs.language), 200);
    const cell = (kind: string, text: string) => ({ type: kind, content: [textPara(text)] });
    return {
      type: 'chart',
      attrs: { type, ...(title ? { title } : {}), legend: true },
      content: [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: header.map((h, i) => cell('tableHeader', (h || (i ? `${i}` : '')).slice(0, 60))) },
            ...data.map((r, n) => ({
              type: 'tableRow',
              content: [cell('tableCell', r[0].slice(0, 60)), ...values[n].map((v) => cell('tableCell', v as string))],
            })),
          ],
        },
      ],
    };
  };

  /**
   * What the model meant, as the macro that shows it best: it writes the header of a table into
   * items, puts amounts in a table where a chart says more, and lists people as task cards when
   * it means their tasks. The data stays the model's; only the macro changes.
   */
  const promote = (b: WikiBlock): WikiBlock => {
    // Properties are key → value facts; a header row over a column of amounts is a table.
    const amount = (v: string | undefined) => /^[\d.,'’ ]+\s*(k|tsd|mio)?\s*(€|eur|usd|\$|%)?$/i.test(String(v ?? '').trim());
    if (b.type === 'properties' && b.rows.length >= 3 && !amount(b.rows[0][1]) && b.rows.slice(1).every((r) => amount(r[1])))
      return promote({ ...b, type: 'table', items: [] });
    if (b.type === 'table' || b.type === 'chart') {
      const width = Math.max(0, ...b.rows.map((r) => r.length));
      const fresh = !b.rows.some((r) => r.join('|') === b.items.join('|'));
      // The header in items, with or without a cell above the row labels.
      let rows =
        fresh && width > 1 && b.items.length === width
          ? [b.items, ...b.rows]
          : fresh && width > 2 && b.items.length === width - 1
            ? [['', ...b.items], ...b.rows]
            : b.rows;
      // One wide row (Cost | 12500 | 30000 | 4200) charts as one row per column; a table stays as written.
      const tall =
        rows.length === 2 && rows[0].length >= 3
          ? [[rows[0][0] ?? '', rows[1][0] ?? ''], ...rows[0].slice(1).map((h, i) => [h, rows[1][i + 1] ?? ''])]
          : rows;
      if (b.type === 'chart') return { ...b, rows: chartOf({ ...b, rows: tall, items: [] }) ? tall : rows, items: [] };
      const table = { ...b, rows, items: [] };
      // Amounts or counts, every one stated in the sources: a chart (its source table stays one click away).
      const about = `${section} ${b.title ?? ''} ${(rows[0] ?? []).join(' ')}`;
      // Never ahead of a chart the model asked for: the page's one chart is that one.
      if (AMOUNTS.test(about) && !once.has('chart') && !hasOwnChart && chartOf({ ...table, rows: tall, type: 'chart' })) {
        rows = tall;
        const share = rows[0]?.length === 2 && SHARES.test(about);
        return { ...table, rows, type: 'chart', variant: share ? 'pie' : 'bar', title: b.title || plainText(section, 200) || null };
      }
      return table;
    }
    if (b.type === 'task_table' && b.labels.length) return { ...b, items: [...b.items, ...b.labels], labels: [] };
    // "Open tasks" as cards of people (P2): their tasks, live.
    if (
      b.type === 'task_cards' &&
      [...b.refs, ...b.items].length &&
      [...b.refs, ...b.items].every((r) => /^P\d+$/.test(r.trim()))
    )
      return { ...b, type: 'task_table', refs: [...b.refs, ...b.items], items: b.labels, labels: [] };
    return b;
  };

  const content: TipTapNode[] = [];
  let section = '';
  // Models list decisions, action items and open questions as plain bullets, and sometimes put
  // the entries on the heading itself: the section heading says what they are.
  const asSection = (b: WikiBlock): WikiBlock => {
    const list = b.type === 'bullets' || b.type === 'numbered';
    if (list && DECISIONS.test(section) && !ACTIONS.test(section)) return { ...b, type: 'decisions' };
    if (list && ACTIONS.test(section)) return { ...b, type: 'checklist' };
    if ((list || b.type === 'paragraph') && OPEN.test(section) && !FILLER.test(plainText(b.text)))
      return { ...b, type: 'callout', variant: 'warning' };
    if (b.type === 'paragraph' && DECISION_HEADING.test(section.trim()) && b.text)
      return { ...b, type: 'decisions', text: null, items: [b.text] };
    return promote(b);
  };
  for (let [index, given] of blocks.slice(0, MAX_WIKI_BLOCKS).entries()) {
    if (given.type === 'heading') section = given.text ?? '';
    // Message handles in refs are citations: they go into the text, where [m7] links them.
    // A shared file (F1) is cited like a message: its link goes to the message that carries it.
    const cites = given.refs.filter((r) => /^[mF]\d+$/.test(r.trim())).map((r) => `[${r.trim()}]`);
    if (cites.length && !['task_cards', 'include_page', 'heading'].includes(given.type)) {
      const tail = ` ${cites.join('')}`;
      given = given.items.length && !given.text
        ? { ...given, refs: [], items: [...given.items.slice(0, -1), `${given.items.at(-1)}${tail}`] }
        : { ...given, refs: [], text: `${given.text ?? ''}${tail}` };
    }
    // A paragraph of "- " lines is a list; refs on a heading are the task cards of its section.
    const lines = (given.text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const normal: WikiBlock =
      given.type === 'paragraph' && lines.length > 0 && lines.every((l) => /^[-*•]\s+/.test(l))
        ? { ...given, type: 'bullets', text: null, items: lines.map((l) => l.replace(/^[-*•]\s+/, '')) }
        : given;
    const nodes =
      normal.type === 'heading' && (normal.items.length || normal.refs.length)
        ? [
            ...render({ ...normal, items: [], refs: [] }, index),
            ...(normal.items.length
              ? render(asSection({ ...normal, type: 'bullets', text: null, level: null, refs: [] }), index)
              : []),
            ...(normal.refs.length
              ? render({ ...normal, type: 'task_cards', text: null, items: [], labels: [] }, index)
              : []),
          ]
        : render(asSection(normal), index);
    const size = JSON.stringify(nodes).length;
    if (chars + size > MAX_PAGE_CHARS) {
      trimmed = true;
      break;
    }
    chars += size;
    content.push(...nodes);
  }

  // A page proposed with tasks shows them, live, when the model left them out.
  const runItems = (refs.runItems ?? []).filter((n) => !items.has(n));
  if (runItems.length && !items.size) {
    content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: words.tasks }] });
    content.push(...runItems.map((item) => card({ item })));
  }

  // A heading with nothing under it (up to the next heading of its level or above) goes.
  const levelOf = (n: TipTapNode) => (n.type === 'heading' ? Number(n.attrs?.level ?? 2) : 99);
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === 'heading' && (i === content.length - 1 || levelOf(content[i + 1]) <= levelOf(content[i])))
      content.splice(i, 1);
  }

  // The messages the model named as the page's basis, when it cited none inline.
  if (!cite.size)
    for (const handle of refs.sources ?? []) if (refs.message(handle) && !cite.has(handle)) cite.set(handle, cite.size + 1);

  // Nothing from the conversation or the workspace went in: say so on the page, prominently.
  if (
    refs.generalKnowledge ||
    (!cite.size && !content.some((n) => JSON.stringify(n).includes('"taskCard"') || n.type === 'includePage'))
  )
    content.unshift({
      type: 'callout',
      attrs: { variant: 'info' },
      content: [textPara(words.general)],
    });

  // Sources: the messages the page cites, as in-app links (only members of the chat can open them).
  if (cite.size) {
    content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: words.sources }] });
    const listed = [...cite.keys()].slice(0, MAX_SOURCES);
    content.push({
      type: 'orderedList',
      content: listed.map((handle) => ({
        type: 'listItem',
        content: [
          para([
            {
              type: 'text',
              text: refs.messageLabel?.(handle) ?? words.source,
              marks: [{ type: 'link', attrs: { href: refs.message(handle), target: '_self', rel: LINK_REL } }],
            },
          ]),
        ],
      })),
    });
    if (cite.size > listed.length) content.push(textPara(words.more.replace('{n}', String(cite.size - listed.length))));
  }

  return {
    doc: { type: 'doc', content: content.length ? content : [para([])] },
    unknown: [...unknown],
    trimmed,
    empty: substance === 0,
    items: [...items],
    notes: [...notes],
  };
}

/** Every task card of this request's items, filled in with the created key (or plain text). */
export function fillItemCards(
  doc: { type: 'doc'; content: TipTapNode[] },
  created: (item: number) => { key: string; spaceId: string } | null,
  missing: string,
): { type: 'doc'; content: TipTapNode[] } {
  const walk = (nodes: TipTapNode[]): TipTapNode[] =>
    nodes.map((n) => {
      const config = n.type === 'taskCard' ? (n.attrs?.config as Record<string, unknown>) : null;
      if (config && typeof config.robertItem === 'number') {
        const task = created(config.robertItem);
        return task
          ? { type: 'taskCard', attrs: { config: { taskKey: task.key, spaceId: task.spaceId } } }
          : textPara(missing);
      }
      return n.content ? { ...n, content: walk(n.content) } : n;
    });
  return { type: 'doc', content: walk(doc.content) };
}
