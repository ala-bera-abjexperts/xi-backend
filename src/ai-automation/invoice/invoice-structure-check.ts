/**
 * @fileoverview Cheap pre-check on a document already turned into text: does it carry the invoice
 * fields at all? It runs before the paid extraction call, so a report attached by mistake costs
 * nothing. It fails OPEN — anything without readable text is passed on rather than rejected, which
 * is why a PDF, a scan or a photo always goes straight to extraction.
 */
import type { ExecutionContext } from '../../automations/actions/types';

// Derived here rather than exported from task-attachment-finder, which keeps it private.
type RunLogger = ExecutionContext['logger'];

const LABEL = 'AI Invoice Extraction';

/**
 * The required structure, one entry per field, each with the wordings real invoices actually print.
 * Matching the concept and not one exact heading matters: only a purpose-built test document says
 * "Is Valid Invoice" or "Company From", while every real invoice names the same things differently.
 */
const FIELD_WORDS: Record<string, string[]> = {
  'invoice number': [
    'invoice number',
    'invoice no',
    'invoice #',
    'inv no',
    'invoice id',
    'rechnungsnummer',
    'rechnungs-nr',
    'rechnungsnr',
    'beleg-nr',
    'belegnummer',
  ],
  'invoice date': [
    'invoice date',
    'date of invoice',
    'issue date',
    'rechnungsdatum',
    'belegdatum',
    'leistungsdatum',
  ],
  'company from': [
    'company from',
    'seller',
    'supplier',
    'vendor',
    'bill from',
    'lieferant',
    'aussteller',
    'verkäufer',
    'verkaeufer',
  ],
  'is valid invoice': ['is valid invoice', 'valid invoice'],
  'sum of invoice': [
    'invoice total',
    'total amount',
    'amount due',
    'grand total',
    'subtotal',
    'gesamtbetrag',
    'gesamtsumme',
    'rechnungsbetrag',
    'endbetrag',
    'nettobetrag',
    'bruttobetrag',
    'zwischensumme',
  ],
  'invoice to company': [
    'invoice to',
    'invoice to company',
    'bill to',
    'billed to',
    'sold to',
    'kunde',
    'kundennummer',
    'rechnung an',
    'rechnungsempfänger',
    'rechnungsempfaenger',
    'leistungsempfänger',
    'auftraggeber',
  ],
  'invoice positions': [
    'unit price',
    'qty',
    'quantity',
    'line total',
    'einzelpreis',
    'stückpreis',
    'stueckpreis',
    'menge',
    'anzahl',
    'positionen',
  ],
};

// Says "invoice" in so many words. A report can print a date and a description; it does not call
// itself an invoice, which is why this qualifies a document on its own.
const NAMES_ITSELF = [
  'invoice',
  'rechnung',
  'credit note',
  'gutschrift',
  'tax invoice',
  'umsatzsteuer',
  'mwst',
  'ust-idnr',
];

// Below this there is too little text to judge anything.
const MIN_TEXT_CHARS = 200;

// Client rule, confirmed 2026-09-21: ANY ONE of the fields matching is enough to extract.
// The wordings above are invoice-qualified for exactly that reason — a bare "date" or "total"
// would let every report through once a single match is all it takes.
const MIN_FIELDS = 1;

/**
 * Throws `(422)` when readable text carries no invoice field at all.
 * `text` is null for anything whose content could not be read as text (PDF, image, scan).
 */
export function checkInvoiceStructure(
  text: string | null,
  fileName: string,
  logger: RunLogger,
): void {
  if (!text || text.length < MIN_TEXT_CHARS) {
    logger.info(
      `${LABEL}: ${fileName} carries no readable text — structure check skipped`,
    );

    return;
  }

  const haystack = text.toLowerCase();
  const present = Object.keys(FIELD_WORDS).filter((field) =>
    FIELD_WORDS[field].some((word) => haystack.includes(word)),
  );
  const missing = Object.keys(FIELD_WORDS).filter(
    (field) => !present.includes(field),
  );
  const namesItself = NAMES_ITSELF.some((word) => haystack.includes(word));

  // Any one field is enough; a document that calls itself an invoice also qualifies on its own.
  if (present.length >= MIN_FIELDS || namesItself) {
    logger.info(
      `${LABEL}: ${fileName} carries the invoice structure (${present.join(', ') || 'named as an invoice'})`,
    );

    return;
  }

  throw new Error(
    `(422) ${LABEL}: ${fileName} is not an invoice — none of the invoice fields (${missing.join(', ')}) appear in its text. Nothing was sent for extraction.`,
  );
}
