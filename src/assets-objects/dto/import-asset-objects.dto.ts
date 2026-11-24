import {
  IsString,
  IsNotEmpty,
  IsUUID,
  IsIn,
  IsOptional,
} from 'class-validator';

export class ImportAssetObjectsPreviewDto {
  // file is validated at controller level via FileInterceptor
}

/**
 * What to do when an incoming row matches an existing object.
 *
 * Omitted defaults to 'skip'. Creating duplicates is opt-in via 'create' — the reverse
 * default let a stale client reintroduce the exact bug this prevents.
 */
export const DUPLICATE_MODES = ['skip', 'update', 'create'] as const;

export type DuplicateMode = (typeof DUPLICATE_MODES)[number];

export class ImportAssetObjectsDto {
  @IsUUID()
  objectTypeId: string;

  /**
   * JSON-serialised array of column mappings.
   * Each entry: { fileColumn: string; fieldKey: string; delimiter?: string }
   * Special fieldKey values: '__name__' | '__description__' | '__object_key__'
   * delimiter is used for multiselect / object_reference (multi-cardinality) fields.
   */
  @IsString()
  @IsNotEmpty()
  mapping: string;

  @IsOptional()
  @IsIn(DUPLICATE_MODES)
  duplicateMode?: DuplicateMode;
}

export interface ColumnMapping {
  fileColumn: string;
  fieldKey: string;
  delimiter?: string;
}

export interface ImportError {
  row: number;
  field: string;
  message: string;
}

/** One object created by an import, echoed back so the caller can link straight to it. */
export interface CreatedKey {
  row: number;
  id: string;
  objectKey: string;
  name: string;
}

export interface ImportResult {
  imported: number;
  /** Rows matched to an existing object and patched. Only ever > 0 in 'update' mode. */
  updated: number;
  skipped: number;
  failed: number;
  errors: ImportError[];
  /** Capped at CREATED_KEYS_LIMIT entries; `imported` still carries the true total. */
  createdKeys?: CreatedKey[];
  /** True when more objects were created than the cap echoes back. */
  createdTruncated?: boolean;
}

/** What an import WOULD do, produced without writing anything. */
export interface ImportDryRunResult {
  totalRows: number;
  willCreate: number;
  willUpdate: number;
  willSkip: number;
  ambiguous: number;
  duplicateInFile: number;
  missingName: number;
  /** '__object_key__' | '__name__' | the attribute field_keys actually used for matching. */
  identityFields: string[];
  indexTruncated: boolean;
  dedupeEnabled: boolean;
}
