import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

// Fixed on purpose: the shared upload limits grow to gigabytes on-premise.
export const TEST_TRANSFER_LIMITS = {
  importRows: 1000,
  featureUploadBytes: 10 * 1024 * 1024,
  featureFileBytes: 2 * 1024 * 1024,
  zipBytes: 50 * 1024 * 1024,
  folderDepth: 8,
  featureScenarios: 1000,
  // Worst case per scenario: its own Rule with its own Background.
  featureBlocks: 3000,
  featureZipEntries: 1000,
  junitBytes: 10 * 1024 * 1024,
  junitTestcases: 5000,
  junitMessage: 4000,
  junitDepth: 32,
  resultFiles: 10,
  customFieldsText: 20000,
  customFieldKeys: 50,
} as const;

export const RESULT_FORMATS = [
  'cucumber',
  'behave',
  'junit',
  'testng',
  'xunit',
  'xray',
] as const;
export type ResultFormat = (typeof RESULT_FORMATS)[number];

export const RESULT_ATTACHMENT_NAMES: Record<ResultFormat, string> = {
  cucumber: 'cucumber-results.json',
  behave: 'behave-results.json',
  junit: 'junit-results.xml',
  testng: 'testng-results.xml',
  xunit: 'xunit-results.xml',
  xray: 'xray-results.json',
};

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** A .feature or .zip upload that creates or updates Cucumber test cases. */
export class FeatureImportOptionsDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Folder the feature folders start in',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID('all')
  folder_id?: string;
}

// Query strings arrive as text.
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export const FEATURE_EXPORT_SCOPES = [
  'space',
  'folder',
  'set',
  'plan',
  'execution',
  'case',
] as const;
export type FeatureExportScope = (typeof FEATURE_EXPORT_SCOPES)[number];

/** What a .feature export contains; every scope but space needs the id. */
export class FeatureExportQueryDto {
  @ApiProperty({ enum: FEATURE_EXPORT_SCOPES })
  @IsIn(FEATURE_EXPORT_SCOPES)
  scope: FeatureExportScope;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID('all')
  id?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  include_archived?: boolean;
}

export interface TransferIssue {
  row: number;
  code: string;
  message: string;

  // The value the problem is about, such as an unknown key, for translated messages.
  value?: string;

  // Where in the upload the problem is.
  file?: string;
  line?: number;
}

export interface FeatureImportRow {
  file: string;
  line: number;
  title: string;
  // exists: a test with this name is already in the folder, so nothing is created.
  action: 'create' | 'update' | 'unchanged' | 'exists' | 'error';
  case_key?: string;
}

/** Feature preview; nothing has been written. */
export interface FeatureImportPreview {
  file_name: string;
  files: number;
  scenarios: number;
  rows: FeatureImportRow[];
  errors: TransferIssue[];
  warnings: TransferIssue[];
}

export interface FeatureImportResult {
  created: { case_id: string; key: string }[];
  updated: { case_id: string; key: string }[];
  unchanged: number;
  preconditions_created: { id: string; key: string }[];
  requirements_added: number;
  errors: TransferIssue[];
  warnings: TransferIssue[];
}

export type JunitStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIPPED';

export interface ResultStep {
  status: 'TODO' | 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_APPLICABLE';
  actual_result: string | null;
  comment: string | null;
}

// One example of an outline or one Xray iteration; the status always comes from the file.
export interface ResultIteration {
  status: 'TODO' | JunitStatus;
  name?: string;
  parameters?: { name: string; value: string }[];
  comment?: string;
}

export interface ResultEvidence {
  name: string;
  size: number;
}

export interface JunitTestcase {
  name: string;
  classname: string;
  status: JunitStatus;
  duration_seconds: number | null;
  message: string | null;

  // How many results of the file were rolled up into this one.
  merged: number;

  // Cucumber and Behave items always have one; a JUnit test may not.
  test_key?: string;
  evidence?: ResultEvidence[];
  iterations?: ResultIteration[];

  // Read from TestNG, xUnit and Xray JSON files; absent for plain JUnit reports.
  requirement_keys?: string[];
  labels?: string[];
  summary?: string;
  description?: string;
  comment?: string;
  started_at?: string;
  finished_at?: string;
  steps?: ResultStep[];

  // Xray JSON only: defect tickets, and the type and definition for a test it creates.
  defect_keys?: string[];
  test_type?: string;
  definition?: string;
}

/** A report upload into an existing execution; the format is read from the file when left out. */
export class JunitCommitOptionsDto {
  @ApiPropertyOptional({ enum: RESULT_FORMATS })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsIn(RESULT_FORMATS)
  format?: ResultFormat;

  @ApiPropertyOptional({
    default: false,
    description:
      'Create test cases for tests without a test key (not Cucumber or Behave) the space does not have yet',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  create_unmatched?: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Folder for the test cases this upload creates',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID('all')
  folder_id?: string;

  @ApiPropertyOptional({
    description:
      'Labels added to the execution ticket, separated by commas or semicolons',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(5000)
  labels?: string;

  @ApiPropertyOptional({
    description:
      'JSON object of custom field keys and values for the execution ticket',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(TEST_TRANSFER_LIMITS.customFieldsText)
  custom_fields?: string;

  @ApiPropertyOptional({
    description:
      'Link the requirement tickets the report names to its test cases; on by default except for Cucumber and Behave',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  link_requirements?: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The automation run that started this CI job; its upload marks the run as finished',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID('all')
  automation_run_id?: string;
}

/** A report upload that starts its own execution. */
export class ResultImportOptionsDto extends JunitCommitOptionsDto {
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ maxLength: 10000 })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(10000)
  description?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Test plan the execution belongs to',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID('all')
  plan_id?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Test plan by its ticket key; plan_id wins when both are sent',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(100)
  plan_key?: string;

  @ApiPropertyOptional({
    description: 'Test environments, separated by commas or semicolons',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(1000)
  environments?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(100)
  revision?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(100)
  version?: string;
}

export interface JunitMatch extends JunitTestcase {
  run_id: string;
  case_id: string;
  case_key: string;
  case_title: string;
  current_status: string;
  new_attempt: boolean;
}

export interface JunitToAdd extends JunitTestcase {
  case_id: string;
  case_key: string;
  case_title: string;
}

export interface JunitAmbiguous extends JunitTestcase {
  candidates: string[];
}

export interface JunitInSpace extends JunitTestcase {
  case_key: string;
}

export interface JunitKeptRun {
  run_id: string;
  case_key: string;
  case_title: string;
  current_status: string;
  reason: 'not_in_file' | 'skipped';
}

export interface JunitEarlierUpload {
  version_number: number;
  uploaded_at: string;
  uploaded_by: string | null;
  original_name: string | null;
}

export interface JunitDuplicate {
  execution_id: string;
  execution_key: string;
  version_number: number | null;
}

/** What an upload would change; nothing has been written. */
export interface JunitPreview {
  sha256: string;
  file_name: string;
  testcases: number;
  matched: JunitMatch[];

  // Tests the file names that have no run in this execution yet; commit adds their runs.
  to_add: JunitToAdd[];

  // Not Cucumber or Behave: several runs have this title, so the file does not say which one it means.
  ambiguous?: JunitAmbiguous[];

  // Not Cucumber or Behave: no test of this space matches.
  unmatched?: JunitTestcase[];

  // Not Cucumber or Behave: the space has this test by automation key, but it has no run in this execution.
  in_space?: JunitInSpace[];
  invalid: TransferIssue[];
  kept: JunitKeptRun[];
  warnings: TransferIssue[];
  earlier_uploads: JunitEarlierUpload[];

  // Set when this file was applied before; commit would be refused.
  duplicate: JunitDuplicate | null;

  // The results are in but the file was not saved; commit only saves the file.
  already_applied: boolean;

  // A Cucumber report recorded here whose tests were all set back to To do; commit records it again.
  rerun: boolean;

  // That same report while some of its tests still have a result.
  reset_needed: boolean;
}

export interface JunitCommitResult {
  changed: boolean;
  applied: {
    run_id: string;
    status: string;
    attempt_no: number;
    new_attempt: boolean;
    attempt_id?: string;
  }[];
  added_runs: { run_id: string; case_id: string; key: string }[];

  // Not Cucumber or Behave: test cases this upload made.
  created_cases?: { case_id: string; key: string }[];
  file_saved: boolean;
  repaired: boolean;
  version_number: number | null;

  // Results in the file that reached no test; only set when there are some.
  dropped?: { count: number; names: string[] };
  warnings?: TransferIssue[];

  // Set when the upload created a new execution, or found the one an earlier try created; existing when it went to one the file or run named.
  execution?: {
    id: string;
    key: string;
    replayed: boolean;
    existing?: boolean;
  };
  evidence_saved?: number;
  evidence_failed?: number;
  requirements_added?: number;
  requirements_failed?: number;

  // Several files only: each file's own version; version_number and file_saved then speak for all of them.
  files?: {
    file_name: string;
    format: ResultFormat;
    version_number: number | null;
    file_saved: boolean;
  }[];

  // Set when the upload named an automation run and it was marked as finished.
  automation_run?: { closed: boolean };
}
