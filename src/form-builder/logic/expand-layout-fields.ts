/**
 * Expands `layout` field rows into synthetic per-cell field rows. Layout cells are stored in the
 * layout row's `options.cells[row][col]` jsonb, not as their own `form_builder_fields` row, so any
 * consumer that walks the fields table directly (submission validation, the Stripe payment field
 * lookup) would otherwise miss a field placed inside a Layout container.
 *
 * Keyed the SAME way the client keys them (layoutCellKey: `${layout.field_key}__cell_r${r}_c${c}`),
 * so cell answers stored under that key are matched up correctly. Must match resolveCellKey() on
 * the client.
 */

// One element nested inside a Layout field's `options.cells`. Mirrors ILayoutCell on the client
// (`layout-grid-utils.ts`) — keep the two in step.
interface LayoutCell {
  type?: string;
  label?: string;
  fieldKey?: string;
  required?: boolean;
  options?: unknown;
  validationRules?: unknown;
}

// Minimal shape expandLayoutFields needs from a `form_builder_fields` row — satisfied by both
// FormBuilderSubmissionsService's SubmissionFieldRow and a narrower `.select(...)` row.
export interface LayoutExpandableField {
  field_key: string;
  field_type: string;
  label?: string | null;
  required?: boolean | null;
  is_hidden?: boolean | null;
  read_only?: boolean | null;
  options: unknown;
  validation_rules?: unknown;
}

export function expandLayoutFields<T extends LayoutExpandableField>(
  fields: T[],
): T[] {
  const allFields: T[] = [...fields];

  for (const layout of fields) {
    if (layout.field_type !== 'layout') continue;

    const cells =
      ((layout.options as { cells?: unknown } | null)?.cells as
        | Array<Array<LayoutCell>>
        | undefined) ?? [];

    cells.forEach((row, r) =>
      (row ?? []).forEach((cell, c) => {
        if (!cell?.type) return;

        allFields.push({
          ...layout,
          // Cells authored before they carried their own key fall back to the positional derivation, so
          // their already-stored answers stay readable. Must match resolveCellKey() on the client.
          field_key: cell.fieldKey || `${layout.field_key}__cell_r${r}_c${c}`,
          field_type: cell.type,
          label: cell.label ?? '',
          // Read the cell's own config instead of hardcoding. Every fallback is the previous hardcoded
          // value, so a legacy cell behaves exactly as before.
          required: cell.required ?? false,
          is_hidden: false,
          read_only: false,
          options: cell.options ?? null,
          validation_rules: cell.validationRules ?? null,
        } as T);
      }),
    );
  }

  return allFields;
}
