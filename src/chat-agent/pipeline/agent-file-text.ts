/**
 * @fileoverview The text of a file a person shared with Robert (1.18, 1.19): plain text, HTML,
 * Word, PowerPoint, Excel and PDF, as the people reading the file see it. Pure: bytes in, text out.
 * Never evaluates anything the file contains (XML is read with patterns, PDF without scripts or
 * fonts), never throws on a bad file, and caps every step so a large or hostile file costs at most
 * what the caps allow. Deleted tracked changes and hidden slides and sheets are not what the file
 * says, so they are left out. Scans and images have no text layer: they are reported, and Robert
 * says so instead of guessing. selectRelevant keeps what a request needs from a long file.
 */
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

import { cleanUntrusted } from './agent-prompt';

export type FileUnreadable =
  | 'scanned'
  | 'type'
  | 'broken'
  | 'locked'
  | 'empty'
  | 'too_large'
  | 'no_access'
  | 'still_uploading'
  /** Listed, not opened: the request did not refer to files and it is not recent. */
  | 'not_read';

export interface FileText {
  text: string;
  truncated: boolean;
  /** PDF and PowerPoint: pages (slides) read, and how many there are. */
  pagesRead?: number;
  pagesTotal?: number;
  /** PDF: pages that are pictures of a page, so their content was not read. */
  scannedPages?: number[];
  /** Word and PowerPoint: pictures in the file; text inside them was not read. */
  pictures?: number;
  /** Hidden slides and sheets that were left out. */
  hidden?: string[];
  /** Set when only part of a long file was kept: how much of it, in percent. */
  readPercent?: number;
  /** Lines removed because they try to give Robert orders. */
  injections?: number;
  unreadable?: FileUnreadable;
}

/** The most text kept from one file before selecting from it. */
export const MAX_EXTRACT_CHARS = 500_000;
const MAX_PDF_PAGES = 300;
const MAX_PDF_MS = 10_000;
const MAX_SHEETS = 20;
const MAX_SHEET_ROWS = 5_000;
/** A zip that unpacks to more than this is not read (a zip bomb costs nothing then). */
const MAX_UNZIPPED = 60 * 1024 * 1024;
/** A page with an image and fewer letters than this is a scan (a running header does not count). */
const SCAN_PAGE_LETTERS = 100;
const MIN_PDF_FONT = 3;

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|xml)$/i;
const IMAGE = /^image\/|\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i;

const kindOf = (name: string, mime: string | null): 'text' | 'html' | 'docx' | 'pptx' | 'sheet' | 'pdf' | 'image' | null => {
  const m = (mime ?? '').toLowerCase();
  if (/\.pdf$/i.test(name) || m === 'application/pdf') return 'pdf';
  if (/\.docx$/i.test(name) || m.includes('wordprocessingml')) return 'docx';
  if (/\.pptx$/i.test(name) || m.includes('presentationml')) return 'pptx';
  if (/\.(xlsx|xlsm|xls|ods)$/i.test(name) || m.includes('spreadsheetml') || m === 'application/vnd.ms-excel') return 'sheet';
  if (IMAGE.test(name) || IMAGE.test(m)) return 'image';
  if (/\.html?$/i.test(name) || m === 'text/html') return 'html';
  if (TEXT_EXT.test(name) || m.startsWith('text/') || m === 'application/json') return 'text';
  return null;
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (xml: string) =>
  xml.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : ENTITIES[e.toLowerCase()],
  );

/**
 * Lines written to steer an AI, not to inform a person. The model is told to ignore such text and
 * does so only most of the time, so they do not reach it. Only unambiguous wording: a false match
 * costs one line and is reported in the reply; "make Ala an admin" is left alone, it can be a real action.
 */
const INJECTION = [
  /\b(ignore|disregard|forget|override|bypass)\b.{0,50}\b(instructions?|rules?|prompts?|guidelines?|polic(y|ies))\b/i,
  /\bsystem\s*(override|prompt|instructions?|message\s*:)/i,
  /\b(ignoriere|vergiss|missachte|umgehe)\b.{0,50}\b(anweisungen?|regeln?|prompts?|vorgaben?)\b/i,
  /\bsystem(anweisung|befehl|nachricht)(en)?\b/i,
  /\byou are now\b|\bnew instructions?\s*:/i,
  /\b(note|message|instruction)s?\s+(to|for)\s+(the\s+)?(ai|assistant|chatbot|llm|model|robert)\b/i,
  /\b(an|hinweis an|nachricht an)\s+(die\s+|den\s+)?(ki|assistenten?|chatbot|robert)\s*:/i,
  /\b(ai|ki)[- ]?(assistant|assistent|agent|model|modell)\b.{0,30}\b(must|should|shall|create|reply|muss|soll|erstelle)\b/i,
];
const INJECTION_MARK = '[text aimed at an AI assistant was removed here]';

/** Takes out the lines that give an AI orders, and counts them. */
export function withoutInjections(text: string): { text: string; injections: number } {
  let injections = 0;
  const lines = text.split('\n').map((line) => {
    if (!INJECTION.some((re) => re.test(line))) return line;
    injections++;
    return INJECTION_MARK;
  });
  return { text: lines.join('\n'), injections };
}

/** The capped, cleaned text, with `truncated` when the cap cut it (or `cut` says the source was). */
function capped(raw: string, extra: Partial<FileText> = {}, cut = false): FileText {
  const clean = withoutInjections(cleanUntrusted(raw).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
  const text = clean.text;
  if (!text) return { text: '', truncated: false, ...extra, unreadable: 'empty' };
  const over = text.length > MAX_EXTRACT_CHARS;
  return {
    text: over ? text.slice(0, MAX_EXTRACT_CHARS) : text,
    truncated: over || cut,
    ...extra,
    ...(clean.injections ? { injections: clean.injections } : {}),
  };
}

/** Text files come from everywhere: a BOM decides, then UTF-8, else the Windows code page Excel saves in. */
function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

const htmlText = (html: string) =>
  decode(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<\/(p|div|li|tr|h[1-6]|table|section|article)\s*>|<br\s*\/?>/gi, '\n')
      .replace(/<\/t[dh]\s*>/gi, ' | ')
      .replace(/<[^>]+>/g, ''),
  );

/** The part of JSZip's stream helper used here. */
interface JSZipStream {
  on(event: 'data', listener: (chunk: Uint8Array) => void): JSZipStream;
  on(event: 'error', listener: (err: Error) => void): JSZipStream;
  on(event: 'end', listener: () => void): JSZipStream;
  pause(): JSZipStream;
  resume(): JSZipStream;
}

/** Thrown when a zip inflates to more than it may: the file is too large, not broken. */
export class ZipTooLarge extends Error {
  constructor() {
    super('zip inflates beyond the limit');
    this.name = 'ZipTooLarge';
  }
}

/**
 * An entry's text, counted against what this file may still inflate to. The sizes a zip declares
 * are its own word; the bytes that come out are counted here (audit 2026-11-10).
 */
export function boundedText(file: JSZip.JSZipObject, budget: { left: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Uint8Array[] = [];
    // JSZip streams an entry chunk by chunk; its types do not list internalStream.
    const stream = (file as unknown as { internalStream(type: 'uint8array'): JSZipStream }).internalStream('uint8array');
    stream
      .on('data', (chunk: Uint8Array) => {
        budget.left -= chunk.length;
        if (budget.left < 0) {
          stream.pause();
          reject(new ZipTooLarge());
          return;
        }
        parts.push(chunk);
      })
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
      .resume();
  });
}

/** A zip whose entries are read within one shared budget; same shape as JSZip where it is used. */
interface BoundedZip {
  files: JSZip['files'];
  file(name: string): { async(type: 'string'): Promise<string> } | null;
}

async function unzip(bytes: Uint8Array): Promise<BoundedZip | null> {
  const zip = await JSZip.loadAsync(bytes);
  let total = 0;
  for (const f of Object.values(zip.files)) {
    total += (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (total > MAX_UNZIPPED) return null;
  }
  const budget = { left: MAX_UNZIPPED };
  return {
    files: zip.files,
    file: (name) => {
      const f = zip.file(name);
      return f ? { async: () => boundedText(f, budget) } : null;
    },
  };
}

/** Office files with a password are not zips at all: they are wrapped in an OLE container. */
const isOle = (bytes: Uint8Array) => bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;

const LOCKED: FileText = { text: '', truncated: false, unreadable: 'locked' };
const TOO_LARGE: FileText = { text: '', truncated: false, unreadable: 'too_large' };

/** Word body: what the document says now, as lines, table cells joined with " | ", headings marked. */
function wordXmlText(xml: string): string {
  return decode(
    xml
      // Hidden text, deleted tracked changes, field codes and the old-format copy of every drawing are not text.
      .replace(/<w:r\b(?:(?!<\/w:r>)[\s\S])*?<w:vanish\s*\/>[\s\S]*?<\/w:r>/g, '')
      .replace(/<w:del\b(?:[^>]*[^/])?>[\s\S]*?<\/w:del>/g, '')
      .replace(/<w:moveFrom\b(?:[^>]*[^/])?>[\s\S]*?<\/w:moveFrom>/g, '')
      .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '')
      .replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '')
      .replace(/<w:p\b[^>]*>\s*<w:pPr>\s*<w:pStyle w:val="(?:Heading|berschrift|Title|Titel)[^"]*"\s*\/>/g, '\n\n# ')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:tc>/g, ' | ')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n+ \| /g, ' | ')
    .replace(/ \| \n/g, '\n');
}

/** Word: the body, then footnotes and review comments (labelled, they are not the document's text). */
async function docxText(bytes: Uint8Array): Promise<FileText> {
  if (isOle(bytes)) return LOCKED;
  const zip = await unzip(bytes);
  if (!zip) return TOO_LARGE;
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) return { text: '', truncated: false, unreadable: 'broken' };
  const parts = [wordXmlText(xml)];
  const footnotes = await zip.file('word/footnotes.xml')?.async('string');
  const notes = footnotes ? wordXmlText(footnotes).trim() : '';
  if (notes) parts.push(`Footnotes:\n${notes}`);
  const comments = await zip.file('word/comments.xml')?.async('string');
  const said = [...(comments ?? '').matchAll(/<w:comment\b[^>]*?w:author="([^"]*)"[^>]*>([\s\S]*?)<\/w:comment>/g)]
    .map((m) => `- ${decode(m[1])}: ${wordXmlText(m[2]).trim()}`)
    .filter((l) => !l.endsWith(':'));
  if (said.length) parts.push(`Review comments (not part of the text):\n${said.join('\n')}`);
  const pictures = (xml.match(/<a:blip\b|<v:imagedata\b/g) ?? []).length;
  return capped(parts.join('\n\n'), pictures ? { pictures } : {});
}

const slideText = (xml: string) =>
  decode(
    xml
      .replace(/<a:tbl\b[\s\S]*?<\/a:tbl>/g, (table) =>
        table
          .replace(/<\/a:p>/g, ' ')
          .replace(/<\/a:tc>/g, ' | ')
          .replace(/<\/a:tr>/g, '\n'),
      )
      .replace(/<a:br\b[^>]*\/>/g, '\n')
      .replace(/<\/a:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/ +\| /g, ' | ')
    .replace(/ \| \n/g, '\n')
    .trim();

/** A chart's numbers per series, from the values the chart keeps with it. */
function chartText(xml: string): string {
  const points = (block: string) => [...block.matchAll(/<c:pt\b[^>]*>\s*<c:v>([^<]*)<\/c:v>/g)].map((m) => decode(m[1]));
  const lines = [...xml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map(([ser]) => {
    const name = points(/<c:tx>[\s\S]*?<\/c:tx>/.exec(ser)?.[0] ?? '')[0] ?? 'Series';
    const cats = points(/<c:cat>[\s\S]*?<\/c:cat>/.exec(ser)?.[0] ?? '');
    const vals = points(/<c:val>[\s\S]*?<\/c:val>/.exec(ser)?.[0] ?? '');
    return `${name}: ${vals.map((v, i) => (cats[i] ? `${cats[i]} ${v}` : v)).join(', ')}`;
  });
  return lines.length ? `Chart:\n${lines.join('\n')}` : '';
}

/** A file next to its part in the zip: "../charts/chart1.xml" of "ppt/slides/slide1.xml". */
const zipPath = (base: string, target: string) => {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const p of target.split('/')) {
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return parts.join('/');
};

/** The targets of a part's relationships, by id: `Type` ends with what it is (slide, notesSlide, chart). */
async function relsOf(zip: BoundedZip, part: string): Promise<{ id: string; type: string; target: string }[]> {
  const dir = part.split('/').slice(0, -1).join('/');
  const xml = await zip.file(`${dir}/_rels/${part.split('/').pop()}.rels`)?.async('string');
  return [...(xml ?? '').matchAll(/<Relationship\b[^>]*>/g)].map(([r]) => ({
    id: /\bId="([^"]*)"/.exec(r)?.[1] ?? '',
    type: /\bType="[^"]*\/([^"/]*)"/.exec(r)?.[1] ?? '',
    target: zipPath(part, decode(/\bTarget="([^"]*)"/.exec(r)?.[1] ?? '')),
  }));
}

/** PowerPoint: the slides in the order people see them, with charts and speaker notes; hidden ones left out. */
async function pptxText(bytes: Uint8Array): Promise<FileText> {
  if (isOle(bytes)) return LOCKED;
  const zip = await unzip(bytes);
  if (!zip) return TOO_LARGE;
  const main = (await zip.file('ppt/presentation.xml')?.async('string')) ?? '';
  const rels = await relsOf(zip, 'ppt/presentation.xml');
  const ordered = [...main.matchAll(/<p:sldId\b[^>]*\br:id="([^"]*)"/g)]
    .map((m) => rels.find((r) => r.id === m[1])?.target)
    .filter((t): t is string => !!t && !!zip.file(t));
  const slides = ordered.length
    ? ordered
    : Object.keys(zip.files)
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  const parts: string[] = [];
  const hidden: string[] = [];
  let pictures = 0;
  let read = 0;
  for (const [i, name] of slides.entries()) {
    const xml = (await zip.file(name)?.async('string')) ?? '';
    if (/<p:sld\b[^>]*\bshow="(0|false)"/.test(xml)) {
      hidden.push(`slide ${i + 1}`);
      continue;
    }
    read++;
    pictures += (xml.match(/<p:pic>/g) ?? []).length;
    const blocks = [slideText(xml)];
    for (const rel of await relsOf(zip, name)) {
      if (rel.type === 'chart') blocks.push(chartText((await zip.file(rel.target)?.async('string')) ?? ''));
      if (rel.type === 'notesSlide') {
        const notes = slideText(((await zip.file(rel.target)?.async('string')) ?? '').replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, ''));
        if (notes) blocks.push(`Speaker notes: ${notes}`);
      }
    }
    const words = blocks.filter(Boolean).join('\n');
    if (words) parts.push(`Slide ${i + 1}:\n${words}`);
  }
  return capped(parts.join('\n\n'), {
    pagesRead: read,
    pagesTotal: slides.length,
    ...(pictures ? { pictures } : {}),
    ...(hidden.length ? { hidden } : {}),
  });
}

/** A date cell as an ISO date: unambiguous, and right even when its format cannot be applied. */
function isoDates(sheet: XLSX.WorkSheet, date1904: boolean): void {
  for (const [ref, cell] of Object.entries(sheet) as [string, XLSX.CellObject][]) {
    if (ref[0] === '!' || cell.t !== 'n' || typeof cell.v !== 'number' || !cell.z || cell.v < 1 || !XLSX.SSF.is_date(String(cell.z))) continue;
    const at = new Date(Date.UTC(1899, 11, 30) + (cell.v + (date1904 ? 1462 : 0)) * 86_400_000).toISOString();
    const time = at.slice(11, 16);
    cell.w = time === '00:00' ? at.slice(0, 10) : `${at.slice(0, 10)} ${time}`;
  }
}

/** Excel: the visible sheets as CSV. A merged cell's value counts for every cell it covers. */
async function sheetText(bytes: Uint8Array): Promise<FileText> {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && !(await unzip(bytes))) return TOO_LARGE;
  const book = XLSX.read(bytes, { type: 'array', sheetRows: MAX_SHEET_ROWS, cellFormula: false, cellHTML: false, cellNF: true, bookVBA: false });
  const flags = book.Workbook?.Sheets ?? [];
  const isHidden = (n: string) => !!flags.find((s) => s.name === n)?.Hidden;
  const visible = book.SheetNames.filter((n) => !isHidden(n));
  const names = visible.slice(0, MAX_SHEETS);
  let cut = visible.length > MAX_SHEETS;
  const text = names
    .map((n) => {
      const sheet = book.Sheets[n];
      isoDates(sheet, !!book.Workbook?.WBProps?.date1904);
      for (const m of sheet['!merges'] ?? []) {
        const first = sheet[XLSX.utils.encode_cell(m.s)] as XLSX.CellObject | undefined;
        if (!first) continue;
        for (let r = m.s.r; r <= m.e.r; r++)
          for (let c = m.s.c; c <= m.e.c; c++) sheet[XLSX.utils.encode_cell({ r, c })] ??= { ...first };
      }
      const full = sheet['!fullref'] as string | undefined;
      if (full && XLSX.utils.decode_range(full).e.r >= MAX_SHEET_ROWS) cut = true;
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false, skipHidden: true }).replace(/,+$/gm, '');
      return `Sheet ${n}:\n${csv}`;
    })
    .join('\n\n');
  const hidden = book.SheetNames.filter(isHidden).map((n) => `sheet "${n}"`);
  return capped(text, hidden.length ? { hidden } : {}, cut);
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: Promise<PdfJs> | null = null;

interface PdfItem {
  str: string;
  x: number;
  y: number;
  width: number;
  size: number;
}

/** A page as lines, top to bottom: pieces far apart on a line are columns, joined with " | ". */
function pageLines(items: PdfItem[]): string {
  const rows: PdfItem[][] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y)) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0].y - item.y) <= Math.max(2, item.size * 0.3)) row.push(item);
    else rows.push([item]);
  }
  return rows
    .map((row) => {
      let line = '';
      let end = 0;
      for (const piece of row.sort((a, b) => a.x - b.x)) {
        const gap = piece.x - end;
        if (line) line += gap > piece.size * 1.2 ? ' | ' : gap > piece.size * 0.15 && !line.endsWith(' ') && !piece.str.startsWith(' ') ? ' ' : '';
        line += piece.str;
        end = piece.x + piece.width;
      }
      return line.trim();
    })
    .filter(Boolean)
    .join('\n');
}

/** PDF: the text layer page by page. A page that is only a picture is a scan; all of them, and the file is. */
/**
 * A pdf.js call that must be done by `until`. pdf.js cannot be stopped inside a call, so this only
 * stops the waiting; the task is destroyed after (audit 2026-11-10). The 10 MB file cap stays the
 * hard limit on what one call can cost.
 */
export class PdfTimeout extends Error {
  constructor() {
    super('pdf took too long');
    this.name = 'PdfTimeout';
  }
}

export function within<T>(work: Promise<T>, until: number): Promise<T> {
  const left = until - Date.now();
  if (left <= 0) return Promise.reject(new PdfTimeout());
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PdfTimeout()), left);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** null when the deadline passed; any other error is the file's. */
const unlessLate = (err: unknown) => {
  if (err instanceof PdfTimeout) return null;
  throw err;
};

async function pdfText(bytes: Uint8Array): Promise<FileText> {
  pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  const lib = await pdfjs;
  // Text only: no font faces, no system fonts, no XFA forms (pdf.js 6 never evaluates code).
  const task = lib.getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    verbosity: 0,
  });
  const IMAGE_OPS = new Set<number>([lib.OPS.paintImageXObject, lib.OPS.paintInlineImageXObject, lib.OPS.paintImageMaskXObject]);
  try {
    const until = Date.now() + MAX_PDF_MS;
    const doc = await within(task.promise, until).catch(unlessLate);
    if (!doc) return TOO_LARGE;
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    const parts: string[] = [];
    const scannedPages: number[] = [];
    let read = 0;
    for (let n = 1; n <= pages && Date.now() < until; n++) {
      const got = await within(
        doc.getPage(n).then(async (page) => ({ page, content: await page.getTextContent() })),
        until,
      ).catch(unlessLate);
      if (!got) break;
      const { page, content } = got;
      const items = content.items.flatMap((i): PdfItem[] =>
        // Text too small to read is not meant for a reader.
        'str' in i && i.str.trim() && Math.abs(i.transform[3] as number) >= MIN_PDF_FONT
          ? [{ str: i.str, x: i.transform[4] as number, y: i.transform[5] as number, width: i.width, size: Math.abs(i.transform[3] as number) || 10 }]
          : [],
      );
      const text = pageLines(items);
      read = n;
      if (text.replace(/[^\p{L}]/gu, '').length < SCAN_PAGE_LETTERS) {
        const ops = (await within(page.getOperatorList(), until).catch(unlessLate)) ?? { fnArray: [] as number[] };
        if (ops.fnArray.some((fn) => IMAGE_OPS.has(fn))) scannedPages.push(n);
      }
      parts.push(`[Page ${n}]\n${text}`);
    }
    const letters = parts.join('').replace(/\[Page \d+\]/g, '').replace(/\s/g, '').length;
    if (letters < 20 || (scannedPages.length === read && read > 0)) {
      return { text: '', truncated: false, unreadable: 'scanned', pagesTotal: doc.numPages };
    }
    return capped(
      parts.join('\n\n'),
      { pagesRead: read, pagesTotal: doc.numPages, ...(scannedPages.length ? { scannedPages } : {}) },
      doc.numPages > read,
    );
  } finally {
    await task.destroy();
  }
}

/** The text of a file, or why there is none. Never throws. */
export async function extractText(bytes: Uint8Array, name: string, mime: string | null): Promise<FileText> {
  const kind = kindOf(name, mime);
  try {
    switch (kind) {
      case 'text':
        return capped(decodeText(bytes));
      case 'html':
        return capped(htmlText(decodeText(bytes)));
      case 'docx':
        return await docxText(bytes);
      case 'pptx':
        return await pptxText(bytes);
      case 'sheet':
        return await sheetText(bytes);
      case 'pdf':
        return await pdfText(bytes);
      case 'image':
        return { text: '', truncated: false, unreadable: 'scanned' };
      default:
        return { text: '', truncated: false, unreadable: 'type' };
    }
  } catch (err) {
    if (err instanceof ZipTooLarge) return TOO_LARGE;
    const why = err instanceof Error ? `${err.name} ${err.message}` : String(err);
    return { text: '', truncated: false, unreadable: /password|encrypt/i.test(why) ? 'locked' : 'broken' };
  }
}

const STOP_WORDS = new Set(
  'the and for from with this that these those what when where which who whom how are was were will would should could can may have has had not all any our your their its into about please create make give show tell list file document page wiki task tasks draft write add using use der die das und oder für von mit dies diese dieser dieses was wann wer wie ist sind war eine einen einem einer ein aus bitte erstelle datei dokument seite aufgabe aufgaben'.split(' '),
);
/** What a request for tasks, a page or a summary usually needs, wherever the file says it. */
const SIGNALS =
  /(action items?|next steps?|owner|responsible|due\b|deadline|milestone|go-?live|cut-?over|budget|risks?\b|decisions?|decided|agreed|approved|open (points?|questions?|issues?)|requirements?|summary|ma(ß|ss)nahmen?|verantwortlich|f(ä|ae)llig|beschl(u|ü)ss|beschlossen|termine?|frist|meilenstein|risiken|offene punkte|zusammenfassung)/gi;
const DATE = /\b\d{1,2}[./]\s?\d{1,2}[./]\s?\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\.?\s(?:jan|feb|mar|mär|apr|may|mai|jun|jul|aug|sep|oct|okt|nov|dec|dez)[a-zä]*\s\d{4}\b/gi;
const AMOUNT = /\b\d{1,3}(?:[.,]\d{3})+\b|\b\d+\s?(?:eur|€|usd|\$|percent|%)/gi;

const stem = (word: string) => word.toLowerCase().replace(/(ing|ings|es|en|er|s|e)$/u, '');
const wordsOf = (text: string) => text.match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? [];

interface Chunk {
  text: string;
  /** The context a piece of a table needs to be read alone: its sheet and header row. */
  lead: string;
  score: number;
}

const CHUNK_CHARS = 1_500;

/** Blocks of up to CHUNK_CHARS: short paragraphs go together, a new heading, page or sheet starts afresh. */
function blocksOf(text: string): string[] {
  const blocks: string[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const last = blocks.at(-1);
    if (last !== undefined && last.length + block.length + 2 <= CHUNK_CHARS && !/^(#|Sheet |\[Page \d+\]|Slide \d+:|Review comments|Footnotes:)/.test(block) && !last.startsWith('Sheet ')) {
      blocks[blocks.length - 1] = `${last}\n\n${block}`;
    } else blocks.push(block);
  }
  return blocks;
}

/** Splits into blocks, then lines. A sheet's pieces each keep the sheet's name and header row. */
function chunksOf(text: string): Chunk[] {
  const out: Chunk[] = [];
  for (const block of blocksOf(text)) {
    const sheet = /^Sheet [^\n]*:\n[^\n]*\n/.exec(block)?.[0] ?? '';
    let piece = '';
    let first = true;
    const flush = () => {
      if (piece) out.push({ text: piece, lead: first ? '' : sheet, score: 0 });
      piece = '';
      first = false;
    };
    for (const line of block.split('\n')) {
      if (piece && piece.length + line.length + 1 > CHUNK_CHARS) flush();
      // One very long line (a paragraph without breaks) still has to fit.
      for (let at = 0; at < line.length || at === 0; at += CHUNK_CHARS) {
        const part = line.slice(at, at + CHUNK_CHARS);
        if (at > 0) flush();
        piece += piece ? `\n${part}` : part;
      }
    }
    flush();
  }
  return out;
}

/** With several files in play: the file's label every few thousand characters, so no fact loses its file. */
export function labelled(text: string, label: string, every = 2_500): string {
  const parts: string[] = [];
  let run = '';
  for (const block of text.split(/\n{2,}/)) {
    if (!run || run.length >= every) {
      if (run) parts.push(run);
      run = `[${label}]\n${block}`;
    } else run += `\n\n${block}`;
  }
  if (run) parts.push(run);
  return parts.join('\n\n');
}

const MATCHING_ROWS = 60;

/**
 * The rows of big sheets that hold a word of the request ("which items are blocked?"): picking six
 * rows out of 600 is what a model gets wrong and a filter gets right. They come first, the sheet
 * stays below them. A word in many rows picks nothing.
 */
export function matchingRows(text: string, request: string): string {
  const terms = [...new Set(wordsOf(request).map((w) => w.toLowerCase()).filter((w) => !STOP_WORDS.has(w)).map(stem))].filter((t) => t.length >= 4);
  if (!terms.length) return '';
  const found: string[] = [];
  for (const block of text.split(/\n{2,}/)) {
    if (!block.startsWith('Sheet ')) continue;
    const [name, header, ...rows] = block.split('\n');
    if (rows.length < 30) continue;
    for (const term of terms) {
      const hits = rows.filter((r) => wordsOf(r).some((w) => stem(w) === term));
      if (hits.length && hits.length <= MATCHING_ROWS && hits.length <= rows.length / 4) {
        found.push(`Every row of sheet ${name.slice(6, -1)} with "${term}" (${hits.length} of ${rows.length}):\n${header}\n${hits.join('\n')}`);
      }
    }
  }
  return found.join('\n\n');
}

/**
 * What to read of a long file, within `budget` characters: the start of the document and then the
 * pieces closest to the request and to what requests usually need (actions, owners, dates, budget,
 * decisions), in document order, with a marker for what was skipped. Without a word from the
 * request it still finds these. A file that fits comes back whole.
 */
export function selectRelevant(
  text: string,
  request: string,
  budget: number,
): { text: string; truncated: boolean; readPercent?: number } {
  const rows = matchingRows(text, request);
  if (!rows || rows.length > budget / 2) return pieces(text, request, budget);
  // A file that fits stays whole: the few rows repeated on top are not worth cutting it for.
  if (text.length <= budget) return { text: `${rows}\n\n${text}`, truncated: false };
  const rest = pieces(text, request, budget - rows.length - 2);
  return { ...rest, text: `${rows}\n\n${rest.text}` };
}

function pieces(text: string, request: string, budget: number): { text: string; truncated: boolean; readPercent?: number } {
  if (text.length <= budget) return { text, truncated: false };
  if (budget <= 0) return { text: '', truncated: true, readPercent: 0 };
  const terms = [...new Set(wordsOf(request).map((w) => w.toLowerCase()).filter((w) => !STOP_WORDS.has(w)).map(stem))].filter((t) => t.length >= 3);
  const chunks = chunksOf(text);
  const base = chunks.map((c) => {
    const words = wordsOf(c.text).map(stem);
    const hits = terms.reduce((n, t) => n + (words.some((w) => w === t || w.startsWith(t)) ? 1 : 0), 0);
    const repeats = terms.reduce((n, t) => n + Math.min(3, words.filter((w) => w === t).length), 0);
    const signals = new Set((c.text.match(SIGNALS) ?? []).map((s) => s.toLowerCase())).size;
    const heading = /^(#|\d+(\.\d+)*\.?\s|\[Page \d+\]\n\d+\.)/m.test(c.text) && terms.some((t) => c.text.split('\n', 2).join(' ').toLowerCase().includes(t)) ? 5 : 0;
    const comments = c.text.startsWith('Review comments') ? 6 : 0;
    return hits * 4 + repeats + Math.min(4, signals) * 3 + Math.min(4, c.text.match(DATE)?.length ?? 0) + Math.min(3, c.text.match(AMOUNT)?.length ?? 0) + heading + comments;
  });
  // What stands next to a good piece is often the rest of the same section or table.
  chunks.forEach((c, i) => {
    c.score = base[i] + 0.3 * Math.max(base[i - 1] ?? 0, base[i + 1] ?? 0);
  });
  chunks[0].score = Number.MAX_SAFE_INTEGER;
  const size = (c: Chunk) => c.lead.length + c.text.length + 2;
  const order = chunks.map((_, i) => i).sort((a, b) => chunks[b].score - chunks[a].score || a - b);
  const picked = new Set<number>();
  // Room for the markers between the pieces.
  let left = budget - 200;
  for (const i of order) {
    if (size(chunks[i]) + 40 > left) continue;
    picked.add(i);
    left -= size(chunks[i]) + 40;
  }
  if (!picked.size) return { text: text.slice(0, budget), truncated: true, readPercent: Math.round((budget / text.length) * 100) };
  const parts: string[] = [];
  let kept = 0;
  let skipped = 0;
  chunks.forEach((c, i) => {
    if (!picked.has(i)) {
      skipped += c.text.length;
      return;
    }
    if (skipped) parts.push(`[... about ${skipped} characters not read ...]`);
    skipped = 0;
    parts.push(c.lead + c.text);
    kept += c.text.length;
  });
  if (skipped) parts.push(`[... about ${skipped} characters not read ...]`);
  return { text: parts.join('\n\n'), truncated: true, readPercent: Math.min(99, Math.round((kept / text.length) * 100)) };
}
