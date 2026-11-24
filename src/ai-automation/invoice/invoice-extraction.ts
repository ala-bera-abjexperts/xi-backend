/**
 * @fileoverview Pure half of AI Invoice Extraction: file checks, the prompt, the AI schema, and the
 * normalisation of the AI answer into the flat output later automation tasks read.
 */
import { z } from 'zod';

import type { JsonSchema } from '../tenant-ai.service';

const LABEL = 'AI Invoice Extraction';

export const MAX_INVOICE_BYTES = 20 * 1024 * 1024;

// Inline data is base64 (+33 %) inside Gemini's 20 MB request limit.
const GOOGLE_INLINE_MAX_BYTES = 14 * 1024 * 1024;

const MAX_POSITIONS = 500;

// Used only when the bytes carry no signature this module recognises, so the file is still passed on
// with its most likely type instead of being refused.
const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
};

const EMPTY_TEXT = new Set(['', 'n/a', '-', '--', 'null', 'unknown', 'none']);

// Human wording for the five required fields, used to explain why an invoice is invalid.
const REQUIRED_LABELS: Record<string, string> = {
  invoiceNumber: 'invoice number',
  invoiceDate: 'invoice date',
  companyFrom: 'company from',
  invoiceToCompany: 'invoice to company',
  invoiceTotal: 'total',
};

const CURRENCY_SYMBOLS: Array<[RegExp, string]> = [
  [/€/, 'EUR'],
  [/£/, 'GBP'],
  [/¥/, 'JPY'],
  [/₹/, 'INR'],
  [/US\$/i, 'USD'],
  [/CA?\$/i, 'CAD'],
  [/AU?\$/i, 'AUD'],
  [/^(chf|fr\.?|sfr\.?)$/i, 'CHF'],
  [/^euros?$/i, 'EUR'],
];

const ISO_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

// Not every provider enforces the schema, so a key can come back as InvoiceNumber or invoice_number.
// Matching case- and separator-insensitively keeps a well-read invoice from reporting missing fields.
const AI_KEYS = [
  'isInvoice',
  'invoiceCount',
  'notInvoiceReason',
  'invoiceNumber',
  'invoiceDate',
  'invoiceDateText',
  'companyFrom',
  'invoiceToCompany',
  'currency',
  'subtotal',
  'taxTotal',
  'total',
  'taxLines',
  'positions',
  'notes',
  'position',
  'description',
  'quantity',
  'unitPrice',
  'totalPrice',
  'rate',
  'amount',
];

const AI_KEY_BY_NORMAL = new Map(
  AI_KEYS.map((key) => [key.toLowerCase(), key] as const),
);

/** Maps the answer's keys onto the expected names; unknown keys are passed through untouched. */
export function canonicaliseAiKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicaliseAiKeys);
  if (typeof value !== 'object' || value === null) return value;

  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    const normal = key.replace(/[\s_-]/g, '').toLowerCase();
    const canonical = AI_KEY_BY_NORMAL.get(normal) ?? key;
    const mapped = canonicaliseAiKeys(entry);

    // A value already read from a correctly-named key wins over a stray variant.
    if (result[canonical] === undefined || result[canonical] === null) {
      result[canonical] = mapped;
    }
  }

  return result;
}

// Some models send a nested list as JSON text.
function parseJsonList(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export const INVOICE_SYSTEM_PROMPT = `You are an expert accounts-payable clerk who extracts data from invoices with perfect accuracy.
You receive one document: a PDF with one or more pages, or an image / scan. Read EVERY page before answering.

Rules:
- Count first: how many SEPARATE invoices does this document contain? Put that number in invoiceCount — 0 when it is not an invoice at all (then isInvoice=false too), 1 for a normal invoice, N when the file holds N invoices, for example a batch export or a scanned stack. ONE invoice that runs over several pages is still 1, NEVER one per page. A new invoice number with its own totals starts a new invoice; a continued line-item table, a duplicate copy ("Kopie", "Zweitschrift"), an attached timesheet, a credit note belonging to the same invoice and a payment slip do NOT.
- Put EVERY invoice in the invoices array, in page order — one entry even when the document holds only a single invoice. Fill each entry completely from that invoice alone and NEVER mix values from two invoices into one entry. Also fill the top-level fields from the FIRST invoice, so invoices[0] and the top-level fields describe the same invoice.
- An invoice that is incomplete, inconsistent or marked invalid IS STILL AN INVOICE: include it in invoices and in invoiceCount, and leave the fields you cannot read as null. Judging correctness is not your job. Set isInvoice=false ONLY when the document contains no invoice whatsoever (a delivery note, a quote, a report); never because some of the invoices look wrong.
- First decide whether the document is an invoice. Invoices, credit notes, bills and receipts that name a seller, a buyer or payer, and an amount due or paid ARE invoices. Quotes / offers, purchase orders, order confirmations, delivery notes, account statements, contracts and payment reminders without an invoice of their own are NOT invoices: set isInvoice=false, explain why in notInvoiceReason, and leave every other field null or empty.
- NEVER invent, guess or calculate a value that is not printed on the document. When a value is missing or unreadable, use null.
- invoiceNumber: the invoice / document number exactly as printed.
- invoiceDate: the issue date as ISO YYYY-MM-DD, only when day and month are unambiguous; otherwise null. Always copy the date exactly as printed into invoiceDateText.
- companyFrom: the name of the seller / issuer. invoiceToCompany: the name of the billed customer (the company, or the person when there is no company). Names only, no addresses.
- Numbers: plain JSON numbers with "." as the decimal separator, without thousands separators or currency symbols (convert "1.234,56" to 1234.56 and "1'234.50" to 1234.5). Amounts in parentheses or with a trailing minus are negative.
- currency: the ISO 4217 code (EUR, USD, GBP, CHF, ...). Use USD for "$" only when nothing else (country, address, currency text) points to another dollar currency.
- total: the gross amount due, including tax. For a credit note, total and the positions are negative.
- subtotal: the net amount before tax. taxTotal: the sum of all tax amounts. taxLines: one entry per tax rate with the rate in percent and its amount.
- positions: every line item in document order, across ALL pages. When a table continues on the next page, continue the same list: do not repeat the table header, and skip "carried forward" / "Übertrag", page subtotal and repeated header rows. Never duplicate a row because of a page break, but keep lines that are genuinely repeated on the invoice.
- Discounts, rebates and credits shown as lines are positions with a negative totalPrice. Tax / VAT / GST / sales-tax lines are NOT positions (put them in taxTotal and taxLines). Shipping and fees are positions.
- position: the line number as printed, or null. quantity, unitPrice, totalPrice: as printed on that line.
- notes: short remarks that matter for booking (payment terms, due date, order reference), or null.
- For scans and photos read the text carefully; use null for anything you cannot read with certainty.`;

export const INVOICE_USER_PROMPT =
  'Extract the invoice data from the attached document and record it using the required schema. Read every page. Count the separate invoices first and put that number in invoiceCount.';

const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };

/**
 * The node's "Maximum invoices" setting. Empty means no limit of ours — every invoice is read.
 * The model's own answer-size limit still applies and surfaces as the "answer was cut off" error.
 */
export function resolveMaxInvoices(configured: unknown): number {
  const value = parseAmount(configured, 0);

  if (value === null || value < 1) return Number.POSITIVE_INFINITY;

  return value;
}

/**
 * Prompt line for a set maximum: the model lists only the invoices that will be kept (cheaper, and a
 * 100-invoice file no longer hits the answer-size limit) but still counts them all for the warning.
 */
export function maxInvoicesInstruction(configured: unknown): string {
  const max = resolveMaxInvoices(configured);

  if (!Number.isFinite(max)) return '';

  return `\n\nThis step keeps at most ${countInvoices(max)}. Put ONLY the first ${max} invoice(s), in page order, in the invoices array, but still count EVERY invoice in the document in invoiceCount.`;
}

const countInvoices = (count: number) =>
  `${count} invoice${count === 1 ? '' : 's'}`;

// One invoice's fields, shared by the top-level answer and by each entry of `invoices`.
const INVOICE_FIELDS: Record<string, JsonSchema> = {
  invoiceNumber: nullableString,
  invoiceDate: { ...nullableString, description: 'ISO YYYY-MM-DD' },
  invoiceDateText: nullableString,
  companyFrom: nullableString,
  invoiceToCompany: nullableString,
  currency: { ...nullableString, description: 'ISO 4217 code' },
  subtotal: nullableNumber,
  taxTotal: nullableNumber,
  total: nullableNumber,
  taxLines: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['rate', 'amount'],
      properties: { rate: nullableNumber, amount: nullableNumber },
    },
  },
  positions: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: [
        'position',
        'description',
        'quantity',
        'unitPrice',
        'totalPrice',
      ],
      properties: {
        position: nullableString,
        description: nullableString,
        quantity: nullableNumber,
        unitPrice: nullableNumber,
        totalPrice: nullableNumber,
      },
    },
  },
  notes: nullableString,
};

// Strict-mode compatible (OpenAI): every property required, no extra keys, nulls via type unions.
export const INVOICE_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'isInvoice',
    'invoiceCount',
    'notInvoiceReason',
    'invoiceNumber',
    'invoiceDate',
    'invoiceDateText',
    'companyFrom',
    'invoiceToCompany',
    'currency',
    'subtotal',
    'taxTotal',
    'total',
    'taxLines',
    'positions',
    'notes',
    'invoices',
  ],
  properties: {
    isInvoice: { type: 'boolean' },

    // How the model says "there is more than one invoice here"; this schema can carry only one.
    // Integer + description on purpose: toGeminiSchema drops `enum`.
    invoiceCount: {
      type: ['integer', 'null'],
      description:
        'How many SEPARATE invoices this document contains. 0 = not an invoice, 1 = one invoice (also when it runs over several pages), N = the file holds N invoices, e.g. a batch export or a scanned stack.',
    },
    notInvoiceReason: nullableString,
    invoiceNumber: nullableString,
    invoiceDate: { ...nullableString, description: 'ISO YYYY-MM-DD' },
    invoiceDateText: nullableString,
    companyFrom: nullableString,
    invoiceToCompany: nullableString,
    currency: { ...nullableString, description: 'ISO 4217 code' },
    subtotal: nullableNumber,
    taxTotal: nullableNumber,
    total: nullableNumber,
    taxLines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rate', 'amount'],
        properties: { rate: nullableNumber, amount: nullableNumber },
      },
    },
    positions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'position',
          'description',
          'quantity',
          'unitPrice',
          'totalPrice',
        ],
        properties: {
          position: nullableString,
          description: nullableString,
          quantity: nullableNumber,
          unitPrice: nullableNumber,
          totalPrice: nullableNumber,
        },
      },
    },
    notes: nullableString,

    // EVERY invoice in the document, one entry even for a single-invoice file. The top-level fields
    // above stay filled from the first entry, so anything reading them keeps working unchanged.
    invoices: {
      type: 'array',
      description:
        'Every separate invoice in this document, in page order. One entry for a single-invoice file.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: Object.keys(INVOICE_FIELDS),
        properties: INVOICE_FIELDS,
      },
    },
  },
};

// Lenient on purpose: a wrong type in one field becomes null instead of rejecting the whole answer.
const looseText = z.union([z.string(), z.number()]).nullish().catch(null);
const looseNumber = z.union([z.number(), z.string()]).nullish().catch(null);

const aiPositionSchema = z.object({
  position: looseText,
  description: looseText,
  quantity: looseNumber,
  unitPrice: looseNumber,
  totalPrice: looseNumber,
});

// One entry of `invoices`; same fields as the top-level answer, without the document-level flags.
const aiInvoiceSchema = z.object({
  invoiceNumber: looseText,
  invoiceDate: looseText,
  invoiceDateText: looseText,
  companyFrom: looseText,
  invoiceToCompany: looseText,
  currency: looseText,
  subtotal: looseNumber,
  taxTotal: looseNumber,
  total: looseNumber,
  taxLines: z
    .preprocess(
      parseJsonList,
      z
        .array(
          z
            .object({ rate: looseNumber, amount: looseNumber })
            .nullable()
            .catch(null),
        )
        .nullish(),
    )
    .catch(null),
  positions: z
    .preprocess(
      parseJsonList,
      z.array(aiPositionSchema.nullable().catch(null)).nullish(),
    )
    .catch(null),
  notes: looseText,
});

type AiInvoice = z.infer<typeof aiInvoiceSchema>;

const aiResultSchema = z.object({
  isInvoice: z.union([z.boolean(), z.string()]).nullish().catch(null),
  invoiceCount: looseNumber,
  notInvoiceReason: looseText,
  invoiceNumber: looseText,
  invoiceDate: looseText,
  invoiceDateText: looseText,
  companyFrom: looseText,
  invoiceToCompany: looseText,
  currency: looseText,
  subtotal: looseNumber,
  taxTotal: looseNumber,
  total: looseNumber,
  taxLines: z
    .preprocess(
      parseJsonList,
      z
        .array(
          z
            .object({ rate: looseNumber, amount: looseNumber })
            .nullable()
            .catch(null),
        )
        .nullish(),
    )
    .catch(null),
  positions: z
    .preprocess(
      parseJsonList,
      z.array(aiPositionSchema.nullable().catch(null)).nullish(),
    )
    .catch(null),
  notes: looseText,
  invoices: z
    .preprocess(
      parseJsonList,
      z.array(aiInvoiceSchema.nullable().catch(null)).nullish(),
    )
    .catch(null),
});

export interface InvoicePosition {
  position: number | null;
  description: string | null;
  quantity: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
}

/** One invoice read from the document, in the structure a reader expects. */
export interface InvoiceRecord {
  invoiceNumber: string | null;
  invoiceDate: string | null;
  companyFrom: string | null;
  invoiceToCompany: string | null;
  invoiceTotal: number | null;
  currency: string | null;
  subtotal: number | null;
  taxTotal: number | null;
  positions: InvoicePosition[];
  positionCount: number;
  positionsText: string;
  isValid: boolean;
  missingFields: string[];
  invalidReasons: string[];
  warnings: string[];
}

export interface InvoiceOutput {
  status: 'extracted' | 'incomplete' | 'not_invoice';
  isValidInvoice: boolean;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  companyFrom: string | null;
  invoiceToCompany: string | null;
  invoiceTotal: number | null;
  currency: string | null;
  subtotal: number | null;
  taxTotal: number | null;
  positions: InvoicePosition[];
  positionCount: number;
  positionsText: string;
  missingFields: string[];

  // Optional so the legacy not_invoice branch below still type-checks; every live path sets them.
  invalidReasons?: string[];
  invoiceCount?: number;
  invoices?: InvoiceRecord[];
  warnings: string[];
  reason: string | null;
  attachmentId: string;
  attachmentName: string;
  provider: string;
  model: string;
}

export interface InvoiceSource {
  attachmentId: string;
  attachmentName: string;
  provider: string;
  model: string;
}

function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** Size limits; `provider` adds Gemini's lower inline limit. */
export function checkInvoiceFileSize(
  size: number,
  name: string,
  provider?: string,
): void {
  if (size > MAX_INVOICE_BYTES) {
    throw new Error(
      `(413) ${LABEL}: ${name} is ${megabytes(size)} MB — the limit is 20 MB.`,
    );
  }

  if (provider === 'google' && size > GOOGLE_INLINE_MAX_BYTES) {
    throw new Error(
      `(413) ${LABEL}: ${name} is ${megabytes(size)} MB — Google Gemini accepts up to ~14 MB inline.`,
    );
  }
}

/** Gemini's inline data has no GIF support, so refuse it before the paid call. */
export function checkProviderFileType(
  mimeType: string,
  name: string,
  provider: string,
): void {
  if (provider === 'google' && mimeType === 'image/gif') {
    throw new Error(
      `(415) ${LABEL}: ${name} is a GIF — Google Gemini cannot read GIF images; use PDF, PNG, JPEG or WEBP.`,
    );
  }
}

/** The real type from the file's bytes; the stored mime/extension only shapes the error. */
export function detectInvoiceFileType(
  bytes: Buffer,
  name: string,
  storedMime: string | null,
): string {
  if (bytes.length === 0) {
    throw new Error(`(422) ${LABEL}: ${name} is empty (0 bytes).`);
  }

  checkInvoiceFileSize(bytes.length, name);

  const head = bytes.subarray(0, 12).toString('latin1');

  // PDF readers accept up to 1 KB of junk before the header.
  if (bytes.subarray(0, 1024).includes('%PDF')) return 'application/pdf';
  if (head.startsWith('\x89PNG')) return 'image/png';
  if (head.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (head.startsWith('GIF8')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP')
    return 'image/webp';

  const extension = name.includes('.')
    ? name.split('.').pop()!.toLowerCase()
    : '';

  if (extension === 'pdf' || storedMime === 'application/pdf') {
    throw new Error(
      `(422) ${LABEL}: ${name} is damaged or not a real PDF (no PDF header found).`,
    );
  }

  // Every other type is passed through as attached: the provider decides what it can read, rather
  // than this guard deciding for it. The empty, size and damaged-PDF checks above still apply.
  return (
    EXTENSION_TYPES[extension] ??
    (storedMime && storedMime !== 'application/octet-stream'
      ? storedMime
      : 'application/octet-stream')
  );
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;

  return (Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor;
}

/** A printed amount as a number: "1.234,56", "1'234.50", "(12,00)", "12.00-", "€ 5" … */
export function parseAmount(value: unknown, decimals = 2): number | null {
  if (typeof value === 'number')
    return Number.isFinite(value) ? round(value, decimals) : null;
  if (typeof value !== 'string') return null;

  // Unicode minus and dashes count as a minus sign.
  let text = value.trim().replace(/[\u2212\u2013\u2014]/g, '-');
  let negative = false;

  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }

  if (/-\s*$/.test(text) || /^[^\d]*-/.test(text)) negative = true;

  const digits = text.replace(/[^\d.,]/g, '');

  if (!/\d/.test(digits)) return null;

  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');
  const lastSeparator = Math.max(lastDot, lastComma);
  let normalised = digits.replace(/[.,]/g, '');

  if (lastSeparator >= 0) {
    const separator = digits[lastSeparator];
    const intPart = digits.slice(0, lastSeparator).replace(/[.,]/g, '');
    const fraction = digits.slice(lastSeparator + 1);
    const usedOnce = digits.split(separator).length === 2;
    const bothUsed = lastDot >= 0 && lastComma >= 0;

    // "1.234" / "1,234" read as thousands; "0.125", "12,5" and "1.2345" as decimals.
    const isDecimal =
      bothUsed ||
      (usedOnce &&
        (fraction.length !== 3 || intPart === '' || /^0+$/.test(intPart)));

    if (isDecimal) normalised = `${intPart || '0'}.${fraction}`;
  }

  const amount = Number(normalised);

  if (!Number.isFinite(amount)) return null;

  return round(negative ? -amount : amount, decimals);
}

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isoDate(year: number, month: number, day: number): string | null {
  if (!isRealDate(year, month, day)) return null;

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** ISO, D.M.Y, Y/M/D, and D/M/Y or M/D/Y only when the day is > 12 and so cannot be swapped. */
export function parseDate(value: unknown): {
  date: string | null;
  ambiguous: boolean;
} {
  const text = typeof value === 'string' ? value.trim() : '';
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/);

  if (match) {
    return {
      date: isoDate(Number(match[1]), Number(match[2]), Number(match[3])),
      ambiguous: false,
    };
  }

  match = text.match(/^(\d{1,2})([./-])(\d{1,2})\2(\d{4})$/);

  if (!match) return { date: null, ambiguous: false };

  const first = Number(match[1]);
  const second = Number(match[3]);
  const year = Number(match[4]);

  // A dotted date is always day.month.year.
  if (match[2] === '.' || first > 12) {
    return { date: isoDate(year, second, first), ambiguous: false };
  }

  if (second > 12 || first === second)
    return { date: isoDate(year, first, second), ambiguous: false };

  return { date: null, ambiguous: true };
}

/** ISO 4217 code from a code or symbol; a bare "$" is USD only as an assumption. */
export function normaliseCurrency(value: unknown): {
  code: string | null;
  assumed: boolean;
} {
  const text = cleanText(value);

  if (!text) return { code: null, assumed: false };

  const code = [...text.toUpperCase().matchAll(/\b[A-Z]{3}\b/g)]
    .map((match) => match[0])
    .find((word) => ISO_CURRENCIES.has(word));

  if (code) return { code, assumed: false };

  for (const [pattern, iso] of CURRENCY_SYMBOLS) {
    if (pattern.test(text)) return { code: iso, assumed: false };
  }

  if (text.includes('$')) return { code: 'USD', assumed: true };

  return { code: null, assumed: false };
}

/** Trimmed text, or null for "", "N/A", "-", "null", "unknown" and friends. */
export function cleanText(value: unknown): string | null {
  const text =
    typeof value === 'string'
      ? value.replace(/\s+/g, ' ').trim()
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : '';

  return EMPTY_TEXT.has(text.toLowerCase()) ? null : text;
}

function positionNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;

  const text = typeof value === 'string' ? value.trim() : '';

  return /^\d+\.?$/.test(text) ? Number(text.replace('.', '')) : null;
}

function isNotInvoice(value: unknown): boolean {
  return (
    value === false ||
    (typeof value === 'string' && /^(false|no)$/i.test(value.trim()))
  );
}

function positionLine(p: InvoicePosition, currency: string | null): string {
  const head = [p.position !== null ? `${p.position}.` : null, p.description]
    .filter((part) => part !== null)
    .join(' ');
  // "q × price = total" only when both factors are known.
  let amounts =
    p.quantity !== null && p.unitPrice !== null
      ? `${p.quantity} × ${p.unitPrice}`
      : [
          p.quantity !== null ? `qty ${p.quantity}` : null,
          p.unitPrice !== null ? `unit price ${p.unitPrice}` : null,
        ]
          .filter((part) => part !== null)
          .join(', ');

  if (p.totalPrice !== null)
    amounts = !amounts
      ? `${p.totalPrice}`
      : p.quantity !== null && p.unitPrice !== null
        ? `${amounts} = ${p.totalPrice}`
        : `${amounts}, total ${p.totalPrice}`;
  if (amounts && currency) amounts = `${amounts} ${currency}`;

  return [head, amounts].filter(Boolean).join(' — ');
}

function sum(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);

  return present.length > 0
    ? round(
        present.reduce((a, b) => a + b, 0),
        2,
      )
    : null;
}

function crossCheck(
  subtotal: number | null,
  taxTotal: number | null,
  total: number | null,
  positions: InvoicePosition[],
  taxLineAmounts: Array<number | null>,
): string[] {
  const warnings: string[] = [];
  const positionsSum = sum(positions.map((p) => p.totalPrice));
  const taxLinesSum = sum(taxLineAmounts);

  // Per-line rounding on long invoices can add up to a few cents.
  const tolerance = Math.max(0.05, positions.length * 0.01);

  if (positionsSum !== null) {
    const references = [
      subtotal,
      total,
      total !== null && taxTotal !== null ? round(total - taxTotal, 2) : null,
    ].filter((v): v is number => v !== null);

    if (
      references.length > 0 &&
      !references.some((ref) => Math.abs(ref - positionsSum) <= tolerance)
    ) {
      warnings.push(
        `The positions add up to ${positionsSum}, which matches neither the subtotal (${subtotal ?? 'none'}) nor the total (${total ?? 'none'}).`,
      );
    }
  }

  if (taxLinesSum !== null && taxTotal !== null) {
    if (Math.abs(taxLinesSum - taxTotal) > 0.05) {
      warnings.push(
        `The tax lines add up to ${taxLinesSum}, but the tax total is ${taxTotal}.`,
      );
    }
  }

  if (subtotal !== null && taxTotal !== null && total !== null) {
    if (Math.abs(round(subtotal + taxTotal, 2) - total) > 0.05) {
      warnings.push(
        `Subtotal ${subtotal} plus tax ${taxTotal} does not equal the total ${total}.`,
      );
    }
  }

  return warnings;
}

/** One invoice's fields → a record. Uses the same helpers as the single-invoice path below. */
export function buildInvoiceRecord(ai: AiInvoice): InvoiceRecord {
  const warnings: string[] = [];
  const invoiceNumber = cleanText(ai.invoiceNumber);
  const companyFrom = cleanText(ai.companyFrom);
  const invoiceToCompany = cleanText(ai.invoiceToCompany);
  const invoiceTotal = parseAmount(ai.total);
  const subtotal = parseAmount(ai.subtotal);
  const taxTotal = parseAmount(ai.taxTotal);
  const currency = normaliseCurrency(ai.currency);
  const fromIso = parseDate(ai.invoiceDate);
  const fromText = fromIso.date ? fromIso : parseDate(ai.invoiceDateText);
  const invoiceDate = fromIso.date ?? fromText.date;
  const printedDate =
    cleanText(ai.invoiceDateText) ?? cleanText(ai.invoiceDate);

  if (!invoiceDate && printedDate) {
    warnings.push(
      fromIso.ambiguous || fromText.ambiguous
        ? `The invoice date "${printedDate}" is ambiguous (day and month could be swapped) — left empty.`
        : `The invoice date "${printedDate}" could not be converted to a date — left empty.`,
    );
  }

  if (currency.assumed)
    warnings.push('The currency is printed only as "$" — assumed USD.');

  let positions = (ai.positions ?? [])
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map(
      (p): InvoicePosition => ({
        position: positionNumber(p.position),
        description: cleanText(p.description),
        quantity: parseAmount(p.quantity, 4),
        unitPrice: parseAmount(p.unitPrice, 4),
        totalPrice: parseAmount(p.totalPrice, 2),
      }),
    )
    .filter(
      (p) =>
        p.description !== null ||
        p.quantity !== null ||
        p.unitPrice !== null ||
        p.totalPrice !== null,
    );

  if (positions.length > MAX_POSITIONS) {
    warnings.push(
      `The invoice has ${positions.length} positions — only the first ${MAX_POSITIONS} are kept.`,
    );
    positions = positions.slice(0, MAX_POSITIONS);
  }

  const taxLineAmounts = (ai.taxLines ?? []).map((line) =>
    line ? parseAmount(line.amount) : null,
  );

  warnings.push(
    ...crossCheck(subtotal, taxTotal, invoiceTotal, positions, taxLineAmounts),
  );

  const missingFields = (
    [
      ['invoiceNumber', invoiceNumber],
      ['invoiceDate', invoiceDate],
      ['companyFrom', companyFrom],
      ['invoiceToCompany', invoiceToCompany],
      ['invoiceTotal', invoiceTotal],
    ] as Array<[string, unknown]>
  )
    .filter(([, value]) => value === null)
    .map(([field]) => field);

  return {
    invoiceNumber,
    invoiceDate,
    companyFrom,
    invoiceToCompany,
    invoiceTotal,
    currency: currency.code,
    subtotal,
    taxTotal,
    positions,
    positionCount: positions.length,
    positionsText: positions
      .map((p) => positionLine(p, currency.code))
      .join('\n'),
    isValid: missingFields.length === 0,
    missingFields,
    invalidReasons: missingFields.map(
      (field) =>
        `The ${REQUIRED_LABELS[field] ?? field} is missing on the document.`,
    ),
    warnings,
  };
}

/** The AI answer → the step output. Throws only when the answer is unusable. */
export function buildInvoiceOutput(
  raw: unknown,
  source: InvoiceSource,
  configuredMaxInvoices?: unknown,
): InvoiceOutput {
  const parsed = aiResultSchema.safeParse(canonicaliseAiKeys(raw));
  console.log('parsed ', parsed);

  if (!parsed.success) {
    throw new Error(
      `(422) ${LABEL}: the answer did not match the expected invoice structure.`,
    );
  }

  const ai = parsed.data;

  // parseAmount, not Number(): Number(null) is 0, which would read a missing count as "not an invoice".
  const invoiceCount = parseAmount(ai.invoiceCount, 0);
  console.log('Invoice Count:', invoiceCount);

  // Runs before the original branch below, which stays for output rows recorded before this guard.
  // Only when the answer carries NO invoice at all: a model that lists invoices and still says
  // isInvoice=false is contradicting itself, and the listed invoices are what the user asked for.
  const listedAny = (ai.invoices ?? []).some((entry) => entry !== null);

  // Listed invoices win over a contradictory flag, which also keeps the legacy branch below unreachable.
  if (listedAny) ai.isInvoice = true;

  if (isNotInvoice(ai.isInvoice) && !listedAny) {
    const why = cleanText(ai.notInvoiceReason);

    throw new Error(
      `(422) ${LABEL}: ${source.attachmentName} is not an invoice${why ? ` — ${why.slice(0, 200)}` : '.'}`,
    );
  }

  if (isNotInvoice(ai.isInvoice)) {
    return {
      status: 'not_invoice',
      isValidInvoice: false,
      invoiceNumber: null,
      invoiceDate: null,
      companyFrom: null,
      invoiceToCompany: null,
      invoiceTotal: null,
      currency: null,
      subtotal: null,
      taxTotal: null,
      positions: [],
      positionCount: 0,
      positionsText: '',
      missingFields: [],
      warnings: [],
      reason:
        cleanText(ai.notInvoiceReason) ?? 'The document is not an invoice.',
      ...source,
    };
  }

  // The answer may carry the data only in `invoices`. The top level has to mirror the first entry,
  // so fill whatever it left empty BEFORE the checks below read those fields — including the
  // "no invoice data was found" guard, which would otherwise reject a perfectly good answer.
  const firstInvoice = (ai.invoices ?? []).find((entry) => entry !== null);

  if (firstInvoice) {
    ai.invoiceNumber ??= firstInvoice.invoiceNumber;
    ai.invoiceDate ??= firstInvoice.invoiceDate;
    ai.invoiceDateText ??= firstInvoice.invoiceDateText;
    ai.companyFrom ??= firstInvoice.companyFrom;
    ai.invoiceToCompany ??= firstInvoice.invoiceToCompany;
    ai.currency ??= firstInvoice.currency;
    ai.subtotal ??= firstInvoice.subtotal;
    ai.taxTotal ??= firstInvoice.taxTotal;
    ai.total ??= firstInvoice.total;
    ai.notes ??= firstInvoice.notes;

    if (!ai.taxLines?.length) ai.taxLines = firstInvoice.taxLines;
    if (!ai.positions?.length) ai.positions = firstInvoice.positions;
  }

  const warnings: string[] = [];
  const invoiceNumber = cleanText(ai.invoiceNumber);
  const companyFrom = cleanText(ai.companyFrom);
  const invoiceToCompany = cleanText(ai.invoiceToCompany);
  const invoiceTotal = parseAmount(ai.total);
  const subtotal = parseAmount(ai.subtotal);
  const taxTotal = parseAmount(ai.taxTotal);
  const currency = normaliseCurrency(ai.currency);

  // The AI's ISO date wins; the printed text is the fallback.
  const fromIso = parseDate(ai.invoiceDate);
  const fromText = fromIso.date ? fromIso : parseDate(ai.invoiceDateText);
  const invoiceDate = fromIso.date ?? fromText.date;
  const printedDate =
    cleanText(ai.invoiceDateText) ?? cleanText(ai.invoiceDate);

  if (!invoiceDate && printedDate) {
    warnings.push(
      fromIso.ambiguous || fromText.ambiguous
        ? `The invoice date "${printedDate}" is ambiguous (day and month could be swapped) — left empty.`
        : `The invoice date "${printedDate}" could not be converted to a date — left empty.`,
    );
  }

  if (currency.assumed)
    warnings.push('The currency is printed only as "$" — assumed USD.');

  let positions = (ai.positions ?? [])
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map(
      (p): InvoicePosition => ({
        position: positionNumber(p.position),
        description: cleanText(p.description),
        quantity: parseAmount(p.quantity, 4),
        unitPrice: parseAmount(p.unitPrice, 4),
        totalPrice: parseAmount(p.totalPrice, 2),
      }),
    )
    .filter(
      (p) =>
        p.description !== null ||
        p.quantity !== null ||
        p.unitPrice !== null ||
        p.totalPrice !== null,
    );

  if (positions.length > MAX_POSITIONS) {
    warnings.push(
      `The invoice has ${positions.length} positions — only the first ${MAX_POSITIONS} are kept.`,
    );
    positions = positions.slice(0, MAX_POSITIONS);
  }

  if (
    !invoiceNumber &&
    invoiceTotal === null &&
    !invoiceDate &&
    !companyFrom &&
    !invoiceToCompany &&
    positions.length === 0
  ) {
    throw new Error(
      `(422) ${LABEL}: the document could not be read — no invoice data was found (poor scan?).`,
    );
  }

  const taxLineAmounts = (ai.taxLines ?? []).map((line) =>
    line ? parseAmount(line.amount) : null,
  );

  warnings.push(
    ...crossCheck(subtotal, taxTotal, invoiceTotal, positions, taxLineAmounts),
  );

  const required: Array<[string, unknown]> = [
    ['invoiceNumber', invoiceNumber],
    ['invoiceDate', invoiceDate],
    ['companyFrom', companyFrom],
    ['invoiceToCompany', invoiceToCompany],
    ['invoiceTotal', invoiceTotal],
  ];
  const missingFields = required
    .filter(([, value]) => value === null)
    .map(([field]) => field);

  // Missing data never fails the step — it marks the invoice invalid, with the reason spelled out.
  const invalidReasons = missingFields.map(
    (field) =>
      `The ${REQUIRED_LABELS[field] ?? field} is missing on the document.`,
  );

  // Every invoice in the document. The model repeats the first one at the top level, so a
  // single-invoice file yields exactly one entry and the flat fields above are unchanged.
  const listed = (ai.invoices ?? [])
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .map(buildInvoiceRecord);
  const invoices = listed.length > 0 ? listed : [buildInvoiceRecord(ai)];
  const maxInvoices = resolveMaxInvoices(configuredMaxInvoices);

  // Told to list only the first ones, the model still counts them all; a longer list is cut here too
  const foundCount = Math.max(invoices.length, invoiceCount ?? 0);
  const keptInvoices = invoices.slice(0, maxInvoices);

  if (foundCount > maxInvoices) {
    const skipped = foundCount - maxInvoices;

    warnings.unshift(
      `This file has ${countInvoices(foundCount)}, but this step reads at most ${maxInvoices}. ${maxInvoices === 1 ? 'The first one was' : `The first ${maxInvoices} were`} read and ${skipped === 1 ? 'the last one was' : `the other ${skipped} were`} skipped. To read them all, raise “Maximum invoices” or leave it empty.`,
    );
  } else if (Number.isFinite(maxInvoices) && foundCount < maxInvoices) {
    warnings.unshift(
      `This file has only ${countInvoices(foundCount)}, fewer than the ${maxInvoices} set in “Maximum invoices”. ${foundCount === 1 ? 'It was' : `All ${foundCount} were`} read.`,
    );
  }

  return {
    status: missingFields.length > 0 ? 'incomplete' : 'extracted',
    isValidInvoice: missingFields.length === 0,
    invoiceNumber,
    invoiceDate,
    companyFrom,
    invoiceToCompany,
    invoiceTotal,
    currency: currency.code,
    subtotal,
    taxTotal,
    positions,
    positionCount: positions.length,
    positionsText: positions
      .map((p) => positionLine(p, currency.code))
      .join('\n'),
    missingFields,
    invalidReasons,
    warnings,
    reason: cleanText(ai.notes),
    invoiceCount: keptInvoices.length,
    invoices: keptInvoices,
    ...source,
  };
}
