/**
 * @fileoverview Atlassian Document Format (ADF) → XI-CIR, for Confluence Cloud bodies
 * (`atlas_doc_format`). Structural JSON walk covering the common node set; ADF
 * `extension`/`bodiedExtension` (Cloud macros) → `onMacro` (deferred in Milestone A).
 */

import { resolveEmojiText } from '../util/emoji-text.util';
import type {
  CirBlockFormat,
  CirDoc,
  CirMark,
  CirNode,
  CirTableCell,
  ParsedMacro,
} from './canonical-ir';

interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
}

export interface AdfParseHooks {
  onMacro: (macro: ParsedMacro) => CirNode | CirNode[] | null;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

const MARK_MAP: Record<string, CirMark> = {
  strong: 'strong',
  em: 'em',
  underline: 'underline',
  strike: 'strike',
  code: 'code',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

const ALIGNMENTS = new Set(['left', 'center', 'right', 'justify']);

/**
 * Read ADF's block-level `indentation` and `alignment` MARKS into CIR block attributes.
 *
 * ADF is the outlier here in modelling these as marks on the block node; TipTap and HTML both model
 * them as attributes of the block itself. The generic mark loop only runs for text nodes, so before
 * this both were dropped without a trace (25 indents and 2 alignments in the customer's space).
 */
function blockFormat(node: AdfNode): CirBlockFormat {
  const out: CirBlockFormat = {};

  for (const mark of node.marks ?? []) {
    if (mark.type === 'indentation') {
      const level = num(mark.attrs?.level);

      if (level && level > 0) out.indent = level;
    } else if (mark.type === 'alignment') {
      const align = str(mark.attrs?.align);

      if (align && ALIGNMENTS.has(align)) {
        out.align = align as CirBlockFormat['align'];
      }
    }
  }

  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

export function adfToCir(value: unknown, hooks: AdfParseHooks): CirDoc {
  const doc = value as AdfNode | null;
  const content = doc?.content ?? [];

  return { type: 'doc', children: content.flatMap((n) => blockNode(n, hooks)) };
}

function blockNode(node: AdfNode, hooks: AdfParseHooks): CirNode[] {
  switch (node.type) {
    case 'paragraph':
      return [
        {
          type: 'paragraph',
          children: inlineNodes(node.content ?? [], hooks),
          ...blockFormat(node),
        },
      ];

    case 'heading':
      return [
        {
          type: 'heading',
          level: num(node.attrs?.level) ?? 1,
          children: inlineNodes(node.content ?? [], hooks),
          ...blockFormat(node),
        },
      ];

    case 'bulletList':
    case 'orderedList':
      return [
        {
          type: 'list',
          ordered: node.type === 'orderedList',
          items: (node.content ?? []).map((li) =>
            (li.content ?? []).flatMap((c) => blockNode(c, hooks)),
          ),
        },
      ];

    case 'blockquote':
      return [
        {
          type: 'blockquote',
          children: (node.content ?? []).flatMap((c) => blockNode(c, hooks)),
        },
      ];

    case 'codeBlock':
      return [
        {
          type: 'codeBlock',
          language: str(node.attrs?.language),
          text: (node.content ?? []).map((c) => c.text ?? '').join(''),
        },
      ];

    case 'rule':
      return [{ type: 'rule' }];

    case 'panel':
      return [
        {
          type: 'panel',
          variant: str(node.attrs?.panelType),
          children: (node.content ?? []).flatMap((c) => blockNode(c, hooks)),
        },
      ];

    case 'taskList':
      return [
        {
          type: 'taskList',
          items: (node.content ?? []).map((item) => ({
            checked: str(item.attrs?.state) === 'DONE',
            children: inlineNodes(item.content ?? [], hooks),
          })),
        },
      ];

    /**
     * Decisions. Previously fell to the `default` branch, whose `blockNode(textNode)` recursion
     * returns `[]` for a bare text child — so every decision on every page vanished with no log.
     * The customer's space contains 199 of them.
     */
    case 'decisionList':
      return [
        {
          type: 'decisionList',
          items: (node.content ?? []).map((item) => ({
            // A decision is recorded rather than completed; `DECIDED` is the norm.
            decided: str(item.attrs?.state) !== 'UNDECIDED',
            children: inlineNodes(item.content ?? [], hooks),
          })),
        },
      ];

    /**
     * Multi-column layouts. The default recursion flattened every column into a single stream, so a
     * two-column page silently became one column of concatenated content.
     */
    case 'layoutSection': {
      const columns = (node.content ?? [])
        .filter((c) => c.type === 'layoutColumn')
        .map((col) => (col.content ?? []).flatMap((c) => blockNode(c, hooks)));

      if (columns.length === 0) {
        return (node.content ?? []).flatMap((c) => blockNode(c, hooks));
      }

      // A single full-width column is not a layout — inline it rather than adding a wrapper.
      return columns.length === 1 ? columns[0] : [{ type: 'layout', columns }];
    }

    case 'layoutColumn':
      // Reached only when a column appears outside a section; keep its content.
      return (node.content ?? []).flatMap((c) => blockNode(c, hooks));

    /**
     * Expand / nested expand. The default recursion kept the body but dropped `attrs.title`, which
     * is the only label a reader has for a collapsed section.
     */
    case 'expand':
    case 'nestedExpand':
      return [
        {
          type: 'expand',
          title: str(node.attrs?.title),
          children: (node.content ?? []).flatMap((c) => blockNode(c, hooks)),
        },
      ];

    /** Media caption (ADF `caption`) — a sibling of the media it describes. */
    case 'caption':
      return [
        { type: 'caption', children: inlineNodes(node.content ?? [], hooks) },
      ];

    case 'mediaSingle':
    case 'mediaGroup':
      return (node.content ?? []).flatMap((c) => blockNode(c, hooks));

    case 'media':
      return [mediaNode(node)];

    case 'table':
      return [tableNode(node, hooks)];

    case 'extension':
    case 'bodiedExtension':
    case 'inlineExtension': {
      const macro = hooks.onMacro(buildAdfParsedMacro(node, hooks));

      if (!macro) return [];

      return Array.isArray(macro) ? macro : [macro];
    }

    default:
      // Unknown block → recurse so content is never lost.
      return (node.content ?? []).flatMap((c) => blockNode(c, hooks));
  }
}

function inlineNodes(nodes: AdfNode[], hooks: AdfParseHooks): CirNode[] {
  const out: CirNode[] = [];

  for (const node of nodes) {
    if (node.type === 'text') {
      const marks: CirMark[] = [];
      let link: string | undefined;

      let color: string | undefined;

      for (const mark of node.marks ?? []) {
        if (mark.type in MARK_MAP) marks.push(MARK_MAP[mark.type]);
        else if (mark.type === 'link') link = str(mark.attrs?.href);
        // ADF names it `textColor` and carries a hex value; the target mark is `textStyle{color}`.
        else if (mark.type === 'textColor') color = str(mark.attrs?.color);
      }

      out.push({
        type: 'text',
        text: node.text ?? '',
        marks: marks.length ? marks : undefined,
        link,
        color,
      });
    } else if (node.type === 'hardBreak') {
      out.push({ type: 'hardBreak' });
    } else if (node.type === 'mention') {
      out.push({
        type: 'userMention',
        sourceId: str(node.attrs?.id) ?? '',
        displayName: str(node.attrs?.text)?.replace(/^@/, ''),
      });
    } else if (node.type === 'inlineCard') {
      const url = str(node.attrs?.url);

      // Confluence shows a resolved chip (favicon + title), not a naked URL.
      if (url) out.push({ type: 'inlineCard', url });
    } else if (node.type === 'emoji') {
      // Deliberately plain text: the resolved `attrs` give the unicode character, so it renders
      // exactly as in Confluence while staying searchable and editable. Wiki 2.0's `emoji` node keys
      // on a NAME instead, and a Confluence shortName it does not recognise would render as nothing
      // — trading 1295 correct characters for 1295 possible blanks.
      //
      // `attrs.text` is NOT usable raw: Atlassian ships it pre-escaped for most non-BMP emoji, so
      // reading it directly put the literal text `🗓` into the page. See emoji-text.util.
      const text = resolveEmojiText(node.attrs);

      if (text) out.push({ type: 'text', text });
    } else if (node.type === 'date') {
      const ts = str(node.attrs?.timestamp);

      // A real date node, not an ISO string: Wiki 2.0 renders it as a localized lozenge and keeps it
      // editable via the date picker, exactly as Confluence does.
      if (ts) out.push({ type: 'date', timestamp: ts });
    } else if (node.type === 'status') {
      const text = str(node.attrs?.text);

      // A real status chip WITH its colour. Emitting bold text (the old behaviour) silently threw
      // away the colour, which is the whole signal a status lozenge carries.
      if (text)
        out.push({
          type: 'status',
          text,
          color: str(node.attrs?.color)?.toLowerCase(),
        });
    } else if (node.type === 'media' || node.type === 'mediaInline') {
      out.push(mediaNode(node, node.type === 'mediaInline'));
    } else if (
      node.type === 'inlineExtension' ||
      node.type === 'extension' ||
      node.type === 'bodiedExtension'
    ) {
      // `inlineExtension` was handled ONLY in blockNode, so an inline macro inside a paragraph was
      // dropped with no placeholder and no log. Route it through the same macro registry.
      const macro = hooks.onMacro(buildAdfParsedMacro(node, hooks));

      if (macro) out.push(...(Array.isArray(macro) ? macro : [macro]));
    } else if (node.content) {
      out.push(...inlineNodes(node.content, hooks));
    }
  }

  return out;
}

function mediaNode(node: AdfNode, inline = false): CirNode {
  const type = str(node.attrs?.type);
  const url = str(node.attrs?.url);
  const alt = str(node.attrs?.alt);

  if (type === 'external' && url) {
    return { type: 'media', kind: 'image', src: url, alt, inline };
  }

  // ADF file media references an attachment by id/collection; the file name is not always in the
  // body — carry the alt/id so the attachments crosswalk can resolve where possible.
  return {
    type: 'media',
    kind: 'image',
    filename: str(node.attrs?.id) ?? alt,
    alt,
    inline,
  };
}

/**
 * Normalise an ADF `extension`/`bodiedExtension` (Cloud macro) into the shared `ParsedMacro`.
 * Cloud stores macro params under `attrs.parameters.macroParams` as `{ key: { value } }`.
 */
function buildAdfParsedMacro(node: AdfNode, hooks: AdfParseHooks): ParsedMacro {
  const name = (
    str(node.attrs?.extensionKey) ??
    str(node.attrs?.extensionType) ??
    'extension'
  ).toLowerCase();
  const params: Record<string, string> = {};
  const rawParams = node.attrs?.parameters as
    | { macroParams?: Record<string, { value?: unknown }> }
    | undefined;

  if (rawParams?.macroParams) {
    for (const [k, v] of Object.entries(rawParams.macroParams)) {
      if (typeof v?.value === 'string') params[k] = v.value;
    }
  }

  const richBody = (node.content ?? []).flatMap((c) => blockNode(c, hooks));
  // Walk DESCENDANTS, not just the top level. ADF wraps a macro body in paragraphs, which carry no
  // `.text` of their own — so reading one level deep made `plainBody` always '', which in turn made
  // every `code`/`noformat` macro arriving as an extension render as an empty code block.
  const plainBody = collectAdfText(node.content ?? []);

  return { name, params, richBody, plainBody };
}

/** Concatenate every text leaf beneath a run of ADF nodes. */
function collectAdfText(nodes: AdfNode[]): string {
  let out = '';

  for (const node of nodes) {
    if (typeof node.text === 'string') out += node.text;
    if (node.content) out += collectAdfText(node.content);
  }

  return out;
}

function tableNode(node: AdfNode, hooks: AdfParseHooks): CirNode {
  const rows = (node.content ?? []).map((row) => {
    const cells: CirTableCell[] = (row.content ?? []).map((cell) => ({
      header: cell.type === 'tableHeader',
      children: (cell.content ?? []).flatMap((c) => blockNode(c, hooks)),
      colspan: num(cell.attrs?.colspan),
      rowspan: num(cell.attrs?.rowspan),
    }));

    return { cells };
  });

  return { type: 'table', rows };
}
