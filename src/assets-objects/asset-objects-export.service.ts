/**
 * @fileoverview Exports asset objects of one object type to csv / xls / xlsx.
 * @module src/assets-objects/asset-objects-export.service
 *
 * The file this produces is meant to go straight back through the import wizard,
 * so the column set and every value encoding mirror `asset-objects-import.service.ts`.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as XLSX from 'xlsx';

import { AssetObjectTypeAttributesService } from './asset-object-type-attributes.service';
import { AssetObjectTypesService } from './asset-object-types.service';
import { AssetObjectsService } from './asset-objects.service';

import type { IAssetFilterGroup } from './filtering/asset-filter.types';

export const EXPORT_FORMATS = ['csv', 'xls', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export type ExportSortField =
  | 'object_key'
  | 'name'
  | 'created_at'
  | 'updated_at';

const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * Mirrors NON_IMPORTABLE_TYPES in the import service — these columns cannot be
 * mapped back on import, so exporting them would produce a file that no longer
 * round-trips.
 */
const NON_EXPORTABLE_TYPES = new Set([
  'formula',
  'tab_separator',
  'user',
  'user_multi',
]);

/** PostgREST clamps every response to max_rows (1000), so a page cannot be larger. */
const PAGE_SIZE = 1000;

/** Refuse an oversized export rather than build the whole sheet in memory and OOM. */
const MAX_EXPORT_ROWS = 100_000;
const MAX_PAGES = MAX_EXPORT_ROWS / PAGE_SIZE;

/** Excel rejects any cell longer than this; the writer throws rather than clipping. */
const MAX_CELL_LENGTH = 32_767;

/** First candidate absent from every value in a column wins, so no value re-imports split. */
const MULTI_DELIMITERS = [',', ';', '|'] as const;

interface AttributeRow {
  field_key: string;
  name: string | null;
  data_type: string;
  sort_order: number | null;
}

interface ExportColumn {
  header: string;
  /** Base columns read the row directly; attributes read attribute_values[field_key]. */
  baseColumn?: 'object_key' | 'name' | 'description';
  fieldKey?: string;
  dataType?: string;
}

/** `partial` is only present on the bounded branch of `list()`, hence optional here. */
interface ListPage {
  data: Record<string, unknown>[];
  count: number;
  partial?: boolean;
}

@Injectable()
export class AssetObjectsExportService {
  private readonly logger = new Logger(AssetObjectsExportService.name);

  constructor(
    private readonly objectsService: AssetObjectsService,
    private readonly objectTypesService: AssetObjectTypesService,
    private readonly attributesService: AssetObjectTypeAttributesService,
  ) {}

  /**
   * Builds the download for every non-archived object of one object type.
   *
   * @param format - csv | xls | xlsx
   * @returns Buffer plus the headers the controller should set.
   * @throws BadRequestException On an unknown format, a missing object type, an
   * export above {@link MAX_EXPORT_ROWS}, or a read that could not see every row.
   */
  async exportObjects(
    schemaId: string,
    objectTypeId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
    format: string,
    sortField: ExportSortField = 'created_at',
    sortDirection: 'asc' | 'desc' = 'desc',
    search?: string,
    filter?: IAssetFilterGroup | null,
  ): Promise<{ buffer: Buffer; fileName: string; contentType: string }> {
    const resolvedFormat = this.resolveFormat(format);

    if (!objectTypeId) {
      throw new BadRequestException('objectTypeId is required to export');
    }

    const objectType = await this.objectTypesService.getOne(
      objectTypeId,
      spaceId,
      organizationId,
    );

    const columns = await this.buildColumns(
      objectTypeId,
      spaceId,
      organizationId,
    );

    const rows = await this.collectRows(
      schemaId,
      objectTypeId,
      spaceId,
      organizationId,
      userId,
      search,
      filter,
    );

    this.sortRows(rows, sortField, sortDirection);

    const buffer = this.writeWorkbook(
      this.buildSheet(rows, columns),
      resolvedFormat,
    );

    const typeName = this.toText(objectType['name']).trim() || 'asset-objects';
    const date = new Date().toISOString().slice(0, 10);

    return {
      buffer,
      fileName: `${typeName}_objects_${date}.${resolvedFormat}`,
      contentType: CONTENT_TYPES[resolvedFormat],
    };
  }

  private resolveFormat(format: string): ExportFormat {
    const candidate = (format ?? '').toLowerCase();

    if (!(EXPORT_FORMATS as readonly string[]).includes(candidate)) {
      throw new BadRequestException(
        `Unsupported export format "${format}". Use csv, xls or xlsx.`,
      );
    }

    return candidate as ExportFormat;
  }

  /** object_key, name, description, then every importable attribute by sort_order. */
  private async buildColumns(
    objectTypeId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<ExportColumn[]> {
    const attributes = (await this.attributesService.list(
      objectTypeId,
      spaceId,
      organizationId,
    )) as AttributeRow[];

    const columns: ExportColumn[] = [
      { header: 'Key', baseColumn: 'object_key' },
      { header: 'Name', baseColumn: 'name' },
      { header: 'Description', baseColumn: 'description' },
    ];

    for (const attr of attributes) {
      if (NON_EXPORTABLE_TYPES.has(attr.data_type)) continue;

      columns.push({
        header: (attr.name ?? '').trim() || attr.field_key,
        fieldKey: attr.field_key,
        dataType: attr.data_type,
      });
    }

    this.deduplicateHeaders(columns);

    return columns;
  }

  /**
   * Makes every header unique in place, suffixing repeats as `_2`, `_3`, …
   *
   * An attribute may legitimately be named "Name", which collides with the base
   * Name column. The import parser indexes columns by header text with no
   * de-duplication of its own, so a repeated header means the later column wins
   * and the earlier one is silently read as empty — the exported file would not
   * survive a round trip. Mirrors `deduplicateHeaders` in AssetObjectImportDialog.
   */
  private deduplicateHeaders(columns: ExportColumn[]): void {
    const seen = new Map<string, number>();

    for (const col of columns) {
      const count = seen.get(col.header) ?? 0;

      seen.set(col.header, count + 1);

      if (count > 0) col.header = `${col.header}_${count + 1}`;
    }
  }

  /**
   * Pages every matching row out of `AssetObjectsService.list()`.
   *
   * `list()` only paginates in SQL when the sort is created_at / updated_at AND the
   * filter can be pushed down; a natural sort or a memory-mode filter switches it to
   * a bounded read that ignores `page` and returns the same ≤1000 rows forever. So
   * the read always asks for the SQL-paged shape and the caller sorts afterwards.
   */
  private async collectRows(
    schemaId: string,
    objectTypeId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
    search?: string,
    filter?: IAssetFilterGroup | null,
  ): Promise<Record<string, unknown>[]> {
    const collected: Record<string, unknown>[] = [];
    const seenIds = new Set<string>();
    let total = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const result: ListPage = await this.objectsService.list(
        schemaId,
        objectTypeId,
        spaceId,
        organizationId,
        userId,
        page,
        PAGE_SIZE,
        'created_at',
        'asc',
        search,
        filter,
      );

      total = result.count;

      // The active filter has to be evaluated in JS, so the read was capped at
      // max_rows and rows beyond it were never seen. A short file would look
      // like a complete one, so refuse instead.
      if (result.partial) {
        throw new BadRequestException(
          'This export cannot be completed with the active filter — it needs more than 1000 rows to be read at once. Narrow the filter and try again.',
        );
      }

      if (total > MAX_EXPORT_ROWS) {
        throw new BadRequestException(
          `This export would contain ${total} objects, above the ${MAX_EXPORT_ROWS} limit. Narrow the selection with a filter or search.`,
        );
      }

      for (const row of result.data) {
        // created_at has no tiebreaker in list(), so rows sharing a timestamp can
        // repeat across pages. Dropping the repeat leaves the count short, which
        // the check below turns into a clear error instead of a wrong file.
        const id = this.toText(row['id']);

        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);

        collected.push(row);
      }

      if (result.data.length < PAGE_SIZE || collected.length >= total) break;
    }

    if (collected.length < total) {
      throw new BadRequestException(
        `Export read only ${collected.length} of ${total} objects and would be incomplete. Narrow the selection and try again.`,
      );
    }

    return collected;
  }

  private sortRows(
    rows: Record<string, unknown>[],
    sortField: ExportSortField,
    sortDirection: 'asc' | 'desc',
  ): void {
    const direction = sortDirection === 'asc' ? 1 : -1;

    // name / object_key hold numeric substrings the grid sorts naturally, so the
    // file has to match what the user saw on screen.
    const natural = sortField === 'name' || sortField === 'object_key';

    rows.sort((a, b) => {
      const aVal = this.toText(a[sortField]);
      const bVal = this.toText(b[sortField]);

      if (!natural) return direction * (aVal < bVal ? -1 : aVal > bVal ? 1 : 0);

      return (
        direction *
        aVal.localeCompare(bVal, undefined, {
          numeric: true,
          sensitivity: 'base',
        })
      );
    });
  }

  /** Array-of-arrays of strings only, so nothing is auto-typed by the writer. */
  private buildSheet(
    rows: Record<string, unknown>[],
    columns: ExportColumn[],
  ): string[][] {
    // Multi-values stay unjoined for now: the delimiter is chosen per column, and
    // that needs every value in the column first.
    const grid = rows.map((row) =>
      columns.map((col) => this.cellValue(row, col)),
    );

    const delimiters = columns.map((_col, index) => {
      const arrays = grid
        .map((row) => row[index])
        .filter((value): value is string[] => Array.isArray(value));

      return arrays.length ? this.pickDelimiter(arrays) : ',';
    });

    return [
      columns.map((col) => this.sanitizeCell(col.header)),
      ...grid.map((row) =>
        row.map((value, index) =>
          this.sanitizeCell(
            Array.isArray(value) ? value.join(delimiters[index]) : value,
          ),
        ),
      ),
    ];
  }

  private cellValue(
    row: Record<string, unknown>,
    col: ExportColumn,
  ): string | string[] {
    if (col.baseColumn) return this.formatScalar(row[col.baseColumn], 'text');

    const attributeValues = (row['attribute_values'] ?? {}) as Record<
      string,
      unknown
    >;
    const raw = attributeValues[col.fieldKey!];

    if (Array.isArray(raw)) {
      return raw.map((item) => this.formatScalar(item, col.dataType ?? 'text'));
    }

    return this.formatScalar(raw, col.dataType ?? 'text');
  }

  /**
   * Everything leaves as text so Excel cannot reinterpret it — a native date cell
   * re-imports as the wrong day, because the import parser tries MM/dd/yyyy before
   * dd/MM/yyyy and cannot tell which one a locale-rendered cell used.
   */
  private formatScalar(value: unknown, dataType: string): string {
    if (value === null || value === undefined) return '';

    switch (dataType) {
      case 'bool':
        if (typeof value === 'boolean') return value ? 'true' : 'false';

        return this.toText(value);

      case 'integer':
      case 'float':
        // Number->string is already dot-decimal with no thousands separator.
        return this.toText(value);

      case 'date':
        return this.toText(value).slice(0, 10);

      case 'datetime':
        return this.toText(value).replace(' ', 'T').slice(0, 16);

      default:
        return this.toText(value);
    }
  }

  /** JSON for anything non-primitive — String() would emit a useless '[object Object]'. */
  private toText(value: unknown): string {
    if (value === null || value === undefined) return '';

    if (typeof value === 'string') return value;

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    return JSON.stringify(value) ?? '';
  }

  private pickDelimiter(values: string[][]): string {
    for (const candidate of MULTI_DELIMITERS) {
      const collides = values.some((parts) =>
        parts.some((part) => part.includes(candidate)),
      );

      if (!collides) return candidate;
    }

    this.logger.warn(
      'Every multi-value delimiter appears inside a value; joining with "|" anyway',
    );

    return '|';
  }

  private sanitizeCell(value: string): string {
    // Formula injection: Excel and Sheets execute a cell whose text starts with
    // one of these, so the leading quote makes it inert text.
    //
    // A plain number is exempt: "-5" is not a formula, and quoting it would make
    // the importer's parseInt/parseFloat reject the value on the way back in,
    // which would break the export -> edit -> re-import round trip. "-5+cmd|..."
    // is not a plain number and is still guarded.
    const isPlainNumber = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(value);

    const guarded =
      !isPlainNumber && /^[=+\-@]/.test(value) ? `'${value}` : value;

    if (guarded.length <= MAX_CELL_LENGTH) return guarded;

    this.logger.warn(
      `Export cell exceeded ${MAX_CELL_LENGTH} characters and was truncated`,
    );

    return guarded.slice(0, MAX_CELL_LENGTH);
  }

  private writeWorkbook(aoa: string[][], format: ExportFormat): Buffer {
    const workbook = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(aoa),
      'Objects',
    );

    const buffer = XLSX.write(workbook, {
      type: 'buffer',
      bookType: format,
    }) as Buffer;

    // NOTE: do NOT prepend a UTF-8 BOM for csv. XLSX.write already emits one, and
    // a second BOM is fatal on re-import: the parser strips exactly one, then
    // decodes the survivor under codepage 65001, which swallows two characters of
    // the first header ("Key" arrives as "y"). Verified against the live parser.
    return buffer;
  }
}
