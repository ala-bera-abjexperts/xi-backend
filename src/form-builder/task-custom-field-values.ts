import { formatValue } from '../automations/utils/submission-answers';
import { sanitizeRichText } from '../common/utils/sanitize-rich-text';
import type { FieldType } from '../custom-fields/models/custom-field.model';
import { validateFieldValue } from '../custom-fields/utils/custom-field-validation';

const TEXT = ['string', 'editor'];
const NUMERIC = ['number', 'string', 'editor'];
const BOOLEAN = ['checkbox', 'string', 'editor'];
const SINGLE_CHOICE = [
  'select',
  'radio',
  'multiselect',
  'list_item',
  'string',
  'editor',
];
const MULTI_CHOICE = ['multiselect', 'string', 'editor'];

// Form answer type → task custom-field types it may fill. Keep in lockstep with the frontend
// `src/views/form-builder/task-field-mappings.ts`.
export const TASK_CUSTOM_FIELD_TARGETS: Record<string, readonly string[]> = {
  short_text: ['string', 'editor'],
  long_text: ['editor', 'string'],
  paragraph: ['editor', 'string'],
  email: TEXT,
  phone: TEXT,
  qr: TEXT,
  color: TEXT,
  hidden: TEXT,
  url: ['url', 'string', 'editor'],
  number: NUMERIC,
  spinner: NUMERIC,
  currency: NUMERIC,
  percentage: NUMERIC,
  slider: NUMERIC,
  rating: NUMERIC,
  linear_scale: NUMERIC,
  nps: NUMERIC,
  emoji_scale: NUMERIC,
  calculated: NUMERIC,
  yes_no: BOOLEAN,
  terms: BOOLEAN,
  dropdown: SINGLE_CHOICE,
  radio: SINGLE_CHOICE,
  button_group: ['select', 'radio', 'multiselect', 'string', 'editor'],
  image_select: MULTI_CHOICE,
  thumbs: TEXT,
  checkboxes: ['multiselect', 'list_item_multi', 'string', 'editor'],
  tags: MULTI_CHOICE,
  ranking: MULTI_CHOICE,
  date: ['date', 'string', 'editor'],
  datetime: ['datetime', 'date', 'string', 'editor'],
  time: ['time', 'string', 'editor'],
  full_name: TEXT,
  address: TEXT,
  geolocation: TEXT,
  matrix: TEXT,
  spreadsheet: TEXT,
  products: TEXT,
  calendly_scheduler: TEXT,
  user_select: ['user_select', 'user_multi'],
  asset: ['asset', 'asset_multi'],
  asset_multi: ['asset_multi'],
  file_upload: TEXT,
  audio: TEXT,
};

// Pairs offered before the matrix was widened — they keep writing what they wrote before.
const LEGACY_PAIRS: Record<string, readonly string[]> = {
  short_text: ['string'],
  long_text: ['editor', 'string'],
  paragraph: ['editor', 'string'],
  email: ['string'],
  phone: ['string'],
  url: ['url', 'string'],
  number: ['number'],
  percentage: ['number'],
  slider: ['number'],
  spinner: ['number'],
  date: ['date'],
  datetime: ['datetime', 'date'],
  dropdown: ['select', 'radio', 'list_item', 'string'],
  radio: ['radio', 'select', 'list_item', 'string'],
  button_group: ['select', 'radio', 'string'],
  checkboxes: ['multiselect', 'list_item_multi'],
  user_select: ['user_select', 'user_multi'],
  asset: ['asset'],
  asset_multi: ['asset_multi'],
};

const CHOICE_TYPES = new Set([
  'dropdown',
  'radio',
  'button_group',
  'image_select',
  'checkboxes',
  'ranking',
  'tags',
]);
const FILE_TYPES = new Set(['file_upload', 'audio']);

export interface ITaskCustomFieldTarget {
  field_type: string;
  options?: unknown;
  validation_rules?: unknown;
}

export type TaskCustomFieldConversion =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

interface IOption {
  value: string;
  label: string;
}

const ok = (value: unknown): TaskCustomFieldConversion => ({ ok: true, value });
const fail = (reason: string): TaskCustomFieldConversion => ({
  ok: false,
  reason,
});

// Own keys only, so an answer type like 'constructor' can never reach a prototype member.
const allows = (
  map: Record<string, readonly string[]>,
  from: string,
  to: string,
) => Object.hasOwn(map, from) && map[from].includes(to);

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asList = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [value];

const norm = (text: string) => text.trim().toLowerCase();

const part = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

const joinParts = (parts: unknown[], separator: string) =>
  parts.map(part).filter(Boolean).join(separator);

// `[{label, value}]` options; any other shape (a matrix's {rows, columns}) yields none.
function optionList(options: unknown): IOption[] {
  if (!Array.isArray(options)) return [];

  return options.flatMap((option) => {
    const value = part(asRecord(option).value);
    const label = asRecord(option).label;

    return value
      ? [{ value, label: typeof label === 'string' ? label : value }]
      : [];
  });
}

const labelOf = (options: IOption[], value: unknown): string => {
  const text = formatValue(value);

  return options.find((option) => option.value === text)?.label ?? text;
};

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;

  const text = typeof value === 'string' ? norm(value) : '';

  if (text === 'yes' || text === 'true') return true;
  if (text === 'no' || text === 'false') return false;

  return undefined;
}

// `false` and 0 are answers; only blank text, empty lists and all-blank objects are not.
function isEmptyAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return !value.trim();
  if (Array.isArray(value)) return value.every(isEmptyAnswer);
  if (typeof value === 'object')
    return Object.values(value).every(isEmptyAnswer);

  return false;
}

// One readable line for the answer, the way the respondent saw it (labels, not option keys).
function answerText(type: string, options: unknown, answer: unknown): string {
  if (CHOICE_TYPES.has(type)) {
    const list = optionList(options);

    return asList(answer)
      .map((item) => labelOf(list, item))
      .filter(Boolean)
      .join(', ');
  }

  const obj = asRecord(answer);

  switch (type) {
    case 'yes_no':
    case 'terms': {
      const bool = toBoolean(answer);

      return bool === undefined ? formatValue(answer) : bool ? 'Yes' : 'No';
    }
    case 'full_name':
      return joinParts([obj.first, obj.last], ' ');
    case 'address':
      return joinParts(
        [
          obj.street,
          joinParts([obj.postal, obj.city], ' '),
          obj.state,
          obj.country,
        ],
        ', ',
      );
    case 'matrix': {
      const grid = asRecord(options);
      const rows = optionList(grid.rows);
      const columns = optionList(grid.columns);

      return Object.entries(obj)
        .map(([row, column]) => {
          const cell = asList(column)
            .map((c) => labelOf(columns, c))
            .filter(Boolean)
            .join(', ');

          return cell ? `${labelOf(rows, row)}: ${cell}` : '';
        })
        .filter(Boolean)
        .join('; ');
    }
    case 'products':
      return (Array.isArray(obj.items) ? obj.items : [])
        .map((item) => {
          const name = part(asRecord(item).name);
          const quantity = part(asRecord(item).quantity);

          return name && quantity ? `${name} × ${quantity}` : name;
        })
        .filter(Boolean)
        .join(', ');
    case 'calendly_scheduler':
      return part(obj.bookedAt) || (obj.scheduled ? 'Booked' : '');
    case 'spreadsheet': {
      // One "column: value" line per row; formatValue would keep only a `name` column.
      const columns = optionList(asRecord(options).columns);

      return asList(answer)
        .map((row) =>
          Object.entries(asRecord(row))
            .map(([column, value]) =>
              part(value) ? `${labelOf(columns, column)}: ${part(value)}` : '',
            )
            .filter(Boolean)
            .join(', '),
        )
        .filter(Boolean)
        .join('; ');
    }
    default:
      return formatValue(answer);
  }
}

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);

// Blank lines become paragraphs, single newlines line breaks.
const textToHtml = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('');

// Only http(s) becomes a link; anything else (a data URL, a storage path) is plain text.
function fileLinksHtml(answer: unknown): string {
  return asList(answer)
    .map((file) => {
      const ref = typeof file === 'string' ? { url: file } : asRecord(file);
      const url = part(ref.url);
      const name = part(ref.name);

      return /^https?:\/\//i.test(url)
        ? `<a href="${escapeHtml(url)}">${escapeHtml(name || url)}</a>`
        : escapeHtml(name || formatValue(url));
    })
    .filter(Boolean)
    .join('<br>');
}

// Custom-field option value for one answer. Existing pairs match by value first, as before; new
// pairs by label first, because form option values are `option_N` keys that can collide.
function matchOption(
  fieldOptions: IOption[],
  formOptions: IOption[],
  item: unknown,
  labelFirst: boolean,
): string | undefined {
  const raw = part(item);

  if (!raw) return undefined;

  const labels = [raw, labelOf(formOptions, raw)].map(norm);
  const byValue = () =>
    fieldOptions.find((option) => option.value === raw)?.value;
  const byLabel = () =>
    fieldOptions.find((option) => labels.includes(norm(option.label)))?.value;

  return labelFirst ? (byLabel() ?? byValue()) : (byValue() ?? byLabel());
}

function convert(
  answerType: string,
  answerOptions: unknown,
  target: ITaskCustomFieldTarget,
  answer: unknown,
  legacy: boolean,
): TaskCustomFieldConversion {
  switch (target.field_type) {
    case 'string': {
      const max = asRecord(target.validation_rules).maxLength;
      let text = answerText(answerType, answerOptions, answer);

      // Code points, so an emoji is never cut in half.
      if (typeof max === 'number' && max > 0) {
        text = Array.from(text).slice(0, max).join('');
      }

      return (legacy ? text : text.trim()) ? ok(text) : fail('empty');
    }
    case 'editor': {
      // Task editors render this as HTML, so the answer is escaped and then sanitized.
      const files = FILE_TYPES.has(answerType);
      const content = files
        ? fileLinksHtml(answer)
        : answerText(answerType, answerOptions, answer);

      if (!legacy && !content.trim()) return fail('empty');

      const html = files ? `<p>${content}</p>` : textToHtml(content);

      return ok(sanitizeRichText(html, { allowTables: true }) ?? '');
    }
    case 'number': {
      const num =
        typeof answer === 'number'
          ? answer
          : typeof answer === 'string' && answer.trim()
            ? Number(answer)
            : NaN;

      return Number.isFinite(num) ? ok(num) : fail('not a number');
    }
    case 'checkbox': {
      const bool = toBoolean(answer);

      return bool === undefined ? fail('not a yes/no answer') : ok(bool);
    }
    case 'select':
    case 'radio': {
      const fieldOptions = optionList(target.options);

      if (!fieldOptions.length) return ok(answer);

      const matched = matchOption(
        fieldOptions,
        optionList(answerOptions),
        answer,
        !legacy,
      );

      if (matched !== undefined) return ok(matched);

      return legacy ? ok(answer) : fail('no matching option');
    }
    case 'multiselect': {
      const items = asList(answer);
      const fieldOptions = optionList(target.options);

      if (!items.length || !fieldOptions.length) return ok(items);

      const formOptions = optionList(answerOptions);
      const values = items.flatMap((item) => {
        const matched = matchOption(fieldOptions, formOptions, item, !legacy);

        return matched !== undefined ? [matched] : legacy ? [item] : [];
      });

      return values.length
        ? ok([...new Set(values)])
        : fail('no matching option');
    }
    case 'user_multi':
    case 'asset_multi':
      return ok(asList(answer));
    default:
      // url, date, datetime, time, user_select, asset, list_item(_multi): stored as submitted
      return ok(answer);
  }
}

/**
 * Converts one form answer into the value a task custom field of `target.field_type` stores, or
 * says why it cannot. Pure — the caller decides what to do with a refusal.
 */
export function toTaskCustomFieldValue(input: {
  answerType: string;
  answerOptions: unknown;
  target: ITaskCustomFieldTarget;
  answer: unknown;
}): TaskCustomFieldConversion {
  const { answerType, answerOptions, target, answer } = input;
  const type = target.field_type;

  // No asset schema check: a mapped asset element inherits the custom field's config, and the
  // task creator verifies the ids against it.
  if (!allows(TASK_CUSTOM_FIELD_TARGETS, answerType, type))
    return fail(`stale pair ${answerType} → ${type}`);

  const legacy = allows(LEGACY_PAIRS, answerType, type);

  if (!legacy && isEmptyAnswer(answer)) return fail('empty');

  const result = convert(answerType, answerOptions, target, answer, legacy);

  if (!result.ok || legacy) return result;

  // Type check for new pairs only; options were matched above, and the full rules would reject
  // values legacy pairs have always written.
  try {
    validateFieldValue(
      {
        field_type: type as FieldType,
        field_key: type,
        name: type,
        options: [],
        validation_rules: {},
      },
      result.value,
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'invalid value');
  }

  return result;
}
