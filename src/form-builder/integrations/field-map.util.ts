import type { FieldMapEntry } from '../dto/create-integration.dto';

// Render a single scalar/array/option answer as plain text WITHOUT stringifying a bare object.
function scalarToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);

  if (Array.isArray(value))
    return value.map(scalarToText).filter(Boolean).join(', ');

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    if (typeof obj.label === 'string') return obj.label;
    if (typeof obj.name === 'string') return obj.name;
    if (typeof obj.value === 'string') return obj.value;
    if (typeof obj.value === 'number' || typeof obj.value === 'boolean')
      return String(obj.value);

    return Object.values(obj).map(scalarToText).filter(Boolean).join(', ');
  }

  return '';
}

// Resolve a stored choice value to its option label via the field's `options` catalog
// ([{ value, label }]). Returns null when there is no match, so the caller keeps the raw value.
function optionLabel(value: unknown, options: unknown): string | null {
  if (!Array.isArray(options)) return null;

  for (const opt of options) {
    const o = opt as { value?: unknown; label?: unknown };

    if (o && o.value === value && typeof o.label === 'string' && o.label) {
      return o.label;
    }
  }

  return null;
}

// Render an answer as text, field-type aware for the rich types so an email never gets a
// base64 data-URL or `[object]`. When `options` is supplied, a choice value is shown as its
// label ("Option 1") rather than its stored value ("option_1"). Falls back to scalarToText.
export function toText(
  value: unknown,
  fieldType?: string,
  options?: unknown,
): string {
  if (value === null || value === undefined) return '';

  if (fieldType === 'signature' || fieldType === 'camera') {
    const obj = value as { url?: unknown };

    if (obj && typeof obj.url === 'string') return obj.url;

    return '[attachment]';
  }

  if (fieldType === 'file_upload') {
    const arr = Array.isArray(value) ? value : [value];

    return arr
      .map((f) => {
        const o = f as { url?: unknown; name?: unknown };

        if (typeof f === 'string') return f;
        if (o && typeof o.url === 'string') return o.url;
        if (o && typeof o.name === 'string') return o.name;

        return '';
      })
      .filter(Boolean)
      .join(', ');
  }

  if (fieldType === 'full_name' && typeof value === 'object') {
    const o = value as Record<string, unknown>;

    return [o.first, o.last].map(scalarToText).filter(Boolean).join(' ');
  }

  if (fieldType === 'date_range' && typeof value === 'object') {
    const o = value as Record<string, unknown>;

    return [scalarToText(o.start), scalarToText(o.end)]
      .filter(Boolean)
      .join(' → ');
  }

  if (fieldType === 'address' && value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map(scalarToText)
      .filter(Boolean)
      .join(', ');
  }

  // Asset ids: no permission context server-side, so reference the id instead of resolving a name.
  if (fieldType === 'asset' || fieldType === 'asset_multi') {
    const arr = Array.isArray(value) ? value : [value];

    return arr
      .map((id) =>
        typeof id === 'string' && id ? `Asset ${id.slice(0, 8)}` : '',
      )
      .filter(Boolean)
      .join(', ');
  }

  // Choice fields: swap the stored option value for its human label. Only primitive values (or
  // arrays of them) are choices — composites were already handled above.
  if (Array.isArray(options)) {
    if (typeof value === 'string' || typeof value === 'number') {
      const label = optionLabel(value, options);

      if (label) return label;
    } else if (
      Array.isArray(value) &&
      value.every((v) => typeof v === 'string' || typeof v === 'number')
    ) {
      const mapped = value
        .map((v) => optionLabel(v, options) ?? scalarToText(v))
        .filter(Boolean);

      if (mapped.length) return mapped.join(', ');
    }
  }

  return scalarToText(value);
}

// Build a { [target]: text } map from the mapping rows + submission data, resolving field types
// from the per-submission snapshot.
export function applyFieldMap(
  fieldMap: FieldMapEntry[] | null | undefined,
  data: Record<string, unknown>,
  snapshot: unknown,
): Record<string, string> {
  const typeByKey = new Map<string, string>();
  const optionsByKey = new Map<string, unknown>();

  if (Array.isArray(snapshot)) {
    for (const entry of snapshot) {
      const f = entry as {
        field_key?: unknown;
        field_type?: unknown;
        options?: unknown;
      };

      if (typeof f?.field_key === 'string') {
        if (typeof f.field_type === 'string')
          typeByKey.set(f.field_key, f.field_type);
        if (f.options !== undefined) optionsByKey.set(f.field_key, f.options);
      }
    }
  }

  const out: Record<string, string> = {};

  for (const entry of fieldMap ?? []) {
    if (!entry?.target) continue;

    if (typeof entry.template === 'string' && entry.template.length) {
      out[entry.target] = entry.template.replace(
        /\{\{\s*([\w.-]+)\s*\}\}/g,
        (_, key: string) =>
          toText(data[key], typeByKey.get(key), optionsByKey.get(key)),
      );
    } else if (entry.source) {
      out[entry.target] = toText(
        data[entry.source],
        typeByKey.get(entry.source),
        optionsByKey.get(entry.source),
      );
    }
  }

  return out;
}

// A readable "- Label: value" block over all answers — the default email body when the user
// hasn't mapped a body field.
export function summarizeAll(
  data: Record<string, unknown>,
  snapshot: unknown,
  maxLines = 50,
): string {
  const labelByKey = new Map<string, string>();
  const typeByKey = new Map<string, string>();
  const optionsByKey = new Map<string, unknown>();

  if (Array.isArray(snapshot)) {
    for (const entry of snapshot) {
      const f = entry as {
        field_key?: unknown;
        label?: unknown;
        field_type?: unknown;
        options?: unknown;
      };

      if (typeof f?.field_key === 'string') {
        if (typeof f.label === 'string' && f.label)
          labelByKey.set(f.field_key, f.label);
        if (typeof f.field_type === 'string')
          typeByKey.set(f.field_key, f.field_type);
        if (f.options !== undefined) optionsByKey.set(f.field_key, f.options);
      }
    }
  }

  const lines: string[] = [];

  for (const [key, value] of Object.entries(data ?? {})) {
    if (lines.length >= maxLines) break;

    const text = toText(value, typeByKey.get(key), optionsByKey.get(key));

    if (!text) continue;

    lines.push(`- ${labelByKey.get(key) ?? key}: ${text}`);
  }

  return lines.join('\n');
}
