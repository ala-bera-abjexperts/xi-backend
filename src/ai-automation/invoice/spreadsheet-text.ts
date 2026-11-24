/**
 * @fileoverview Turns a document the providers cannot read into text. A spreadsheet or a JSON file
 * is rejected by every provider ("Invalid MIME type. Only image types are supported"), so its
 * content is sent as text inside the prompt instead of as an attached file.
 */
import * as XLSX from 'xlsx';

const LABEL = 'AI Invoice Extraction';

const SHEET_EXTENSIONS = new Set(['csv', 'tsv', 'xls', 'xlsx', 'xlsm', 'ods']);
const TEXT_EXTENSIONS = new Set(['json', 'txt', 'xml', 'html', 'htm', 'md']);

const SHEET_MIME_PARTS = ['spreadsheet', 'excel', 'csv', 'tab-separated'];
const TEXT_MIME_PARTS = ['json', 'text/plain', 'xml', 'html'];

// A whole workbook can dwarf the model's input budget; an invoice never needs more than this.
const MAX_TEXT_CHARS = 60_000;

function extensionOf(fileName: string): string {
  return fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
}

/** Strips the UTF-8 BOM Excel writes, which otherwise corrupts the first header. */
function withoutBom(bytes: Buffer): Buffer {
  const hasBom =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf;

  return hasBom ? bytes.subarray(3) : bytes;
}

/** True for anything whose content has to travel as text rather than as a file. */
export function isTextDocument(mimeType: string, fileName: string): boolean {
  const extension = extensionOf(fileName);

  if (SHEET_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(extension))
    return true;

  const type = mimeType.toLowerCase();

  return [...SHEET_MIME_PARTS, ...TEXT_MIME_PARTS].some((part) =>
    type.includes(part),
  );
}

function isSheet(mimeType: string, fileName: string): boolean {
  const type = mimeType.toLowerCase();

  return (
    SHEET_EXTENSIONS.has(extensionOf(fileName)) ||
    SHEET_MIME_PARTS.some((part) => type.includes(part))
  );
}

function cap(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated: the file is larger than ${MAX_TEXT_CHARS} characters]`
    : text;
}

/** The document's content as text. Throws `(422)` when there is nothing readable in it. */
export function documentToText(
  bytes: Buffer,
  fileName: string,
  mimeType: string,
): string {
  const clean = withoutBom(bytes);

  if (!isSheet(mimeType, fileName)) {
    const raw = clean.toString('utf8').trim();

    if (!raw) throw new Error(`(422) ${LABEL}: ${fileName} is empty.`);

    // Pretty-print JSON so the model reads a structure rather than one long line.
    try {
      return cap(JSON.stringify(JSON.parse(raw), null, 2));
    } catch {
      return cap(raw);
    }
  }

  let book: XLSX.WorkBook;

  try {
    // The reader decodes a CSV as cp1252 unless told otherwise, which mangles every accented header.
    book = XLSX.read(clean, {
      type: 'buffer',
      codepage: 65001,
      raw: false,
      cellDates: true,
    });
  } catch (err) {
    throw new Error(
      `(422) ${LABEL}: ${fileName} could not be read as a spreadsheet (${err instanceof Error ? err.message : 'unknown error'}).`,
    );
  }

  const sheets = book.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(book.Sheets[name], {
      blankrows: false,
    });

    return csv.trim() ? `--- Sheet: ${name} ---\n${csv.trim()}` : '';
  }).filter(Boolean);

  const text = sheets.join('\n\n');

  if (!text) throw new Error(`(422) ${LABEL}: ${fileName} contains no rows.`);

  return cap(text);
}
