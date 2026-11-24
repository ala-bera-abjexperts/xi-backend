/**
 * Redaction for row payloads persisted into restore_run_records.
 *
 * THIS IS THE FIRST IMPLEMENTATION OF `exclude_secrets` AND `redact_jsonb_secrets`.
 * ------------------------------------------------------------------------------
 * Both flags have existed since the backup module shipped: declared in the scheme options Zod
 * schema, documented in 20260730000001_backup_module.sql, and seeded as `true` in seed.sql. Nothing
 * has ever read them — no branch in table-exporter.service.ts or backup-worker.service.ts consults
 * either one. Operators have been looking at a checked "exclude secrets" box that did nothing.
 *
 * That is worth stating plainly rather than quietly fixing, because it changes what the flags mean:
 * turning them on here does NOT retroactively protect existing archives, and it does not make the
 * BACKUP path honour them either. It makes them true for the restore report only. Extending them to
 * the export path is a separate change with a different blast radius.
 *
 * WHY REDACT AT ALL
 * -----------------
 * restore_run_records stores the content of rows that were NOT restored, because a skipped row
 * exists nowhere else once the archive is gone. That content is tenant data and can contain
 * personal data. It then sits in a table with a longer life than the request that made it, readable
 * by every org owner and admin. Storing a bearer token or a password hash there would turn an audit
 * feature into a credential store.
 *
 * The denylist is on COLUMN NAMES, not values. Value-sniffing (does this look like a JWT?) produces
 * false negatives on the things that matter most and false positives on ordinary prose.
 */

/** Substrings that mark a column as never persistable. Matched case-insensitively. */
const SECRET_NAME_FRAGMENTS = [
  'secret',
  'token',
  'password',
  'passphrase',
  'credential',
  'private_key',
  'privatekey',
  'api_key',
  'apikey',
  'access_key',
  'client_secret',
  'session_id',
  'sessionid',
  'signature',
  'salt',
  'nonce',
] as const;

/** Exact column suffixes used by the module's own envelope-encryption columns. */
const SECRET_NAME_SUFFIXES = [
  '_encrypted',
  '_iv',
  '_tag',
  '_hash',
  '_fingerprint',
] as const;

/** What replaces a redacted value, so the report can say "there was something here". */
export const REDACTED = '[redacted]';

/** Longest single string value kept. Beyond this the value is clamped, not dropped. */
const MAX_VALUE_LENGTH = 512;

/** Longest serialised payload kept per row. A row bigger than this is truncated with a marker. */
const MAX_PAYLOAD_BYTES = 4_096;

/** How deep the jsonb walk goes before it stops descending. */
const MAX_DEPTH = 6;

/** Most elements kept from an array inside a jsonb value. */
const MAX_ARRAY_ITEMS = 20;

export interface RedactionOptions {
  /**
   * Drop secret-named COLUMNS entirely. Defaults to true — the safe answer when a scheme predates
   * the option, which every existing scheme does.
   */
  excludeSecrets?: boolean;
  /**
   * Also walk INTO jsonb values looking for secret-named keys. Defaults to true.
   *
   * Separate from `excludeSecrets` because the cost is different: a column check is one string
   * comparison, a jsonb walk is recursive over arbitrary operator-authored content.
   */
  redactJsonbSecrets?: boolean;
}

/** True when a column or jsonb key name looks like it holds a secret. */
export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();

  if (SECRET_NAME_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return true;
  }

  return SECRET_NAME_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/** Clamps a long string and marks that it was clamped, so the reader is never misled by a prefix. */
function clampString(value: string): string {
  return value.length > MAX_VALUE_LENGTH
    ? `${value.slice(0, MAX_VALUE_LENGTH)}… [truncated]`
    : value;
}

/**
 * Recursively redacts a jsonb value.
 *
 * Depth and array limits exist because this runs inside the restore loop, once per skipped row, on
 * content the engine did not author — a deeply nested automation definition or form schema must not
 * turn record capture into the slowest part of a restore.
 */
function redactValue(
  value: unknown,
  redactJsonb: boolean,
  depth: number,
): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return clampString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return '[nested]';
  }

  if (Array.isArray(value)) {
    const kept = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactValue(item, redactJsonb, depth + 1));

    if (value.length > MAX_ARRAY_ITEMS) {
      kept.push(`… ${value.length - MAX_ARRAY_ITEMS} more`);
    }

    return kept;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};

    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (redactJsonb && isSecretName(key)) {
        out[key] = REDACTED;
        continue;
      }

      out[key] = redactValue(nested, redactJsonb, depth + 1);
    }

    return out;
  }

  // Anything else (function, symbol, bigint) has no place in an archived row.
  return null;
}

/**
 * Produces the payload stored in restore_run_records.archived_row / live_row.
 *
 * Returns null for an empty or unusable row rather than `{}`, so the column stays NULL and the UI
 * can distinguish "no payload captured" from "payload captured and it was empty".
 */
export function redactRowForRecord(
  row: Record<string, unknown> | null | undefined,
  options: RedactionOptions = {},
): Record<string, unknown> | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return null;
  }

  const excludeSecrets = options.excludeSecrets ?? true;
  const redactJsonb = options.redactJsonbSecrets ?? true;

  const out: Record<string, unknown> = {};

  for (const [column, value] of Object.entries(row)) {
    if (excludeSecrets && isSecretName(column)) {
      out[column] = REDACTED;
      continue;
    }

    out[column] = redactValue(value, redactJsonb, 0);
  }

  if (Object.keys(out).length === 0) {
    return null;
  }

  return clampPayload(out);
}

/**
 * Enforces the per-row byte ceiling.
 *
 * Drops whole columns from the end rather than truncating the JSON text, because a truncated
 * serialisation is not valid jsonb and Postgres would reject the insert — failing the record write
 * for a row whose only crime was being large.
 */
function clampPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MAX_PAYLOAD_BYTES) {
    return payload;
  }

  const out: Record<string, unknown> = {};
  let dropped = 0;

  for (const [column, value] of Object.entries(payload)) {
    const candidate = { ...out, [column]: value };

    if (
      Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_PAYLOAD_BYTES
    ) {
      dropped += 1;
      continue;
    }

    out[column] = value;
  }

  if (dropped > 0) {
    out['__truncated__'] =
      `${dropped} column(s) omitted: the row exceeded ${MAX_PAYLOAD_BYTES} bytes`;
  }

  return out;
}
