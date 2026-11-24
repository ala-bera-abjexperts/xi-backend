/**
 * Public slug format — the single definition shared by the create DTO, the
 * update DTO, the public-link DTO and the resolver, so they cannot drift.
 *
 * ASCII-only by design: excludes homoglyphs (a Cyrillic 'а' inside an otherwise
 * Latin word), RTL overrides and zero-width joiners, any of which could mint a
 * slug that renders identically to another tenant's link. Mirrors the CHECK
 * constraint on `form_builder.public_slug`, which is the real enforcement — this
 * is the friendly-error layer in front of it.
 */
export const PUBLIC_SLUG_REGEX = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/;

export const PUBLIC_SLUG_MESSAGE =
  'Link may contain lowercase letters, numbers and hyphens, must start and end with a letter or number, and must be at least 3 characters';

/**
 * Field types an anonymous caller may be shown and may answer.
 *
 * A whitelist, not a blacklist: a newly added field type is unavailable publicly
 * until someone deliberately assesses it, which is the safe default.
 */
export const PUBLIC_INPUT_TYPES = new Set<string>([
  'short_text',
  'long_text',
  'number',
  'spinner',
  'currency',
  'percentage',
  'email',
  'phone',
  'url',
  'password',
  'dropdown',
  'radio',
  'checkboxes',
  'yes_no',
  'terms',
  'date',
  'time',
  'datetime',
  'date_range',
  'rating',
  'linear_scale',
  'slider',
  'nps',
  'address',
  'full_name',
  'color',
  'tags',
  'button_group',
  'image_select',
  'thumbs',
  'emoji_scale',
  'ranking',
  'matrix',
  'geolocation',

  // Options are resolved server-side at serve time from the field's configured
  // schema/types (PublicFormBuilderService#resolveAssetOptions) and embedded as
  // a bounded {label,value} list, so the anonymous page never calls the
  // membership-guarded asset endpoints. The author opts into exposing those
  // asset names by scoping the field.
  'asset',

  // Multi-select asset: same server-resolved bounded option list as `asset` above.
  'asset_multi',

  // Output-only: the server recomputes it and overwrites whatever the client sent.
  'calculated',

  // Data-URI widgets: the fill component encodes the capture as a data: URL and
  // never uploads to storage, so there is no authenticated-storage prerequisite.
  // See sanitizeValue's per-type byte budget for why these are size-capped
  // instead of length-capped like every other string answer.
  'camera',
  'multi_photo',
  'signature',

  // Browser-API scanner. The answer is the decoded string; no server-side
  // config or secret is involved.
  'qr',

  // The author's own public Calendly event URL — meant to be shared, not a
  // secret. See sanitizeValidationRules' per-type extras for what survives.
  'calendly_scheduler',

  // Value is an array of flat row objects. sanitizeValue's array branch maps
  // each row through the object branch, which already nulls any doubly-nested
  // value and length-caps every scalar cell — the existing bounding is
  // sufficient for this shape without a dedicated sanitizer.
  'spreadsheet',

  // Now servable via the anonymous upload endpoint
  // (PublicFormBuilderController#uploadFile), which resolves the field from
  // the form's own field list server-side, enforces its own MIME allowlist
  // independent of the field's `acceptedTypes` config, and writes through the
  // same storage path an authenticated submission uses.
  'file_upload',
  'audio',

  // Unrestricted by explicit owner decision (2026-09-10). These were previously blocked or
  // conditional; the reasons below still describe real exposure, they are simply now accepted:
  // - `user_select` with a space/organization source resolves the member directory, so a public
  //   form can expose staff names. NOTE: the anonymous page still cannot read that directory, so
  //   such a field renders an empty picker until the options are resolved server-side.
  // - `hidden` becomes settable by an anonymous caller.
  // - `products` can be shown without a payment config, so a buyer may see an unpayable price.
  // - `recaptcha` renders unconfigured, i.e. decorative — it waves every bot through.
  // - `repeater` has no fill-time renderer and degrades to a plain text input.
  // Secret stripping is unaffected: recaptcha_secret_key, task_field and gateway config are
  // excluded by PUBLIC_SAFE_VALIDATION_KEYS and must stay excluded.
  'products',
  'recaptcha',
  'user_select',
  'repeater',
  'hidden',
]);

/**
 * Presentational types that carry no answer. Served so the form reads as its
 * author designed it, never accepted back.
 */
export const PUBLIC_DISPLAY_TYPES = new Set<string>([
  'heading',
  'paragraph',
  'divider',
  'image',
  'page_break',
  'layout',
]);

/**
 * Previously: types servable publicly only while an extra condition held.
 *
 * Now empty — `products`, `recaptcha` and `user_select` were moved into {@link PUBLIC_INPUT_TYPES}
 * unconditionally by owner decision. The helpers below are kept: they still gate whether a widget
 * is *enforced* or *served configured*, which is a separate question from whether the form may be
 * published at all.
 */
export const PUBLIC_CONDITIONAL_TYPES = new Set<string>([]);

/** Extra facts that unlock a conditional type for a specific form. */
export interface PublicSafetyContext {
  /** The form's space has an active payment config with a usable secret. Unlocks `products`. */
  paymentConfigured?: boolean;
}

/** A reCAPTCHA field can only be enforced when it carries both halves of the key pair. */
export function isRecaptchaConfigured(field: {
  validation_rules?: unknown;
}): boolean {
  const rules = (field.validation_rules ?? {}) as Record<string, unknown>;

  return (
    typeof rules.recaptcha_site_key === 'string' &&
    rules.recaptcha_site_key.trim().length > 0 &&
    typeof rules.recaptcha_secret_key === 'string' &&
    rules.recaptcha_secret_key.trim().length > 0
  );
}

/**
 * A `user_select` field may only be served publicly when its picker is scoped to the author's own
 * `custom` list — `space`/`organization` sources would resolve against the live directory, which an
 * anonymous caller must never see.
 */
export function isCustomUserSelect(field: {
  validation_rules?: unknown;
}): boolean {
  const rules = (field.validation_rules ?? {}) as Record<string, unknown>;

  return rules.userSource === 'custom';
}

/**
 * Previously: types that could never be served publicly (`repeater`, `hidden`).
 *
 * Now empty by owner decision — every palette type is publishable. The consequences are recorded
 * on the corresponding entries in {@link PUBLIC_INPUT_TYPES}.
 */
export const PUBLIC_BLOCKED_TYPES = new Set<string>([]);

/**
 * `validation_rules` keys safe to expose. Everything else is stripped, because
 * that object also carries payment-gateway config, Calendly URLs, reCAPTCHA
 * secrets and the `task_field` mapping.
 *
 * Layout keys (`width`, `label_position`, `label_width`) are included so a
 * published form keeps the per-field widths and label placement its author set —
 * without them every field silently falls back to the form-wide default.
 */
export const PUBLIC_SAFE_VALIDATION_KEYS = new Set<string>([
  'min',
  'max',
  'step',
  'minLength',
  'maxLength',
  'min_length',
  'max_length',
  'pattern',
  'decimals',
  'minDate',
  'maxDate',
  'min_date',
  'max_date',
  'minLabel',
  'maxLabel',
  'min_label',
  'max_label',
  'maxRating',
  'max_rating',
  'allowHalf',
  'prefix',
  'suffix',
  'requiredSubfields',
  'width',
  'label_position',
  'label_width',
  'rows',
  'columns',

  // Products presentation. None of these is a secret — the buyer is shown the price and currency
  // anyway — and the server recomputes the charge from the stored catalog, so a tampered value
  // cannot change what is billed. The gateway SECRETS live in form_builder_payment_configs and are
  // never part of a field, so they cannot leak through here.
  'currency',
  'gateway',
  'allowQuantity',
  'requireSelection',

  // reCAPTCHA rendering. The SITE key is public by definition — Google requires it in the page for
  // the widget to load at all. `recaptcha_secret_key` is deliberately absent and must stay absent:
  // it is the server's half of the pair, and leaking it would let anyone forge a verification.
  'recaptcha_version',
  'recaptcha_theme',
  'recaptcha_site_key',

  // Info-icon tooltip text. Author-set, shown to the same visitor filling the
  // field — safe on every type.
  'tooltip',
]);

/**
 * `validation_rules` keys safe to expose ONLY for a specific field type — each entry is a
 * presentation setting the fill renderer reads for that type and nothing else. Kept separate
 * from {@link PUBLIC_SAFE_VALIDATION_KEYS} (which applies to every type) so exposing `url` on
 * an `image` field, say, cannot also leak a `calendly_scheduler` field's booking URL onto some
 * unrelated type through the same key name.
 *
 * `task_field` (task-catalog binding) and `recaptcha_secret_key` are deliberately absent from
 * every entry here and must stay absent.
 */
const PUBLIC_SAFE_VALIDATION_KEYS_BY_TYPE: Record<string, string[]> = {
  image: ['url'],
  terms: ['terms_text'],

  // The paragraph's formatted body. Without it a public form falls back to the plain `label` and
  // silently loses every bit of formatting the author applied. Sanitised on write, same as terms.
  paragraph: ['paragraph_html'],

  // Which picker source the field uses. Without it the public renderer falls back
  // to `space` (FormBuilderUserSelectInput: `validationRules?.userSource || 'space'`)
  // and shows "No users found", because an anonymous visitor cannot read the
  // member directory — even when the author chose the `custom` list. The value is
  // just a mode string; the directory stays unreachable, and a `custom` list's
  // people come from `options`, which is already served via sanitizeOptions.
  user_select: ['userSource'],
  date: ['dateFormat', 'disable_past'],
  datetime: ['dateFormat', 'disable_past', 'timeFormat'],
  date_range: ['dateFormat', 'disable_past'],
  time: ['timeFormat'],
  phone: ['defaultCountry'],
  color: ['color_mode', 'color_palette'],
  tags: ['tag_suggestions'],
  image_select: ['max_selections'],
  page_break: [
    'nextButtonText',
    'backButtonText',
    'buttonAlign',
    'buttonSpacing',
  ],
  // The author's own public Calendly event URL, plus cosmetic/prefill knobs —
  // none is a secret (see PUBLIC_INPUT_TYPES' calendly_scheduler entry).
  calendly_scheduler: [
    'calendlyUrl',
    'prefillNameFieldKey',
    'prefillEmailFieldKey',
    'hideEventDetails',
    'hideCookieBanner',
    'requireBooking',
  ],
  audio: ['max_duration_seconds'],
  multi_photo: ['maxPhotos'],
  file_upload: ['acceptedTypes', 'maxFiles', 'maxSizeMb'],

  // The parent FORM field key only, set server-side by withAssetDependsOnRule (never schema/type ids).
  asset: ['asset_depends_on_field'],
  asset_multi: ['asset_depends_on_field'],
};

/**
 * `layout`'s grid definition lives entirely in `options.cells[row][col].type` — cells are NOT rows
 * in `form_builder_fields`, so a top-level scan of `fields` never sees them. Any palette type except
 * `layout`/`page_break` may be dropped into a cell (mirrors the frontend's
 * `LAYOUT_CELL_EXCLUDED_TYPES`), so a cell can carry exactly the same unsafe types a top-level field
 * can.
 */
function collectLayoutCellTypes(options: unknown): string[] {
  if (!options || typeof options !== 'object') return [];

  const cells = (options as Record<string, unknown>).cells;
  if (!Array.isArray(cells)) return [];

  const types: string[] = [];

  for (const row of cells) {
    if (!Array.isArray(row)) continue;

    for (const cell of row) {
      if (!cell || typeof cell !== 'object') continue;
      const type = (cell as Record<string, unknown>).type;
      if (typeof type === 'string' && type) types.push(type);
    }
  }

  return types;
}

/**
 * Names the field types that prevent a form from being published publicly.
 *
 * `ctx` unlocks the conditional types: without `paymentConfigured`, a `products` field still counts
 * as unsafe, because a public buyer would be shown a price no checkout can take. The conditional
 * unlock is NOT extended to a cell nested inside a `layout` field — there is no per-cell gateway/key
 * context to evaluate it against, so a `products`/`recaptcha` cell is conservatively always unsafe
 * (this cannot regress an existing public form: layout options were previously stripped to `null`
 * entirely, so a nested products/recaptcha cell never actually worked publicly before either).
 */
export function findPubliclyUnsafeTypes(
  fields: Array<{
    field_type: string;
    validation_rules?: unknown;
    options?: unknown;
  }>,
  ctx: PublicSafetyContext = {},
): string[] {
  const offending = new Set<string>();

  for (const field of fields) {
    const type = field.field_type;

    if (PUBLIC_INPUT_TYPES.has(type) || PUBLIC_DISPLAY_TYPES.has(type)) {
      if (type === 'layout') {
        for (const cellType of collectLayoutCellTypes(field.options)) {
          if (
            !PUBLIC_INPUT_TYPES.has(cellType) &&
            !PUBLIC_DISPLAY_TYPES.has(cellType)
          ) {
            offending.add(cellType);
          }
        }
      }

      continue;
    }

    // Currently unreachable: all three types now sit in PUBLIC_INPUT_TYPES, so the check above
    // short-circuits first. Kept so the conditional rule resurrects correctly if one is ever
    // pulled back out of that set.
    if (type === 'products' && ctx.paymentConfigured) continue;

    // Per-field, not per-space: two reCAPTCHA fields on one form could be configured differently.
    if (type === 'recaptcha' && isRecaptchaConfigured(field)) continue;

    if (type === 'user_select' && isCustomUserSelect(field)) continue;

    offending.add(type);
  }

  return Array.from(offending).sort();
}

/**
 * True when the only thing standing between this form and a public link is an unconfigured payment
 * gateway. Call sites use it to explain the fix ("connect Stripe") instead of the blunt
 * "remove these fields".
 */
export function isPaymentConfigOnlyBlocker(unsafe: string[]): boolean {
  return unsafe.length === 1 && unsafe[0] === 'products';
}

/**
 * Strips `validation_rules` down to the publicly safe subset for `fieldType`.
 *
 * `fieldType` is optional so existing callers (and old test fixtures) that only need the
 * type-agnostic keys keep working, but every real call site should pass it — omitting it
 * silently loses every type-specific presentation key listed in
 * {@link PUBLIC_SAFE_VALIDATION_KEYS_BY_TYPE}.
 */
export function sanitizeValidationRules(
  rules: unknown,
  fieldType?: string,
): Record<string, unknown> | null {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return null;

  const extra = fieldType
    ? PUBLIC_SAFE_VALIDATION_KEYS_BY_TYPE[fieldType]
    : undefined;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rules as Record<string, unknown>)) {
    if (PUBLIC_SAFE_VALIDATION_KEYS.has(key) || extra?.includes(key)) {
      out[key] = value;
    }
  }

  return Object.keys(out).length ? out : null;
}

/**
 * A `products` catalog entry, reduced to the fields the buyer is shown and the server needs to
 * re-price the order. Deliberately NOT run through the `{ label, value }` reducer below: a product
 * has neither key, so it would serialize to `{ label: '', value: '' }` and the field would render as
 * an empty catalog. Prices are public by nature (the buyer sees them) and the charge is always
 * recomputed server-side from the stored catalog, so a tampered price cannot change what is billed.
 */
function productEntry(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;

  const row = entry as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id : '';
  const name = typeof row.name === 'string' ? row.name : '';

  if (!id) return null;

  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  const out: Record<string, unknown> = {
    id,
    name,
    price: num(row.price, 0),
    qtyMin: num(row.qtyMin, 0),
    qtyMax: num(row.qtyMax, 0),
  };

  if (typeof row.description === 'string') out.description = row.description;
  if (typeof row.image === 'string') out.image = row.image;

  return out;
}

/** Public form of a `products` catalog. Non-array or unusable entries collapse to an empty list. */
export function sanitizeProductOptions(options: unknown): unknown[] {
  if (!Array.isArray(options)) return [];

  return options
    .map(productEntry)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

/**
 * Reduces a field's `options` to `{ label, value }` pairs, plus `image` when present.
 *
 * Handles the `matrix` shape (`{ rows, columns }`) explicitly — it is an object,
 * not an array, so a naive `Array.isArray` guard returns null and the renderer
 * shows "not configured".
 */
export function sanitizeOptions(options: unknown): unknown {
  /**
   * Coerces only primitives. A nested object would otherwise stringify to
   * '[object Object]' and be served to the visitor as an option label.
   */
  const text = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return `${value}`;
    if (typeof value === 'boolean') return value ? 'true' : 'false';

    // null / undefined / object / array / symbol / function — none of which has a
    // meaningful string form for an option label.
    return '';
  };

  const pair = (entry: unknown) => {
    if (entry === null || typeof entry !== 'object') {
      const flat = text(entry);

      return { label: flat, value: flat };
    }

    const row = entry as Record<string, unknown>;
    const label = text(row.label) || text(row.value);
    const value = text(row.value) || text(row.label);

    // image_select renders a per-option thumbnail (see FormBuilderFieldSwitch's
    // 'image_select' case) — mirrors productEntry's same treatment of row.image.
    return typeof row.image === 'string'
      ? { label, value, image: row.image }
      : { label, value };
  };

  if (Array.isArray(options)) return options.map(pair);

  if (options && typeof options === 'object') {
    const shape = options as Record<string, unknown>;

    if (Array.isArray(shape.rows) || Array.isArray(shape.columns)) {
      return {
        rows: Array.isArray(shape.rows) ? shape.rows.map(pair) : [],
        columns: Array.isArray(shape.columns) ? shape.columns.map(pair) : [],
      };
    }
  }

  return null;
}

/** Cell types safe to serve inside a `layout` grid — see findPubliclyUnsafeTypes' doc comment. */
function isPubliclySafeCellType(type: string): boolean {
  return PUBLIC_INPUT_TYPES.has(type) || PUBLIC_DISPLAY_TYPES.has(type);
}

/**
 * One `layout` grid cell, reduced to what an anonymous visitor may see. A cell is NOT a row in
 * `form_builder_fields` (see collectLayoutCellTypes) — it carries its own `options`/
 * `validationRules`, sanitized here through the SAME type-aware helpers a top-level field goes
 * through, keyed by the CELL's own type.
 *
 * An unsafe cell type collapses to an empty cell rather than leaking its config. This is
 * defense-in-depth, not the primary gate — `findPubliclyUnsafeTypes` already 404s the whole form
 * before `sanitizeLayoutOptions` is ever reached, so this function should never actually observe
 * an unsafe type in practice.
 */
function sanitizeLayoutCell(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return { type: '', label: '' };

  const cell = raw as Record<string, unknown>;
  const type = typeof cell.type === 'string' ? cell.type : '';

  if (!type || !isPubliclySafeCellType(type)) return { type: '', label: '' };

  const out: Record<string, unknown> = {
    type,
    label: typeof cell.label === 'string' ? cell.label : '',
  };

  if (typeof cell.fieldKey === 'string' && cell.fieldKey)
    out.fieldKey = cell.fieldKey;
  if (typeof cell.placeholder === 'string') out.placeholder = cell.placeholder;
  if (typeof cell.helpText === 'string') out.helpText = cell.helpText;
  if (typeof cell.required === 'boolean') out.required = cell.required;

  const options = sanitizeOptions(cell.options);
  if (options != null) out.options = options;

  const rules = sanitizeValidationRules(cell.validationRules, type);
  if (rules != null) out.validationRules = rules;

  return out;
}

/**
 * Reduces a `layout` field's grid config to what an anonymous visitor may see: the numeric/enum
 * layout knobs, unchanged, plus every cell run through {@link sanitizeLayoutCell}.
 *
 * NOT handled by the generic {@link sanitizeOptions}: a layout's `options` is an object whose
 * `rows`/`columns` are CELL COUNTS (numbers), not `{label,value}` arrays like `matrix`'s — the
 * generic reducer's shape check (`Array.isArray(shape.rows)`) is false for a layout, so it fell
 * through to `null` and the entire grid (and everything inside it) vanished on a published form.
 */
export function sanitizeLayoutOptions(
  options: unknown,
): Record<string, unknown> | null {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    return null;

  const o = options as Record<string, unknown>;
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const oneOf = <T extends string>(
    value: unknown,
    allowed: readonly T[],
    fallback: T,
  ): T => (allowed.includes(value as T) ? (value as T) : fallback);

  const rawCells = Array.isArray(o.cells) ? o.cells : [];
  const cells = rawCells.map((row) =>
    Array.isArray(row) ? row.map(sanitizeLayoutCell) : [],
  );

  return {
    rows: num(o.rows, 2),
    columns: num(o.columns, 2),
    gap: num(o.gap, 12),
    rowGap: num(o.rowGap, 12),
    align: oneOf(o.align, ['start', 'center', 'stretch'] as const, 'stretch'),
    columnPreset: oneOf(
      o.columnPreset,
      ['equal', 'sidebar_left', 'sidebar_right'] as const,
      'equal',
    ),
    mode: oneOf(
      o.mode,
      ['grid', 'flex', 'columns', 'table', 'flow'] as const,
      'grid',
    ),
    flexDirection: oneOf(o.flexDirection, ['row', 'column'] as const, 'row'),
    wrap: o.wrap !== false,
    justify: oneOf(
      o.justify,
      ['start', 'center', 'end', 'between'] as const,
      'start',
    ),
    cells,
  };
}
