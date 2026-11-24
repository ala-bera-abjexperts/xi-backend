import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  type HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHash } from 'crypto';

import { AttachmentsService } from '../../../attachments/attachments.service';
import { AuditLogsService } from '../../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../../auth/interfaces/request-user.interface';
import { PermissionsService } from '../../../permissions/permissions.service';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../../access/test-management-access.service';
import { cleanLabels, TEST_CASE_LABEL_LIMITS } from '../../common/case-labels';
import { TaskVisibilityService } from '../../common/task-visibility.service';
import {
  userDisplayName,
  type UserNameRow,
} from '../../common/tester-eligibility.service';
import { ticketEmbed, ticketName } from '../../common/ticket-keys';
import { TEST_CASE_LIMITS } from '../../dto/test-case.dto';
import { TEST_COVERAGE_LIMITS } from '../../dto/test-coverage.dto';
import { TEST_EXECUTION_LIMITS } from '../../dto/test-execution.dto';
import {
  RESULT_ATTACHMENT_NAMES,
  TEST_TRANSFER_LIMITS,
  type JunitAmbiguous,
  type JunitCommitOptionsDto,
  type JunitCommitResult,
  type JunitDuplicate,
  type JunitEarlierUpload,
  type JunitInSpace,
  type JunitKeptRun,
  type JunitMatch,
  type JunitPreview,
  type JunitTestcase,
  type JunitToAdd,
  type ResultFormat,
  type ResultImportOptionsDto,
  type TransferIssue,
} from '../../dto/test-transfer.dto';
import { TestExecutionsService } from '../../executions/test-executions.service';
import { TestRequirementLinksService } from '../../requirements/test-requirement-links.service';
import { TestRunsService } from '../../runs/test-runs.service';
import {
  notFound,
  tmDbError,
  tmRpcError,
  type TmRpcError,
} from '../../test-management-errors';
import {
  assertCaseTicketsAllowed,
  caseImportError,
  fileError,
} from '../shared/transfer-helpers';
import {
  cutText,
  type EvidenceFile,
  type ParsedJunit,
  type XrayFileInfo,
} from './cucumber-json.parser';
import { mergeTestcases, parseResultFile } from './junit.parser';

// Keys looked up per request; keeps the request URL short.
const KEY_CHUNK = 100;

// Test names can be long, so fewer of them fit in one request URL.
const NAME_CHUNK = 20;

// The most test cases the move function takes at once.
const MOVE_CHUNK = 500;
const DROPPED_NAMES = 50;
const INVALID_SHOWN = 50;

// Fixed caps per upload, so one file cannot fill the storage.
const EVIDENCE_MAX_FILES = 50;
const EVIDENCE_MAX_BYTES = 50 * 1024 * 1024;
const FILE_NAME_LENGTH = 255;

export const FORMAT_LABELS: Record<ResultFormat, string> = {
  cucumber: 'Cucumber JSON',
  behave: 'Behave JSON',
  junit: 'JUnit',
  testng: 'TestNG',
  xunit: 'xUnit',
  xray: 'Xray JSON',
};

// Only Cucumber and Behave results always carry a test key; the other formats may not.
const keyless = (format: ResultFormat) =>
  format !== 'cucumber' && format !== 'behave';

// What the database function reports per run, and the issue each reason becomes.
const APPLY_WARNINGS: Record<string, { code: string; message: string }> = {
  steps_mismatch: {
    code: 'STEPS_MISMATCH',
    message: 'the file has a different number of steps than the test',
  },
  steps_ignored: {
    code: 'STEPS_IGNORED',
    message: 'the test has no steps, so the step results were not recorded',
  },
  times_ignored: {
    code: 'TIMES_IGNORED',
    message: 'the start and finish times could not be read',
  },
};

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
};

interface KeyedCase {
  id: string;
  key: string;
  title: string;
  is_archived: boolean;
  readiness: string;
}

interface ExecutionRow {
  id: string;
  key: string;
  is_archived: boolean;
  import_sha256: string | null;
}

interface RunRow {
  id: string;
  case_id: string;
  current_attempt_no: number;
  case: { key: string; title: string; automation_key: string | null } | null;
  attempts:
    | {
        attempt_no: number;
        status: string;
        status_overridden: boolean;
        comment: string | null;
        actual_minutes: number | null;
        step_results: Record<string, unknown> | null;
      }[]
    | null;
}

interface AttachmentRow {
  id: string;
  entity_id: string;
  file_name: string;
  checked_out_by: string | null;
}

interface VersionRow {
  attachment_id: string;
  version_number: number;
  uploaded_at: string;
  comment: string | null;
  uploader: UserNameRow | null;
}

interface ApplyResult {
  changed: boolean;
  applied: JunitCommitResult['applied'];
  added_runs: JunitCommitResult['added_runs'];
  created_cases: NonNullable<JunitCommitResult['created_cases']>;
  skipped: { automation_key?: string; key?: string; reason: string }[];
  warnings?: { run_id: string; reason: string }[];
}

// A result no run of this execution claims, and the automation key it would use.
interface OptIn {
  item: JunitTestcase;
  key: string;

  // Set when the key already belongs to a test case of the space.
  caseId?: string;
  caseKey?: string;
}

// One file of an upload.
interface ReportPart {
  file: Express.Multer.File;
  sha256: string;
  format: ResultFormat;

  // Several files only: already kept on this execution from this same upload.
  kept: boolean;
}

interface ReadReport {
  parts: ReportPart[];
  parsed: ParsedJunit & { format: ResultFormat };

  // The file's own sha256, or for several files the sha256 of their sorted sha256s.
  sha256: string;
  batch: boolean;
  warnings: TransferIssue[];

  // Several files only: every file was already recorded elsewhere.
  duplicate: JunitDuplicate | null;
}

interface Prepared {
  // The first file's format; a batch may mix formats, see parts.
  format: ResultFormat;
  parts: ReportPart[];
  batch: boolean;
  label: string;
  keyless: boolean;
  execution: ExecutionRow;
  sha256: string;
  preview: JunitPreview;
  thisAttachment: AttachmentRow | null;
  attachments: AttachmentRow[];
  runCount: number;
  evidence: Map<string, EvidenceFile[]>;
  optIn: OptIn[];
}

interface TicketFields {
  labels: string[];
  customFields: Record<string, unknown>;

  // More than 50 labels, or one longer than 100 characters, were sent.
  trimmed: boolean;
}

// Field keys are made from names; a leading letter or digit also rules out __proto__ and the like.
const CUSTOM_FIELD_KEY = /^[a-z0-9][a-z0-9_]{0,99}$/;

/** Labels and custom fields for the execution ticket; null when the upload sends none. Bad JSON is a 400. */
function ticketFieldsOf(options: JunitCommitOptionsDto): TicketFields | null {
  const raw = [
    ...new Set(
      (options.labels ?? '')
        .split(/[,;]/)
        .map((label) => label.trim())
        .filter((label) => label !== ''),
    ),
  ];
  const labels = cleanLabels(raw);
  let customFields: Record<string, unknown> = {};

  if (options.custom_fields !== undefined) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(options.custom_fields);
    } catch {
      parsed = undefined;
    }

    const keys =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.keys(parsed)
        : null;

    if (
      !keys ||
      keys.length > TEST_TRANSFER_LIMITS.customFieldKeys ||
      keys.some((key) => !CUSTOM_FIELD_KEY.test(key))
    ) {
      throw new BadRequestException({
        code: 'CUSTOM_FIELDS_INVALID',
        message: `custom_fields must be a JSON object with at most ${TEST_TRANSFER_LIMITS.customFieldKeys} field keys of lowercase letters, digits and _`,
        field: 'custom_fields',
      });
    }

    customFields = parsed as Record<string, unknown>;
  }

  return labels.length > 0 || Object.keys(customFields).length > 0
    ? {
        labels,
        customFields,
        trimmed:
          raw.length > TEST_CASE_LABEL_LIMITS.perCase ||
          raw.some((label) => label.length > TEST_CASE_LABEL_LIMITS.length),
      }
    : null;
}

// A result's target for requirement links.
interface LinkTarget {
  caseId: string;
  item: JunitTestcase;
}

const KEPT_REPORT_TIMEOUT_MS = 30_000;

interface CommitMode {
  addInSpace?: boolean;
  noRerun?: boolean;
  keptVersion?: number;
  // A run from one test case records that case's result, and no other result reaches anything.
  only_case_id?: string;
}

const sha256Of = (buffer: Buffer) =>
  createHash('sha256').update(buffer).digest('hex');

const shaTag = (sha: string) => `sha256:${sha}`;

const batchTag = (sha: string) => `batch:${sha}`;

// Every format but Cucumber and Behave can name requirements, so linking is on for them unless the upload says otherwise.
const linksByDefault = (parts: ReportPart[]) =>
  parts.some((part) => keyless(part.format));

function labelOf(parts: ReportPart[]): string {
  return [...new Set(parts.map((part) => FORMAT_LABELS[part.format]))].join(
    ' + ',
  );
}

/** Each file once, by its sha256; a file sent twice in one upload only warns. */
function uniqueFiles(files: Express.Multer.File[]): {
  parts: { file: Express.Multer.File; sha256: string }[];
  repeated: TransferIssue[];
} {
  const seen = new Set<string>();
  const parts: { file: Express.Multer.File; sha256: string }[] = [];
  const repeated: TransferIssue[] = [];

  for (const file of files) {
    const sha256 = sha256Of(file.buffer);

    if (seen.has(sha256)) {
      repeated.push({
        row: 0,
        code: 'FILE_REPEATED',
        message: `${file.originalname} is the same file as another one of this upload, so it was read once`,
        value: file.originalname,
        file: file.originalname,
      });
    } else {
      seen.add(sha256);
      parts.push({ file, sha256 });
    }
  }

  return { parts, repeated };
}

/** One file keeps its own sha256; several are fingerprinted by their sorted sha256s, so their order never matters. */
function uploadSha(parts: { sha256: string }[]): string {
  return parts.length === 1
    ? parts[0].sha256
    : createHash('sha256')
        .update(
          parts
            .map((part) => part.sha256)
            .sort()
            .join('\n'),
        )
        .digest('hex');
}

// The fields a Xray file gives a new execution, as they appear in its not-stored warning.
const INFO_WARNING_NAMES: Record<
  keyof Omit<XrayFileInfo, 'execution_key'>,
  string
> = {
  summary: 'info.summary',
  description: 'info.description',
  version: 'info.version',
  revision: 'info.revision',
  test_plan_key: 'info.testPlanKey',
  test_environments: 'info.testEnvironments',
};

/** The not-stored warning without the file's fields this upload did use. */
function withoutUsedFields(
  warnings: TransferIssue[],
  used: string[],
): TransferIssue[] {
  if (used.length === 0) return warnings;

  return warnings.flatMap((warning) => {
    if (warning.code !== 'FIELD_NOT_STORED' || !warning.value) {
      return [warning];
    }

    const left = warning.value.split(', ').filter((f) => !used.includes(f));

    return left.length === 0
      ? []
      : [
          {
            ...warning,
            message: `These fields of the file are not stored: ${left.join(', ')}`,
            value: left.join(', '),
          },
        ];
  });
}

const mediaTypeOf = (name: string): string =>
  MEDIA_TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ??
  'application/octet-stream';

// The same space and file give the same id, so a retried upload finds its execution again.
function requestIdFor(spaceId: string, sha256: string): string {
  const h = createHash('sha1')
    .update(`test-results:${spaceId}:${sha256}`)
    .digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);

  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function importName(label: string): string {
  const at = new Date().toISOString().slice(0, 16).replace('T', ' ');

  return `${label} import ${at} UTC`;
}

const joinText = (...parts: (string | null | undefined)[]): string | null =>
  parts.filter((p): p is string => !!p).join('\n') || null;

// The database reads a result's comment only from its message, so the file's comment follows it.
function resultMessage(item: JunitTestcase): string | null {
  const text = joinText(item.message, item.comment);

  return text === null
    ? null
    : cutText(text, TEST_TRANSFER_LIMITS.junitMessage);
}

function withoutSteps<T extends JunitTestcase>(item: T): T {
  if (!item.steps) return item;

  const rest = { ...item };

  delete rest.steps;

  return rest;
}

/** Environments as one value: trimmed, without case-insensitive duplicates, sorted, at most 100 characters. */
function normaliseEnvironments(raw: string | undefined): string | null {
  const seen = new Map<string, string>();

  for (const part of (raw ?? '').split(/[,;]/)) {
    const env = part.trim();

    if (env !== '' && !seen.has(env.toLowerCase())) {
      seen.set(env.toLowerCase(), env);
    }
  }

  const value = [...seen.values()]
    .sort((a, b) => a.localeCompare(b))
    .join(', ');

  if (value.length > TEST_EXECUTION_LIMITS.environment) {
    throw new BadRequestException({
      code: 'ENVIRONMENT_TOO_LONG',
      message: 'The environments together are longer than 100 characters',
    });
  }

  return value === '' ? null : value;
}

const EXECUTION_FIELDS = [
  'name',
  'description',
  'plan_id',
  'plan_key',
  'environments',
  'revision',
  'version',
] as const;

// A repaired upload records nothing, so its ticket fields are not written either.
const REPLAY_FIELDS = [...EXECUTION_FIELDS, 'labels', 'custom_fields'] as const;

/** Form fields an upload did not use, named in a warning instead of being dropped silently. */
function ignoredFields(
  dto: ResultImportOptionsDto,
  why: string,
  names: readonly (keyof ResultImportOptionsDto)[] = EXECUTION_FIELDS,
  code = 'FORM_FIELDS_IGNORED',
): TransferIssue[] {
  const used = names.filter((n) => dto[n] !== undefined && dto[n] !== '');

  return used.length === 0
    ? []
    : [
        {
          row: 0,
          code,
          message: `${why}, so these fields were not used: ${used.join(', ')}`,
          value: used.join(', '),
        },
      ];
}

function testKeyIssue(
  item: JunitTestcase,
  key: string,
  found: KeyedCase | undefined,
): TransferIssue {
  const [code, reason] = !found
    ? ['TEST_KEY_UNKNOWN', 'no test case has this key in this space']
    : found.is_archived
      ? ['TEST_KEY_ARCHIVED', 'the test case is archived']
      : ['TEST_KEY_DEPRECATED', 'the test case is deprecated'];

  return {
    row: 0,
    code,
    message: `${item.name}: ${key} — ${reason}`,
    value: key,
  };
}

const usable = (found: KeyedCase | undefined): found is KeyedCase =>
  Boolean(found && !found.is_archived && found.readiness !== 'deprecated');

const fullKey = (t: JunitTestcase) =>
  t.classname ? `${t.classname}.${t.name}` : t.name;

const recordable = (t: JunitTestcase) => t.status !== 'SKIPPED';

const testKeysOf = (items: JunitTestcase[]): string[] =>
  items.flatMap((i) => (i.test_key ? [i.test_key] : []));

interface SpaceTestType {
  id: string;
  kind: string;
  name?: string;
}

// The space's Exploratory type a file names, by its id or name or by Xray's standard type name.
const exploratoryType = (
  item: JunitTestcase,
  types: SpaceTestType[],
): SpaceTestType | undefined => {
  const wanted = item.test_type?.trim().toLowerCase();

  if (!wanted) return undefined;

  const exploratory = types.filter(
    (t) => typeof t?.id === 'string' && t.kind === 'exploratory',
  );

  return (
    exploratory.find(
      (t) =>
        t.id.toLowerCase() === wanted ||
        (typeof t.name === 'string' && t.name.toLowerCase() === wanted),
    ) ?? (wanted === 'exploratory' ? exploratory[0] : undefined)
  );
};

// An Exploratory test keeps its type, charter and summary; every other new test stays Generic.
// Without a Generic type the database falls back to Manual, which a warning names.
const newCaseType = (
  item: JunitTestcase,
  types: SpaceTestType[],
  generic: string | undefined,
) => {
  const exploratory = exploratoryType(item, types);

  if (exploratory) {
    return {
      test_type: exploratory.id,
      ...(item.definition ? { definition: item.definition } : {}),
      ...(item.summary ? { title: item.summary } : {}),
    };
  }

  return generic ? { test_type: generic, definition: fullKey(item) } : {};
};

// The refusal of a file with nothing to record names the tests that matched nothing.
const notMatched = (items: JunitTestcase[]): TransferIssue[] =>
  items.filter(recordable).map((item) => ({
    row: 0,
    code: 'TEST_NOT_MATCHED',
    message: `${fullKey(item)}: no test here matches this result`,
    value: fullKey(item),
  }));

// Two results for one test: the stronger status goes first, so its name and message lead.
function mergeWinnerFirst(a: JunitTestcase, b: JunitTestcase): JunitTestcase {
  const merged = mergeTestcases(a, b);

  return merged.status === b.status && b.status !== a.status
    ? mergeTestcases(b, a)
    : merged;
}

/** One result per test: results sharing an automation key, or naming a test already added by test key. */
function mergeDuplicates(p: {
  toAdd: Map<string, JunitToAdd>;
  optIn: OptIn[];
  inSpace: JunitInSpace[];
  unmatched: JunitTestcase[];
}): {
  optIn: OptIn[];
  inSpace: JunitInSpace[];
  unmatched: JunitTestcase[];
  merges: TransferIssue[];
} {
  const merges: TransferIssue[] = [];
  const note = (label: string) =>
    merges.push({
      row: 0,
      code: 'DUPLICATE_MERGED',
      message: `${label}: several results in the file name this test; they were recorded as one result`,
      value: label,
    });
  const byKey = new Map<string, OptIn>();

  for (const o of p.optIn) {
    const earlier = byKey.get(o.key);

    if (earlier) {
      earlier.item = mergeWinnerFirst(earlier.item, o.item);
      note(o.caseKey ?? o.key);
    } else byKey.set(o.key, { ...o });
  }

  for (const [key, o] of byKey) {
    const target = o.caseId ? p.toAdd.get(o.caseId) : undefined;

    if (!target) continue;

    p.toAdd.set(target.case_id, {
      ...mergeWinnerFirst(target, o.item),
      case_id: target.case_id,
      case_key: target.case_key,
      case_title: target.case_title,
    });
    byKey.delete(key);
    note(target.case_key);
  }

  const optIn = [...byKey.values()];
  const byCaseKey = new Map(
    optIn.flatMap((o) => (o.caseKey ? [[o.caseKey, o] as const] : [])),
  );
  const seen = new Set<string>();

  return {
    optIn,
    merges,
    inSpace: p.inSpace.flatMap((entry) => {
      const o = byCaseKey.get(entry.case_key);

      if (!o || seen.has(entry.case_key)) return [];
      seen.add(entry.case_key);

      return [{ ...entry, ...o.item, case_key: entry.case_key }];
    }),
    unmatched: p.unmatched.flatMap((item) => {
      const o = byKey.get(fullKey(item));

      if (!o) return [item];
      if (seen.has(`ak:${o.key}`)) return [];
      seen.add(`ak:${o.key}`);

      return [o.item];
    }),
  };
}

/** One file of several; a file that can't be read refuses the whole upload and is named. */
function readFile(
  file: Express.Multer.File,
  format: ResultFormat | undefined,
  keepEvidence: boolean,
): ParsedJunit & { format: ResultFormat } {
  try {
    return parseResultFile(file.buffer, { format, keepEvidence });
  } catch (error) {
    if (!(error instanceof BadRequestException)) throw error;

    const body = error.getResponse();
    const response =
      typeof body === 'object' && body !== null
        ? (body as { code?: string; message?: string; data?: object })
        : {};

    throw new BadRequestException({
      ...response,
      message: `${file.originalname}: ${response.message ?? error.message}`,
      data: { ...(response.data ?? {}), file: file.originalname },
    });
  }
}

function nothingToApply(invalid: TransferIssue[]): BadRequestException {
  return new BadRequestException({
    code: 'NOTHING_TO_APPLY',
    message: 'No test in this file has a result to record',
    data: { invalid: invalid.slice(0, INVALID_SHOWN) },
  });
}

function tooManyRuns(): BadRequestException {
  return new BadRequestException({
    code: 'RESULT_TOO_MANY_RUNS',
    message: `An execution can hold at most ${TEST_EXECUTION_LIMITS.runs} tests`,
  });
}

// "Uploaded as <name> · sha256:<hex>", or "Uploaded as <name> · batch:<hex> · sha256:<hex>" for one of several files.
function originalName(comment: string | null): string | null {
  const match = comment?.match(
    /^Uploaded as (.*?)(?: · batch:[0-9a-f]{64})? · sha256:[0-9a-f]{64}$/,
  );

  return match ? match[1] : null;
}

function untouched(run: RunRow): boolean {
  const attempt = run.attempts?.find(
    (a) => a.attempt_no === run.current_attempt_no,
  );

  return Boolean(
    attempt &&
    attempt.status === 'TODO' &&
    !attempt.status_overridden &&
    attempt.comment === null &&
    attempt.actual_minutes === null &&
    Object.keys(attempt.step_results ?? {}).length === 0,
  );
}

function currentStatus(run: RunRow): string {
  return (
    run.attempts?.find((a) => a.attempt_no === run.current_attempt_no)
      ?.status ?? 'TODO'
  );
}

/**
 * Cucumber, Behave, JUnit, TestNG, xUnit and Xray JSON report uploads. Each one is kept
 * as a new version of the execution's results attachment; its sha256 in the version comment refuses the same file twice.
 */
@Injectable()
export class CucumberResultsService {
  private readonly logger = new Logger(CucumberResultsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly permissions: PermissionsService,
    private readonly attachments: AttachmentsService,
    private readonly auditLogs: AuditLogsService,
    private readonly testRuns: TestRunsService,
    private readonly executions: TestExecutionsService,
    private readonly visibility: TaskVisibilityService,
    private readonly requirements: TestRequirementLinksService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async preview(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    file: Express.Multer.File,
    format?: ResultFormat,
  ): Promise<JunitPreview> {
    return this.previewMany(user, spaceId, executionId, [file], format);
  }

  /** Several report files read as one upload; one file is exactly a single upload. */
  async previewMany(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    files: Express.Multer.File[],
    format?: ResultFormat,
  ): Promise<JunitPreview> {
    const { preview } = await this.prepare(
      user,
      spaceId,
      executionId,
      files,
      format,
    );

    // Step results are only for the database; a preview stays small.
    return {
      ...preview,
      matched: preview.matched.map(withoutSteps),
      to_add: preview.to_add.map(withoutSteps),
      ...(preview.ambiguous
        ? { ambiguous: preview.ambiguous.map(withoutSteps) }
        : {}),
      ...(preview.unmatched
        ? { unmatched: preview.unmatched.map(withoutSteps) }
        : {}),
      ...(preview.in_space
        ? { in_space: preview.in_space.map(withoutSteps) }
        : {}),
    };
  }

  /** What the Cucumber report kept on this execution would change; writes nothing. */
  async previewKept(
    user: RequestUser,
    spaceId: string,
    executionId: string,
  ): Promise<JunitPreview> {
    const { file } = await this.keptReport(user, spaceId, executionId);

    return this.preview(user, spaceId, executionId, file, 'cucumber');
  }

  /** Records the Cucumber report kept on this execution again, under the same rules as an upload. */
  async commitKept(
    user: RequestUser,
    spaceId: string,
    executionId: string,
  ): Promise<JunitCommitResult> {
    const { file, version } = await this.keptReport(user, spaceId, executionId);

    return this.commit(
      user,
      spaceId,
      executionId,
      file,
      { format: 'cucumber' },
      { keptVersion: version },
    );
  }

  private async keptReport(
    user: RequestUser,
    spaceId: string,
    executionId: string,
  ): Promise<{ file: Express.Multer.File; version: number }> {
    const organizationId = user.organizationId;

    await this.access.assertAvailable(organizationId, spaceId, { write: true });

    const { data, error } = await this.client
      .from('file_attachments')
      .select('id')
      .eq('entity_type', 'test_execution')
      .eq('entity_id', executionId)
      .eq('file_name', RESULT_ATTACHMENT_NAMES.cucumber)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'find the kept report', error);

    if (!data) {
      throw new ConflictException({
        code: 'KEPT_REPORT_MISSING',
        message: 'This execution has no kept Cucumber report',
      });
    }

    await this.assertKeptNotMixed(
      organizationId,
      spaceId,
      executionId,
      (data as { id: string }).id,
    );

    const unreadable = () =>
      new ConflictException({
        code: 'KEPT_REPORT_UNREADABLE',
        message: 'The kept report could not be read. Upload the file instead.',
      });

    try {
      const { signedUrl, versionNumber } =
        await this.attachments.getDownloadInfo({
          attachmentId: (data as { id: string }).id,
          user,
        });

      // Local storage answers with a path only, which the server has to complete itself.
      const response = await fetch(
        new URL(signedUrl, process.env.SUPABASE_URL),
        { signal: AbortSignal.timeout(KEPT_REPORT_TIMEOUT_MS) },
      );

      if (!response.ok) throw unreadable();

      const buffer = Buffer.from(await response.arrayBuffer());

      return {
        version: versionNumber,
        file: {
          buffer,
          size: buffer.length,
          originalname: RESULT_ATTACHMENT_NAMES.cucumber,
          mimetype: 'application/json',
        } as Express.Multer.File,
      };
    } catch (err) {
      this.logger.warn(
        `Kept report of execution ${executionId} was not read: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );

      throw unreadable();
    }
  }

  /** A Cucumber report sent together with other formats holds only part of that upload's results. */
  private async assertKeptNotMixed(
    organizationId: string,
    spaceId: string,
    executionId: string,
    attachmentId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('file_versions')
      .select('comment')
      .eq('attachment_id', attachmentId)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle<{ comment: string | null }>();

    if (error) throw tmDbError(this.logger, 'load the kept report', error);

    const batch = /batch:([0-9a-f]{64})/.exec(data?.comment ?? '')?.[1];

    if (!batch) return;

    const others = (
      await this.resultAttachments(organizationId, spaceId)
    ).filter(
      (a) =>
        a.entity_id === executionId &&
        a.file_name !== RESULT_ATTACHMENT_NAMES.cucumber,
    );

    if (others.length === 0) return;

    const { data: hits, error: hitError } = await this.client
      .from('file_versions')
      .select('attachment_id')
      .in(
        'attachment_id',
        others.map((a) => a.id),
      )
      .like('comment', `%${batchTag(batch)}%`)
      .limit(1);

    if (hitError)
      throw tmDbError(this.logger, 'load the kept report', hitError);

    if ((hits ?? []).length > 0) {
      throw new ConflictException({
        code: 'KEPT_REPORT_MIXED',
        message:
          'The kept Cucumber report came with reports of other formats, so it holds only part of those results. Upload the files instead.',
      });
    }
  }

  // Only changes a row still holding the expected value, so another upload's mark is never lost.
  private async setImportMark(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    value: string | null,
    expected: string | null,
  ): Promise<void> {
    const query = this.client
      .from('test_executions')
      .update({ import_sha256: value })
      .eq('id', executionId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId);
    const { error } = await (expected === null
      ? query.is('import_sha256', null)
      : query.eq('import_sha256', expected));

    if (error) throw tmDbError(this.logger, 'update the report mark', error);
  }

  async commit(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    file: Express.Multer.File,
    options: JunitCommitOptionsDto,
    // A new execution has no runs yet, so tests the space already has are added without opt-in.
    mode: CommitMode = {},
  ): Promise<JunitCommitResult> {
    return this.commitMany(user, spaceId, executionId, [file], options, mode);
  }

  /** Several report files recorded as one upload; one file is exactly a single upload. */
  async commitMany(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    files: Express.Multer.File[],
    options: JunitCommitOptionsDto,
    mode: CommitMode = {},
  ): Promise<JunitCommitResult> {
    // Checked first, so a bad value is refused before anything is recorded.
    const ticketFields = ticketFieldsOf(options);
    const prepared = await this.prepare(
      user,
      spaceId,
      executionId,
      files,
      options.format,
      true,
      !mode.noRerun,
      mode.only_case_id,
    );
    const { execution, sha256, preview, label } = prepared;

    for (const format of new Set(prepared.parts.map((part) => part.format))) {
      const attachment = this.attachmentOf(prepared, executionId, format);

      if (
        attachment?.checked_out_by &&
        attachment.checked_out_by !== user.userId
      ) {
        throw new ConflictException({
          code: 'ATTACHMENT_LOCKED',
          message: `The ${FORMAT_LABELS[format]} results file of this execution is checked out by someone else`,
        });
      }
    }

    if (preview.duplicate) throw this.alreadyApplied(preview.duplicate, label);

    // Results were applied but the file was not saved last time: save it now, apply nothing.
    if (preview.already_applied) {
      const saved = await this.saveParts(user, executionId, prepared, true);

      if (saved.version !== null) {
        void this.auditLogs.logActionForRequest(
          user,
          'test_execution',
          executionId,
          'update',
          {
            action: 'results_repaired',
            format: prepared.batch
              ? prepared.parts.map((part) => part.format)
              : prepared.format,
          },
        );
      }

      return {
        changed: false,
        applied: [],
        added_runs: [],
        file_saved: saved.version !== null,
        repaired: saved.version !== null,
        version_number: saved.version,
        ...(saved.files ? { files: saved.files } : {}),
      };
    }

    // Only results that can lack a test key can create tests, so the option means nothing for the others.
    const optIn =
      options.create_unmatched === true &&
      prepared.keyless &&
      !mode.only_case_id;

    if (optIn) await this.assertCanCreate(user, spaceId, options.folder_id);

    const unclaimed = prepared.optIn.filter((o) => recordable(o.item));
    const toAdd: JunitToAdd[] = [
      ...preview.to_add,
      ...(mode.addInSpace && !mode.only_case_id
        ? unclaimed.flatMap((o) =>
            o.caseId && o.caseKey
              ? [
                  {
                    ...o.item,
                    case_id: o.caseId,
                    case_key: o.caseKey,
                    case_title: o.item.name,
                  },
                ]
              : [],
          )
        : []),
    ];

    // Resolved by automation key in the database function, which makes the case when none has it.
    const byAutomationKey = optIn
      ? unclaimed.filter((o) => !(mode.addInSpace && o.caseId))
      : [];
    const creating = byAutomationKey.some((o) => !o.caseId);

    if (
      preview.matched.length === 0 &&
      toAdd.length === 0 &&
      byAutomationKey.length === 0
    ) {
      throw nothingToApply([
        ...preview.invalid,
        ...notMatched([
          ...(preview.unmatched ?? []),
          ...(preview.in_space ?? []),
          ...(preview.ambiguous ?? []),
        ]),
      ]);
    }

    if (
      prepared.runCount + toAdd.length + byAutomationKey.length >
      TEST_EXECUTION_LIMITS.runs
    ) {
      throw tooManyRuns();
    }

    if (creating) {
      await assertCaseTicketsAllowed(
        this.client,
        this.logger,
        this.permissions,
        user,
        spaceId,
      );
    }

    const testTypes = creating
      ? await this.spaceTestTypes(user.organizationId, spaceId)
      : [];
    const generic = testTypes.find((t) => t.kind === 'unstructured')?.id;
    const warnings: TransferIssue[] = [...preview.warnings];
    const added = await this.addKeyedRuns(
      user,
      spaceId,
      executionId,
      toAdd,
      warnings,
    );
    const toItem = (item: JunitTestcase, runId: string) => ({
      status: item.status,
      duration_seconds: item.duration_seconds,
      run_id: runId,
      automation_key: null,
      title: item.name,
      message: resultMessage(item),
      ...(item.iterations?.length ? { iterations: item.iterations } : {}),
      ...(item.steps?.length ? { steps: item.steps } : {}),
      ...(item.started_at ? { started_at: item.started_at } : {}),
      ...(item.finished_at ? { finished_at: item.finished_at } : {}),
    });
    const items = [
      ...preview.matched.map((m) => toItem(m, m.run_id)),
      ...added.map((a) => toItem(a.item, a.runId)),
      ...byAutomationKey.map((o) => ({
        status: o.item.status,
        duration_seconds: o.item.duration_seconds,
        run_id: null,
        automation_key: o.key,
        title: o.item.name,
        message: resultMessage(o.item),
        ...newCaseType(o.item, testTypes, generic),
      })),
    ];

    // Every named test went away meanwhile; the file must stay free for a later upload.
    if (items.length === 0) throw nothingToApply(preview.invalid);

    // The database function refuses its own last file, and this one was reset on purpose.
    const clearedMark = preview.rerun && execution.import_sha256 === sha256;

    if (clearedMark) {
      await this.setImportMark(user, spaceId, executionId, null, sha256);
    }

    const { data, error } = (await this.client.rpc('tm_apply_junit', {
      p_organization_id: user.organizationId,
      p_space_id: spaceId,
      p_actor_id: user.userId,
      p_execution_id: executionId,
      p_sha256: sha256,
      p_results: items,
      p_create_unmatched: optIn,
    })) as { data: ApplyResult; error: TmRpcError | null };

    if (error) {
      if (clearedMark) {
        await this.setImportMark(user, spaceId, executionId, sha256, null);
      }

      throw await this.applyError(user, spaceId, sha256, error, label);
    }

    const caseKeys = new Map<string, string>([
      ...preview.matched.map((m) => [m.run_id, m.case_key] as const),
      ...added.map((a) => [a.runId, a.item.case_key] as const),
    ]);

    for (const w of data.warnings ?? []) {
      const known = APPLY_WARNINGS[w.reason];

      if (!known) continue;

      const key = caseKeys.get(w.run_id) ?? w.run_id;

      warnings.push({
        row: 0,
        code: known.code,
        message: `${key}: ${known.message}`,
        value: key,
      });
    }

    const applied = {
      changed: data.changed,
      applied: data.applied,
      added_runs: [
        ...added.map((a) => ({
          run_id: a.runId,
          case_id: a.item.case_id,
          key: a.item.case_key,
        })),
        ...data.added_runs,
      ],
    };

    // Runs the database function made skip addRuns, which is what normally updates the plan.
    if (data.added_runs.length > 0) {
      const sync = await this.testRuns.addToPlan(
        user,
        spaceId,
        executionId,
        data.added_runs.map((r) => r.case_id),
      );

      if (
        sync &&
        sync !== 'ok' &&
        !warnings.some((w) => w.code === 'PLAN_NOT_UPDATED')
      ) {
        warnings.push({
          row: 0,
          code: 'PLAN_NOT_UPDATED',
          message: 'The tests were recorded, but the test plan was not updated',
        });
      }
    }

    if (data.created_cases.length > 0) {
      if (!generic) {
        warnings.push({
          row: 0,
          code: 'GENERIC_TYPE_MISSING',
          message:
            'This space has no Generic test type, so the new test cases were created as Manual',
        });
      }

      if (options.folder_id) {
        await this.moveCreatedCases(
          user,
          spaceId,
          data.created_cases.map((c) => c.case_id),
          options.folder_id,
          warnings,
        );
      }
    }

    // A kept report is already on the execution, so it needs no new version.
    const saved =
      mode.keptVersion !== undefined
        ? { version: mode.keptVersion }
        : await this.saveParts(user, executionId, prepared, false);
    const version = saved.version;
    const evidence = await this.saveEvidence(
      user,
      prepared,
      [...preview.matched.map((m) => ({ item: m, runId: m.run_id })), ...added],
      applied.applied,
      warnings,
    );

    if (ticketFields) {
      await this.saveTicketFields(
        user,
        spaceId,
        executionId,
        ticketFields,
        warnings,
      );
    }

    const links =
      (options.link_requirements ?? linksByDefault(prepared.parts))
        ? await this.linkRequirementsOf(
            user,
            spaceId,
            prepared,
            [
              ...preview.matched.map((m) => ({ caseId: m.case_id, item: m })),
              ...added.map((a) => ({ caseId: a.item.case_id, item: a.item })),
            ],
            data.added_runs,
            warnings,
          )
        : null;

    void this.auditLogs.logActionForRequest(
      user,
      'test_execution',
      executionId,
      'update',
      {
        action: 'results_import',
        format: prepared.batch
          ? prepared.parts.map((part) => part.format)
          : prepared.format,
        key: execution.key,
        file_name: prepared.batch
          ? prepared.parts.map((part) => part.file.originalname)
          : prepared.parts[0].file.originalname,
        sha256,
        ...(preview.rerun ? { rerun: true } : {}),
        applied: applied.applied.length,
        added_runs: applied.added_runs.length,
        ...(data.created_cases.length > 0
          ? { created_cases: data.created_cases.length }
          : {}),
        version_number: version,
      },
    );

    const dropped = [
      ...(optIn
        ? []
        : (preview.unmatched ?? []).filter(recordable).map(fullKey)),
      ...(optIn || mode.addInSpace
        ? []
        : (preview.in_space ?? []).filter(recordable).map(fullKey)),
      ...(preview.ambiguous ?? []).filter(recordable).map(fullKey),
      ...preview.invalid.map((issue) => issue.value ?? issue.message),
      ...data.skipped.map((s) => s.automation_key ?? s.key ?? s.reason),
    ];

    return {
      ...applied,
      ...(prepared.keyless ? { created_cases: data.created_cases } : {}),
      file_saved: saved.files
        ? saved.files.every((f) => f.file_saved)
        : version !== null,
      repaired: false,
      version_number: version,
      ...(saved.files ? { files: saved.files } : {}),
      warnings,
      ...evidence,
      ...(links
        ? {
            requirements_added: links.added,
            requirements_failed: links.failed,
          }
        : {}),
      ...(dropped.length > 0
        ? {
            dropped: {
              count: dropped.length,
              names: dropped.slice(0, DROPPED_NAMES),
            },
          }
        : {}),
    };
  }

  /**
   * A report upload that starts its own execution. Nothing is created when the file cannot record anything.
   * An automation run that already has an execution, or an Xray file naming one, records into that one instead.
   */
  async importResults(
    user: RequestUser,
    spaceId: string,
    upload: Express.Multer.File | Express.Multer.File[],
    dto: ResultImportOptionsDto,
    run: { executionId: string | null; planId: string | null } | null = null,
  ): Promise<JunitCommitResult> {
    // Before the file is even read, so a space the caller cannot use says nothing about the file.
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    ticketFieldsOf(dto);

    const reports = Array.isArray(upload) ? upload : [upload];
    const sha256 = uploadSha(uniqueFiles(reports).parts);
    const options: JunitCommitOptionsDto = {
      format: dto.format,
      create_unmatched: dto.create_unmatched,
      folder_id: dto.folder_id,
      labels: dto.labels,
      custom_fields: dto.custom_fields,
      link_requirements: dto.link_requirements,
    };
    // The file was applied before: repair its missing file or refuse, through the normal upload.
    const holder = await this.executionHolding(user, spaceId, sha256);

    if (holder) {
      // Asked for a new execution, so a reset one must not take these results.
      const repaired = await this.commitMany(
        user,
        spaceId,
        holder.id,
        reports,
        options,
        { noRerun: true },
      );

      return {
        ...repaired,
        warnings: [
          ...(repaired.warnings ?? []),
          ...ignoredFields(
            dto,
            `This file was imported before into ${holder.key}`,
            REPLAY_FIELDS,
          ),
        ],
        execution: { id: holder.id, key: holder.key, replayed: true },
      };
    }

    const read = await this.readReport(
      user.organizationId,
      spaceId,
      '',
      reports,
      dto.format,
      false,
    );
    const { parsed } = read;
    const label = labelOf(read.parts);
    const info = read.batch ? {} : (parsed.xray ?? {});
    const named = run?.executionId
      ? {
          id: run.executionId,
          key: await this.executionKey(
            user.organizationId,
            spaceId,
            run.executionId,
          ),
        }
      : info.execution_key
        ? await this.findByKey(
            user,
            spaceId,
            'test_executions',
            info.execution_key,
          )
        : null;

    if (info.execution_key && !run?.executionId && !named) {
      throw new BadRequestException({
        code: 'TEST_EXECUTION_UNKNOWN',
        message: `No test execution ${info.execution_key} in this space`,
        data: { key: info.execution_key },
      });
    }

    const givenPlan =
      dto.plan_id ??
      (dto.plan_key
        ? await this.planFromKey(user, spaceId, dto.plan_key)
        : null);

    // The results go to an execution that already exists, so only its plan can be checked.
    if (named) {
      await this.assertSamePlan(user, spaceId, named.id, givenPlan);

      const recorded = await this.commitMany(
        user,
        spaceId,
        named.id,
        reports,
        options,
      );

      return {
        ...recorded,
        warnings: [
          ...(recorded.warnings ?? []),
          ...ignoredFields(
            dto,
            `The results went to ${named.key}, which already exists`,
            EXECUTION_FIELDS,
            'FORM_FIELDS_NOT_USED',
          ),
        ],
        execution: {
          id: named.id,
          key: named.key,
          replayed: false,
          existing: true,
        },
      };
    }

    const duplicate =
      read.duplicate ??
      (
        await this.uploads(
          user.organizationId,
          spaceId,
          '',
          sha256,
          read.parts.map((part) => part.format),
        )
      ).duplicate;

    if (duplicate) throw this.alreadyApplied(duplicate, label);

    await this.checkBeforeCreate(
      user,
      spaceId,
      parsed,
      options,
      read.parts.some((part) => keyless(part.format)),
    );

    const warnings: TransferIssue[] = [];
    const filePlan =
      givenPlan === null && info.test_plan_key
        ? await this.findByKey(user, spaceId, 'test_plans', info.test_plan_key)
        : null;

    if (givenPlan === null && info.test_plan_key && !filePlan) {
      warnings.push({
        row: 0,
        code: 'TEST_PLAN_UNKNOWN',
        message: `The file names test plan ${info.test_plan_key}, which is not in this space; the execution has no plan`,
        value: info.test_plan_key,
      });
    }

    const revision = dto.revision ?? info.revision;
    const version = dto.version ?? info.version;
    const used: (keyof typeof INFO_WARNING_NAMES)[] = [
      ...(dto.name === undefined && info.summary ? (['summary'] as const) : []),
      ...(dto.description === undefined && info.description
        ? (['description'] as const)
        : []),
      ...(dto.revision === undefined && info.revision
        ? (['revision'] as const)
        : []),
      ...(dto.version === undefined && info.version
        ? (['version'] as const)
        : []),
      ...(filePlan ? (['test_plan_key'] as const) : []),
      ...(dto.environments === undefined && info.test_environments
        ? (['test_environments'] as const)
        : []),
    ];
    const environment = normaliseEnvironments(
      dto.environments ?? info.test_environments?.join(','),
    );
    const created = await this.executions.createImport(user, spaceId, {
      request_id: requestIdFor(spaceId, sha256),
      name: dto.name ?? info.summary ?? importName(label),
      description: joinText(
        dto.description ?? info.description,
        revision ? `Revision: ${revision}` : null,
        version ? `Version: ${version}` : null,
      ),
      plan_id: givenPlan ?? filePlan?.id ?? run?.planId ?? null,
      environment,
    });
    const execution = {
      id: created.execution_id,
      key: created.key,
      replayed: created.replayed,
    };
    let result: JunitCommitResult;

    try {
      result = await this.commitMany(
        user,
        spaceId,
        execution.id,
        reports,
        options,
        {
          addInSpace: true,
        },
      );
    } catch (error) {
      // A replayed execution belongs to another try of this upload, which may still be using it.
      if (!execution.replayed) {
        await this.executions.removeFailedImport(user, spaceId, execution.id);
      }

      throw error;
    }

    return {
      ...result,
      warnings: [
        ...withoutUsedFields(
          result.warnings ?? [],
          used.map((field) => INFO_WARNING_NAMES[field]),
        ),
        ...warnings,
        ...(execution.replayed
          ? ignoredFields(dto, `An earlier try made ${execution.key}`)
          : []),
      ],
      execution,
    };
  }

  /** The plan given with the upload must be the one of the execution the results go to. */
  private async assertSamePlan(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    planId: string | null,
  ): Promise<void> {
    if (planId === null) return;

    const { data, error } = await this.client
      .from('test_executions')
      .select('plan_id')
      .eq('id', executionId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle<{ plan_id: string | null }>();

    if (error) throw tmDbError(this.logger, 'load execution plan', error);
    if (!data) throw notFound();

    if (data.plan_id !== planId) {
      throw new BadRequestException({
        code: 'PLAN_MISMATCH',
        message:
          'The execution the results go to belongs to another test plan than the one given',
      });
    }
  }

  /** A test plan named by its ticket key in the form; an unknown or archived one is a 400. */
  private async planFromKey(
    user: RequestUser,
    spaceId: string,
    key: string,
  ): Promise<string> {
    const plan = await this.findByKey(user, spaceId, 'test_plans', key);

    if (!plan) {
      throw new BadRequestException({
        code: 'TEST_PLAN_UNKNOWN',
        message: `No test plan ${key.trim().toUpperCase()} in this space`,
        data: { key: key.trim().toUpperCase() },
      });
    }

    return plan.id;
  }

  /** A live test execution or plan of this space by its ticket's key; keys are upper case. */
  private async findByKey(
    user: RequestUser,
    spaceId: string,
    table: 'test_executions' | 'test_plans',
    key: string,
  ): Promise<{ id: string; key: string } | null> {
    const { data, error } = await this.client
      .from(table)
      .select(`id, ${ticketEmbed(table, 'key')}`)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('is_archived', false)
      .eq('task.key', key.trim().toUpperCase())
      .maybeSingle<{ id: string; task: { key: string } }>();

    if (error) throw tmDbError(this.logger, `find ${table} by key`, error);

    return data ? { id: data.id, key: data.task.key } : null;
  }

  private async executionHolding(
    user: RequestUser,
    spaceId: string,
    sha256: string,
  ): Promise<{ id: string; key: string } | null> {
    const { data, error } = await this.client
      .from('test_executions')
      .select(`id, ${ticketEmbed('test_executions', 'key')}`)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('import_sha256', sha256)
      .maybeSingle<{ id: string; task: { key: string } }>();

    if (error) throw tmDbError(this.logger, 'find applied file', error);

    return data ? { id: data.id, key: data.task.key } : null;
  }

  /** The refusals of the upload itself, so a file that can record nothing never makes a ticket. */
  private async checkBeforeCreate(
    user: RequestUser,
    spaceId: string,
    parsed: ParsedJunit & { format: ResultFormat },
    options: JunitCommitOptionsDto,
    keylessUpload: boolean,
  ): Promise<void> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    if (!(await this.can(user, spaceId, 'execute_tests'))) {
      throw this.forbidden('You cannot add files to this execution');
    }

    const keyed = await this.casesByTestKey(
      user.organizationId,
      spaceId,
      testKeysOf(parsed.items),
    );
    const invalid = [...parsed.invalid];
    const leftover: JunitTestcase[] = [];

    // Case ids, or automation keys of the tests this upload would create.
    const willRecord = new Set<string>();

    for (const item of parsed.items) {
      if (!item.test_key) {
        leftover.push(item);
        continue;
      }

      const found = keyed.get(item.test_key);

      if (!usable(found)) {
        invalid.push(testKeyIssue(item, item.test_key, found));
      } else if (recordable(item)) {
        willRecord.add(found.id);
      }
    }

    const sorted = await this.sortUnclaimed(
      user.organizationId,
      spaceId,
      leftover,
    );
    const optIn = options.create_unmatched === true && keylessUpload;
    let creating = false;

    invalid.push(...sorted.invalid);

    for (const o of sorted.optIn.filter((c) => recordable(c.item))) {
      if (o.caseId) willRecord.add(o.caseId);
      else if (optIn) {
        willRecord.add(o.key);
        creating = true;
      }
    }

    if (willRecord.size === 0) {
      throw nothingToApply([...invalid, ...notMatched(sorted.unmatched)]);
    }

    if (willRecord.size > TEST_EXECUTION_LIMITS.runs) throw tooManyRuns();

    if (optIn) await this.assertCanCreate(user, spaceId, options.folder_id);

    if (creating) {
      await assertCaseTicketsAllowed(
        this.client,
        this.logger,
        this.permissions,
        user,
        spaceId,
      );
    }
  }

  /** Creating test cases needs its own permission, and the chosen folder must be in this space. */
  private async assertCanCreate(
    user: RequestUser,
    spaceId: string,
    folderId: string | undefined,
  ): Promise<void> {
    if (!(await this.can(user, spaceId, 'create_tests'))) {
      throw this.forbidden('You cannot create test cases in this space');
    }

    if (!folderId) return;

    const { data, error } = await this.client
      .from('test_folders')
      .select('id')
      .eq('id', folderId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load folder', error);
    if (!data) throw notFound();
  }

  /** Results no run of this execution claims: tests the space has elsewhere, or does not have at all. */
  private async sortUnclaimed(
    organizationId: string,
    spaceId: string,
    leftover: JunitTestcase[],
  ): Promise<{
    inSpace: JunitInSpace[];
    unmatched: JunitTestcase[];
    optIn: OptIn[];
    invalid: TransferIssue[];
  }> {
    const known = await this.casesByKey(
      organizationId,
      spaceId,
      leftover.flatMap((t) => [fullKey(t), t.name]),
    );
    const inSpace: JunitInSpace[] = [];
    const unmatched: JunitTestcase[] = [];
    const optIn: OptIn[] = [];
    const invalid: TransferIssue[] = [];

    for (const item of leftover) {
      const key = known.has(fullKey(item)) ? fullKey(item) : item.name;
      const existing = known.get(key);

      if (existing?.is_archived || existing?.readiness === 'deprecated') {
        invalid.push(testKeyIssue(item, existing.key, existing));
      } else if (existing) {
        inSpace.push({ ...item, case_key: existing.key });
        optIn.push({ item, key, caseId: existing.id, caseKey: existing.key });
      } else if (
        Buffer.byteLength(fullKey(item), 'utf8') >
        TEST_CASE_LIMITS.automationKey
      ) {
        invalid.push({
          row: 0,
          code: 'TEST_NAME_TOO_LONG',
          message: `${item.name}: the class name and name are too long to become an automation key`,
          value: item.name,
        });
      } else {
        unmatched.push(item);
        optIn.push({ item, key: fullKey(item) });
      }
    }

    return { inSpace, unmatched, optIn, invalid };
  }

  /** Adds runs for tests the file names; the ones that went away meanwhile only warn. */
  private async addKeyedRuns(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    toAdd: JunitToAdd[],
    warnings: TransferIssue[],
  ): Promise<{ item: JunitToAdd; runId: string }[]> {
    if (toAdd.length === 0) return [];

    const caseIds = toAdd.map((t) => t.case_id);
    const result = await this.testRuns.addRuns(
      user,
      spaceId,
      executionId,
      caseIds,
    );

    if (result.plan_sync && result.plan_sync !== 'ok') {
      warnings.push({
        row: 0,
        code: 'PLAN_NOT_UPDATED',
        message: 'The tests were recorded, but the test plan was not updated',
      });
    }

    const runIds = new Map<string, string>();

    for (let i = 0; i < caseIds.length; i += KEY_CHUNK) {
      const { data, error } = await this.client
        .from('test_runs')
        .select('id, case_id')
        .eq('execution_id', executionId)
        .eq('space_id', spaceId)
        .eq('organization_id', user.organizationId)
        .in('case_id', caseIds.slice(i, i + KEY_CHUNK))
        .returns<{ id: string; case_id: string }[]>();

      if (error) throw tmDbError(this.logger, 'load added runs', error);

      for (const row of data ?? []) runIds.set(row.case_id, row.id);
    }

    return toAdd.flatMap((item) => {
      const runId = runIds.get(item.case_id);

      if (runId) return [{ item, runId }];

      warnings.push({
        row: 0,
        code: 'TEST_KEY_NOT_ADDED',
        message: `${item.case_key} could not be added to this execution (archived or deprecated meanwhile)`,
        value: item.case_key,
      });

      return [];
    });
  }

  private async saveEvidence(
    user: RequestUser,
    prepared: Prepared,
    targets: { item: JunitTestcase; runId: string }[],
    applied: JunitCommitResult['applied'],
    warnings: TransferIssue[],
  ): Promise<Pick<JunitCommitResult, 'evidence_saved' | 'evidence_failed'>> {
    if (prepared.evidence.size === 0) return {};

    const attemptOf = new Map(applied.map((a) => [a.run_id, a.attempt_id]));
    let saved = 0;
    let failed = 0;
    let bytes = 0;
    let capped = false;

    for (const { item, runId } of targets) {
      const attemptId = attemptOf.get(runId);
      // Results without a test key keep their files under class and name.
      const evidence =
        prepared.evidence.get(
          item.test_key ?? `${item.classname}\u0000${item.name}`,
        ) ?? [];

      if (!attemptId) continue;

      for (const [index, file] of evidence.entries()) {
        if (
          saved + failed >= EVIDENCE_MAX_FILES ||
          bytes + file.data.length > EVIDENCE_MAX_BYTES
        ) {
          capped = true;
          break;
        }

        bytes += file.data.length;

        try {
          await this.attachments.upload({
            user,
            entityType: 'test_run_attempt',
            entityId: attemptId,
            file: {
              buffer: file.data,
              originalname: `${index + 1}-${file.name}`,
              mimetype: mediaTypeOf(file.name),
              size: file.data.length,
            } as Express.Multer.File,
          });
          saved += 1;
        } catch (error) {
          failed += 1;
          this.logger.warn(
            `Evidence ${file.name} was not saved: ${error instanceof Error ? error.message : String(error)}`,
          );
          warnings.push({
            row: 0,
            code: 'EVIDENCE_NOT_SAVED',
            message: `${file.name} was not saved`,
            value: file.name,
          });
        }
      }
    }

    if (capped) {
      warnings.push({
        row: 0,
        code: 'EVIDENCE_LIMIT',
        message: `Only the first ${EVIDENCE_MAX_FILES} evidence files or 50 MB of one upload are saved`,
      });
    }

    return { evidence_saved: saved, evidence_failed: failed };
  }

  /** Writes the upload's labels and custom fields to the execution ticket; problems only add warnings. */
  private async saveTicketFields(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    fields: TicketFields,
    warnings: TransferIssue[],
  ): Promise<void> {
    const warn = (code: string, message: string, value?: string) =>
      warnings.push({ row: 0, code, message, ...(value ? { value } : {}) });

    // The same right as editing the ticket on the task screen.
    if (
      !(await this.permissions.hasOrgOrSpacePermission(
        user.userId,
        user.organizationId,
        'can_edit_tasks',
        spaceId,
      ))
    ) {
      warn(
        'TICKET_FIELDS_NO_RIGHT',
        'You cannot edit tickets in this space, so the labels and custom fields were not saved',
      );

      return;
    }

    try {
      const saved = await this.executions.addTicketFields(
        user,
        spaceId,
        executionId,
        fields,
      );

      if (!saved.ticketKey) {
        warn(
          'EXECUTION_NO_TICKET',
          'The execution has no ticket, so the labels and custom fields were not saved',
        );

        return;
      }

      if (fields.trimmed || saved.labelsCapped) {
        warn(
          'LABELS_TRIMMED',
          `A ticket keeps at most ${TEST_CASE_LABEL_LIMITS.perCase} labels of ${TEST_CASE_LABEL_LIMITS.length} characters, so some labels were cut or left out`,
        );
      }

      for (const key of saved.unknownFields) {
        warn(
          'CUSTOM_FIELD_UNKNOWN',
          `${key} is not a custom field of this space's tickets`,
          key,
        );
      }

      for (const key of saved.refusedFields) {
        warn(
          'CUSTOM_FIELD_TYPE_NOT_ALLOWED',
          `${key} cannot be filled from an upload; set it on the ticket`,
          key,
        );
      }

      for (const key of saved.invalidFields) {
        warn(
          'CUSTOM_FIELD_VALUE_INVALID',
          `The value for ${key} does not fit the field, so it was not saved`,
          key,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(
        `Saving fields on the execution ticket failed: ${message}`,
      );
      warn(
        'TICKET_FIELDS_NOT_SAVED',
        'The results are saved, but the labels and custom fields could not be saved on the execution ticket',
      );
    }
  }

  /**
   * Links the requirement tickets the file names to the test cases of their results, as the link screen does.
   * The results are already recorded, so every problem is a warning.
   */
  private async linkRequirementsOf(
    user: RequestUser,
    spaceId: string,
    prepared: Prepared,
    keyed: LinkTarget[],
    addedByDatabase: JunitCommitResult['added_runs'],
    warnings: TransferIssue[],
  ): Promise<{ added: number; failed: number } | null> {
    const counts = { added: 0, failed: 0 };

    try {
      const targets = [
        ...keyed,
        ...(await this.optInTargets(
          user,
          spaceId,
          prepared,
          keyed,
          addedByDatabase,
        )),
      ].filter((t) => (t.item.requirement_keys?.length ?? 0) > 0);

      if (targets.length === 0) return null;

      if (!(await this.can(user, spaceId, 'edit_tests'))) {
        warnings.push({
          row: 0,
          code: 'REQUIREMENTS_NOT_LINKED',
          message:
            'You cannot edit test cases here, so the requirement links from the file were not saved',
        });

        return null;
      }

      const usable = await this.requirementTickets(
        user,
        spaceId,
        [...new Set(targets.flatMap((t) => t.item.requirement_keys ?? []))],
        warnings,
      );
      const byCase = new Map<string, Set<string>>();

      for (const target of targets) {
        const ids = byCase.get(target.caseId) ?? new Set<string>();

        for (const key of target.item.requirement_keys ?? []) {
          const id = usable.get(key);

          if (id) ids.add(id);
        }

        byCase.set(target.caseId, ids);
      }

      for (const [caseId, ids] of byCase) {
        const taskIds = [...ids];

        for (
          let i = 0;
          i < taskIds.length;
          i += TEST_COVERAGE_LIMITS.tasksPerCall
        ) {
          const chunk = taskIds.slice(i, i + TEST_COVERAGE_LIMITS.tasksPerCall);

          try {
            const change = await this.requirements.linkCaseRequirements(
              user,
              spaceId,
              caseId,
              { task_ids: chunk },
            );

            counts.added += change.added;
          } catch (error) {
            counts.failed += chunk.length;
            this.logger.warn(
              `Results upload could not link requirements of case ${caseId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    } catch (error) {
      this.logger.warn(
        `Requirement links after a results upload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      warnings.push({
        row: 0,
        code: 'FOLLOW_UP_INCOMPLETE',
        message:
          'The results are saved, but not every requirement link from the file was saved',
      });
    }

    return counts;
  }

  /** Cases the database function made or found by automation key, matched back to their results. */
  private async optInTargets(
    user: RequestUser,
    spaceId: string,
    prepared: Prepared,
    keyed: LinkTarget[],
    addedByDatabase: JunitCommitResult['added_runs'],
  ): Promise<LinkTarget[]> {
    const known = new Set(keyed.map((t) => t.caseId));
    const caseIds = addedByDatabase
      .map((r) => r.case_id)
      .filter((id) => !known.has(id));
    const byKey = new Map(prepared.optIn.map((o) => [o.key, o.item]));
    const targets: LinkTarget[] = [];

    for (let i = 0; i < caseIds.length; i += KEY_CHUNK) {
      const { data, error } = await this.client
        .from('test_cases')
        .select('id, automation_key')
        .eq('space_id', spaceId)
        .eq('organization_id', user.organizationId)
        .in('id', caseIds.slice(i, i + KEY_CHUNK))
        .returns<{ id: string; automation_key: string | null }[]>();

      if (error) throw tmDbError(this.logger, 'load created cases', error);

      for (const row of data ?? []) {
        const item = row.automation_key ? byKey.get(row.automation_key) : null;

        if (item) targets.push({ caseId: row.id, item });
      }
    }

    return targets;
  }

  /** Ticket ids by key for tickets of this space the caller can see; each other key gets its own warning. */
  private async requirementTickets(
    user: RequestUser,
    spaceId: string,
    keys: string[],
    warnings: TransferIssue[],
  ): Promise<Map<string, string>> {
    const tickets = new Map<string, string>();

    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      const { data, error } = await this.client
        .from('tasks')
        .select('id, key')
        .eq('organization_id', user.organizationId)
        .in('key', keys.slice(i, i + KEY_CHUNK))
        .returns<{ id: string; key: string }[]>();

      if (error) throw tmDbError(this.logger, 'match ticket keys', error);

      for (const row of data ?? []) tickets.set(row.key, row.id);
    }

    const visible =
      tickets.size > 0
        ? await this.visibility.visibleTasks(user, [...tickets.values()])
        : new Map<string, { spaceId: string }>();
    const usable = new Map<string, string>();

    for (const key of keys) {
      const id = tickets.get(key);
      const ticket = id ? visible.get(id) : undefined;

      // Missing and hidden tickets look the same, as on the link screen.
      if (!id || !ticket) {
        warnings.push({
          row: 0,
          code: 'REQUIREMENT_UNKNOWN',
          message: `Requirement ${key} was not found or is not visible to you`,
          value: key,
        });
      } else if (ticket.spaceId !== spaceId) {
        warnings.push({
          row: 0,
          code: 'REQUIREMENT_OTHER_SPACE',
          message: `Requirement ${key} is in another space; only tickets of this space can be linked`,
          value: key,
        });
      } else {
        usable.set(key, id);
      }
    }

    return usable;
  }

  private async prepare(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    files: Express.Multer.File[],
    requested?: ResultFormat,
    keepEvidence = false,
    allowRerun = true,
    onlyCaseId?: string,
  ): Promise<Prepared> {
    const organizationId = user.organizationId;

    await this.access.assertAvailable(organizationId, spaceId, { write: true });

    // Results need manage_test_runs (route); the file is kept as evidence, which needs execute_tests.
    if (!(await this.can(user, spaceId, 'execute_tests'))) {
      throw this.forbidden('You cannot add files to this execution');
    }

    const execution = await this.execution(
      organizationId,
      spaceId,
      executionId,
    );

    if (execution.is_archived) {
      throw new ConflictException({
        code: 'ARCHIVED',
        message: 'The execution is archived',
      });
    }

    const report = await this.readReport(
      organizationId,
      spaceId,
      executionId,
      files,
      requested,
      keepEvidence,
    );
    const { parsed, sha256 } = report;
    const allRuns = await this.runs(organizationId, spaceId, executionId);
    const runs = onlyCaseId
      ? allRuns.filter((run) => run.case_id === onlyCaseId)
      : allRuns;
    const runsByCase = new Map(runs.map((run) => [run.case_id, run]));
    const byAutomationKey = new Map<string, RunRow>();
    const byTitle = new Map<string, RunRow[]>();

    for (const run of runs) {
      if (!run.case) continue;

      if (run.case.automation_key) {
        byAutomationKey.set(run.case.automation_key, run);
      }

      const title = run.case.title.trim().toLowerCase();

      byTitle.set(title, [...(byTitle.get(title) ?? []), run]);
    }

    const keyed = await this.casesByTestKey(
      organizationId,
      spaceId,
      testKeysOf(parsed.items),
    );
    const matchedByRun = new Map<string, JunitMatch>();
    const toAdd = new Map<string, JunitToAdd>();
    const invalid: TransferIssue[] = [...parsed.invalid];
    const ambiguous: JunitAmbiguous[] = [];
    const leftover: JunitTestcase[] = [];

    for (const item of parsed.items) {
      let run: RunRow | undefined;

      if (item.test_key) {
        const found = keyed.get(item.test_key);

        if (!usable(found)) {
          invalid.push(testKeyIssue(item, item.test_key, found));
          continue;
        }

        run = runsByCase.get(found.id);

        // Named by key, but another test: it must not add a run here, so it counts as dropped.
        if (onlyCaseId && found.id !== onlyCaseId) {
          leftover.push(item);
          continue;
        }

        if (!run?.case) {
          if (item.status !== 'SKIPPED') {
            const earlier = toAdd.get(found.id);

            toAdd.set(found.id, {
              ...(earlier ? mergeTestcases(earlier, item) : item),
              case_id: found.id,
              case_key: found.key,
              case_title: found.title,
            });
          }

          continue;
        }
      } else {
        const titles = byTitle.get(item.name.toLowerCase()) ?? [];

        run =
          byAutomationKey.get(fullKey(item)) ??
          byAutomationKey.get(item.name) ??
          (titles.length === 1 ? titles[0] : undefined);

        if (!run && titles.length > 1) {
          ambiguous.push({
            ...item,
            candidates: titles.map((r) => r.case?.key ?? r.id),
          });
          continue;
        }

        if (!run?.case) {
          leftover.push(item);
          continue;
        }
      }

      const earlier = matchedByRun.get(run.id);

      matchedByRun.set(run.id, {
        ...(earlier ? mergeTestcases(earlier, item) : item),
        run_id: run.id,
        case_id: run.case_id,
        case_key: run.case.key,
        case_title: run.case.title,
        current_status: currentStatus(run),
        new_attempt: !untouched(run),
      });
    }

    const sorted = await this.sortUnclaimed(organizationId, spaceId, leftover);

    invalid.push(...sorted.invalid);

    const merged = mergeDuplicates({ ...sorted, toAdd });
    const matched: JunitMatch[] = [];
    const kept: JunitKeptRun[] = [];

    for (const match of matchedByRun.values()) {
      if (match.status === 'SKIPPED') {
        kept.push({
          run_id: match.run_id,
          case_key: match.case_key,
          case_title: match.case_title,
          current_status: match.current_status,
          reason: 'skipped',
        });
      } else matched.push(match);
    }

    for (const run of runs) {
      if (matchedByRun.has(run.id) || !run.case) continue;

      kept.push({
        run_id: run.id,
        case_key: run.case.key,
        case_title: run.case.title,
        current_status: currentStatus(run),
        reason: 'not_in_file',
      });
    }

    const formats = report.parts.map((part) => part.format);
    const found = await this.uploads(
      organizationId,
      spaceId,
      executionId,
      sha256,
      formats,
    );
    const { thisAttachment, earlierUploads, attachments } = found;

    // Several files are recorded in full here when every one of them is kept on this execution.
    const duplicate =
      report.duplicate ??
      (report.batch &&
      report.parts.length > 0 &&
      report.parts.every((part) => part.kept)
        ? {
            execution_id: executionId,
            execution_key: execution.key,
            version_number: null,
          }
        : found.duplicate);

    // Only a Cucumber report may run again, only here, and only once all its tests are back to To do.
    const recordedHere =
      formats.length > 0 &&
      formats.every((format) => format === 'cucumber') &&
      (execution.import_sha256 === sha256 ||
        duplicate?.execution_id === executionId);
    const allReset =
      matched.length > 0 && matched.every((m) => m.current_status === 'TODO');
    const heldElsewhere =
      recordedHere && allReset && !report.batch
        ? (
            await this.uploads(
              organizationId,
              spaceId,
              executionId,
              sha256,
              formats,
              executionId,
            )
          ).duplicate
        : null;
    const rerun = allowRerun && recordedHere && allReset && !heldElsewhere;
    const keylessUpload = report.parts.some((part) => keyless(part.format));

    return {
      format: parsed.format,
      parts: report.parts,
      batch: report.batch,
      label: labelOf(report.parts),
      keyless: keylessUpload,
      execution,
      sha256,
      thisAttachment,
      attachments,
      runCount: allRuns.length,
      evidence: parsed.evidence ?? new Map<string, EvidenceFile[]>(),
      optIn: merged.optIn,
      preview: {
        sha256,
        file_name: report.parts
          .map((part) => part.file.originalname)
          .join(', '),
        testcases: parsed.testcases,
        matched,
        to_add: [...toAdd.values()],
        ...(keylessUpload
          ? {
              ambiguous,
              unmatched: merged.unmatched,
              in_space: merged.inSpace,
            }
          : {}),
        invalid,
        kept,
        // The file naming this very execution is no news.
        warnings: [
          ...[...parsed.warnings, ...report.warnings].filter(
            (w) =>
              w.code !== 'EXECUTION_KEY_IGNORED' || w.value !== execution.key,
          ),
          ...merged.merges,
        ],
        earlier_uploads: earlierUploads,
        duplicate: rerun ? null : duplicate,
        already_applied: !rerun && execution.import_sha256 === sha256,
        rerun,
        reset_needed: recordedHere && !allReset,
      },
    };
  }

  /** Results attachments of every execution of the space. */
  private async resultAttachments(
    organizationId: string,
    spaceId: string,
  ): Promise<AttachmentRow[]> {
    const { data, error } = await this.client
      .from('file_attachments')
      .select('id, entity_id, file_name, checked_out_by')
      .eq('entity_type', 'test_execution')
      .in('file_name', Object.values(RESULT_ATTACHMENT_NAMES))
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (error) throw tmDbError(this.logger, 'load result uploads', error);

    return (data ?? []) as AttachmentRow[];
  }

  private attachmentOf(
    prepared: Pick<Prepared, 'attachments'>,
    executionId: string,
    format: ResultFormat,
  ): AttachmentRow | null {
    return (
      prepared.attachments.find(
        (a) =>
          a.entity_id === executionId &&
          a.file_name === RESULT_ATTACHMENT_NAMES[format],
      ) ?? null
    );
  }

  /**
   * Earlier uploads of these formats to this execution, and the upload that already holds this file anywhere in the
   * space. thisAttachment is the first format's.
   */
  private async uploads(
    organizationId: string,
    spaceId: string,
    executionId: string,
    sha256: string,
    formats: ResultFormat[],
    ignoreExecutionId?: string,
  ): Promise<{
    thisAttachment: AttachmentRow | null;
    attachments: AttachmentRow[];
    earlierUploads: JunitEarlierUpload[];
    duplicate: JunitDuplicate | null;
  }> {
    const attachments = await this.resultAttachments(organizationId, spaceId);
    const own = [...new Set(formats)].flatMap((format) => {
      const found = this.attachmentOf({ attachments }, executionId, format);

      return found ? [found] : [];
    });
    const thisAttachment =
      formats.length > 0
        ? this.attachmentOf({ attachments }, executionId, formats[0])
        : null;
    const searched = attachments.filter(
      (a) => a.entity_id !== ignoreExecutionId,
    );
    let duplicate: JunitDuplicate | null = null;

    for (let i = 0; i < searched.length && !duplicate; i += KEY_CHUNK) {
      const chunk = searched.slice(i, i + KEY_CHUNK);
      const { data: hits, error: hitError } = await this.client
        .from('file_versions')
        .select('attachment_id, version_number')
        .in(
          'attachment_id',
          chunk.map((a) => a.id),
        )
        .like('comment', `%${shaTag(sha256)}`)
        .limit(1);

      if (hitError) {
        throw tmDbError(this.logger, 'find result file', hitError);
      }

      const hit = (hits ?? [])[0] as
        | { attachment_id: string; version_number: number }
        | undefined;

      if (hit) {
        const holder = chunk.find((a) => a.id === hit.attachment_id);

        duplicate = {
          execution_id: holder?.entity_id ?? executionId,
          execution_key: await this.executionKey(
            organizationId,
            spaceId,
            holder?.entity_id ?? executionId,
          ),
          version_number: hit.version_number,
        };
      }
    }

    if (own.length === 0) {
      return { thisAttachment, attachments, earlierUploads: [], duplicate };
    }

    const versionQuery = this.client
      .from('file_versions')
      .select(
        'attachment_id, version_number, uploaded_at, comment, uploader:users!file_versions_uploaded_by_fkey(first_name, last_name, email)',
      )
      .in(
        'attachment_id',
        own.map((a) => a.id),
      );

    // Version numbers count per file, so files of several formats are listed by time.
    const { data: versions, error: versionError } = await (
      own.length > 1
        ? versionQuery.order('uploaded_at', { ascending: false })
        : versionQuery
    )
      .order('version_number', { ascending: false })
      .returns<VersionRow[]>();

    if (versionError) {
      throw tmDbError(this.logger, 'load result versions', versionError);
    }

    return {
      thisAttachment,
      attachments,
      duplicate,
      earlierUploads: (versions ?? []).map((v) => ({
        version_number: v.version_number,
        uploaded_at: v.uploaded_at,
        uploaded_by: v.uploader ? userDisplayName(v.uploader) : null,
        original_name: originalName(v.comment),
      })),
    };
  }

  /** One file is kept as today; several each become a version of their format's file. onlyMissing repairs a batch. */
  private async saveParts(
    user: RequestUser,
    executionId: string,
    prepared: Prepared,
    onlyMissing: boolean,
  ): Promise<{
    version: number | null;
    files?: NonNullable<JunitCommitResult['files']>;
  }> {
    if (!prepared.batch) {
      const [part] = prepared.parts;

      return {
        version: await this.saveFile(
          user,
          executionId,
          part.file,
          prepared.sha256,
          part.format,
        ),
      };
    }

    const files: NonNullable<JunitCommitResult['files']> = [];

    for (const part of prepared.parts) {
      if (onlyMissing && part.kept) continue;

      const version = await this.saveFile(
        user,
        executionId,
        part.file,
        part.sha256,
        part.format,
        prepared.sha256,
      );

      files.push({
        file_name: part.file.originalname,
        format: part.format,
        version_number: version,
        file_saved: version !== null,
      });
    }

    return {
      version:
        files.find((f) => f.version_number !== null)?.version_number ?? null,
      files,
    };
  }

  /**
   * The upload's files, read in full before anything is written. Several files are merged into one list of results;
   * a file already recorded elsewhere is left out with a warning, and one kept here from this same upload is marked.
   */
  private async readReport(
    organizationId: string,
    spaceId: string,
    executionId: string,
    files: Express.Multer.File[],
    requested: ResultFormat | undefined,
    keepEvidence: boolean,
  ): Promise<ReadReport> {
    const { parts: unique, repeated } = uniqueFiles(files);
    const sha256 = uploadSha(unique);

    if (unique.length === 1) {
      const [{ file }] = unique;
      const parsed = parseResultFile(file.buffer, {
        format: requested,
        keepEvidence,
      });

      return {
        parts: [{ file, sha256, format: parsed.format, kept: false }],
        parsed,
        sha256,
        batch: false,
        warnings: repeated,
        duplicate: null,
      };
    }

    const attachments = await this.resultAttachments(organizationId, spaceId);
    const warnings = [...repeated];
    const parts: ReportPart[] = [];
    const items: JunitTestcase[] = [];
    const invalid: TransferIssue[] = [];
    const evidence = new Map<string, EvidenceFile[]>();
    let testcases = 0;
    let duplicate: JunitDuplicate | null = null;
    let firstFormat: ResultFormat | null = null;

    for (const { file, sha256: own } of unique) {
      const hits = await this.versionsWithSha(attachments, own);
      const mine = (hit: (typeof hits)[number]) =>
        hit.attachment.entity_id === executionId &&
        (hit.comment ?? '').includes(batchTag(sha256));
      const elsewhere = hits.find((hit) => !mine(hit));

      if (elsewhere && !hits.some(mine)) {
        const key = await this.executionKey(
          organizationId,
          spaceId,
          elsewhere.attachment.entity_id,
        );

        duplicate ??= {
          execution_id: elsewhere.attachment.entity_id,
          execution_key: key,
          version_number: elsewhere.version_number,
        };
        warnings.push({
          row: 0,
          code: 'FILE_ALREADY_RECORDED',
          message: `${file.originalname} was already recorded in ${key || 'another upload'}, so it was left out`,
          value: key,
          file: file.originalname,
        });
        continue;
      }

      const parsed = readFile(file, requested, keepEvidence);
      const named = (issue: TransferIssue) => ({
        ...issue,
        file: file.originalname,
      });

      firstFormat ??= parsed.format;
      testcases += parsed.testcases;
      items.push(...parsed.items);
      invalid.push(...parsed.invalid.map(named));
      warnings.push(...parsed.warnings.map(named));

      for (const [key, list] of parsed.evidence ?? []) {
        evidence.set(key, [...(evidence.get(key) ?? []), ...list]);
      }

      parts.push({
        file,
        sha256: own,
        format: parsed.format,
        kept: hits.some(mine),
      });
    }

    if (items.length > TEST_TRANSFER_LIMITS.junitTestcases) {
      throw fileError(
        `The files have more than ${TEST_TRANSFER_LIMITS.junitTestcases} tests together`,
        {
          tests: items.length,
          max: TEST_TRANSFER_LIMITS.junitTestcases,
        },
        'RESULT_TOO_MANY',
      );
    }

    return {
      parts,
      parsed: {
        format: firstFormat ?? 'junit',
        testcases,
        items,
        invalid,
        warnings: [],
        ...(keepEvidence ? { evidence } : {}),
      },
      sha256,
      batch: true,
      warnings,
      duplicate: parts.length === 0 ? duplicate : null,
    };
  }

  /** Kept versions of results files that hold this sha256 as their own. */
  private async versionsWithSha(
    attachments: AttachmentRow[],
    sha256: string,
  ): Promise<
    {
      attachment: AttachmentRow;
      version_number: number;
      comment: string | null;
    }[]
  > {
    const byId = new Map(attachments.map((a) => [a.id, a]));
    const hits: {
      attachment: AttachmentRow;
      version_number: number;
      comment: string | null;
    }[] = [];

    for (let i = 0; i < attachments.length; i += KEY_CHUNK) {
      const { data, error } = await this.client
        .from('file_versions')
        .select('attachment_id, version_number, comment')
        .in(
          'attachment_id',
          attachments.slice(i, i + KEY_CHUNK).map((a) => a.id),
        )
        .like('comment', `%${shaTag(sha256)}`)
        .returns<
          {
            attachment_id: string;
            version_number: number;
            comment: string | null;
          }[]
        >();

      if (error) throw tmDbError(this.logger, 'find result file', error);

      for (const row of data ?? []) {
        const attachment = byId.get(row.attachment_id);

        if (attachment) hits.push({ ...row, attachment });
      }
    }

    return hits;
  }

  /** Saves the upload as the next version of the execution's results file; null when that failed. */
  private async saveFile(
    user: RequestUser,
    executionId: string,
    file: Express.Multer.File,
    sha256: string,
    format: ResultFormat,
    batch?: string,
  ): Promise<number | null> {
    // The file's own sha256 stays last, so the same file is found again however it was sent.
    const tags = batch
      ? `${batchTag(batch)} · ${shaTag(sha256)}`
      : shaTag(sha256);

    try {
      const { version } = await this.attachments.upload({
        user,
        entityType: 'test_execution',
        entityId: executionId,
        file: { ...file, originalname: RESULT_ATTACHMENT_NAMES[format] },
        comment: `Uploaded as ${file.originalname.slice(0, FILE_NAME_LENGTH)} · ${tags}`,
      });

      return version.version_number;
    } catch (error) {
      // The results are already recorded; the answer says the file is missing so it can be sent again.
      this.logger.warn(
        `Results file of execution ${executionId} was not saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return null;
    }
  }

  // The database's own wording stays in the log; people get text that names what to do.
  private async applyError(
    user: RequestUser,
    spaceId: string,
    sha256: string,
    error: TmRpcError,
    label: string,
  ): Promise<HttpException> {
    const sameFile =
      error.code === 'TM009' ||
      (error.code === '23505' &&
        /another execution|test_executions_import_key/.test(
          `${error.message} ${error.details ?? ''}`,
        ));

    // Two uploads can race past the preview check.
    if (sameFile) {
      const holder = await this.executionHolding(user, spaceId, sha256);

      return this.alreadyApplied(
        {
          execution_id: holder?.id ?? '',
          execution_key: holder?.key ?? '',
          version_number: null,
        },
        label,
      );
    }

    if (error.code === 'TM004') {
      return new ConflictException({
        code: 'ARCHIVED',
        message: 'The execution is archived',
      });
    }

    if (error.code === 'TM013') return tooManyRuns();

    if (error.code === '22023') {
      const failure = caseImportError(this.logger, 'apply results', error);
      const { code } = failure.getResponse() as { code?: string };

      // A space without ticket settings has its own answer, which says what to fix.
      if (code?.startsWith('TICKET_')) return failure;

      this.logger.error(`Results not recorded: ${error.message}`);

      return new BadRequestException({
        code: 'RESULTS_NOT_RECORDED',
        message: 'The results could not be recorded, and nothing was changed',
      });
    }

    return tmRpcError(this.logger, 'apply results', error);
  }

  private async moveCreatedCases(
    user: RequestUser,
    spaceId: string,
    caseIds: string[],
    folderId: string,
    warnings: TransferIssue[],
  ): Promise<void> {
    for (let i = 0; i < caseIds.length; i += MOVE_CHUNK) {
      const { error } = (await this.client.rpc('tm_bulk_update_cases', {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_case_ids: caseIds.slice(i, i + MOVE_CHUNK),
        p_action: 'move',
        p_folder_id: folderId,
      })) as { error: TmRpcError | null };

      // The results are recorded; a failed move only leaves the new cases at the top level.
      if (error) {
        this.logger.warn(`Moving created cases failed: ${error.message}`);
        warnings.push({
          row: 0,
          code: 'CASES_NOT_MOVED',
          message:
            'The new test cases could not be moved to the chosen folder and stay at the top level',
        });

        return;
      }
    }
  }

  private alreadyApplied(
    duplicate: JunitDuplicate,
    label: string,
  ): ConflictException {
    return new ConflictException({
      code: 'IMPORT_ALREADY_APPLIED',
      message: duplicate.execution_key
        ? `This ${label} file was already applied to ${duplicate.execution_key}`
        : `This ${label} file was already applied`,
      data: duplicate,
    });
  }

  private async execution(
    organizationId: string,
    spaceId: string,
    executionId: string,
  ): Promise<ExecutionRow> {
    const { data, error } = await this.client
      .from('test_executions')
      .select(
        `id, is_archived, import_sha256, ${ticketEmbed('test_executions', 'key')}`,
      )
      .eq('id', executionId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle<Omit<ExecutionRow, 'key'> & { task: { key: string } }>();

    if (error) throw tmDbError(this.logger, 'load execution', error);
    if (!data) throw notFound();

    const { task, ...row } = data;

    return { ...row, key: task.key };
  }

  private async executionKey(
    organizationId: string,
    spaceId: string,
    executionId: string,
  ): Promise<string> {
    const { data } = await this.client
      .from('test_executions')
      .select(ticketEmbed('test_executions', 'key'))
      .eq('id', executionId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle<{ task: { key: string } }>();

    return data?.task.key ?? '';
  }

  private async runs(
    organizationId: string,
    spaceId: string,
    executionId: string,
  ): Promise<RunRow[]> {
    // The current attempt is the one numbered current_attempt_no; PostgREST cannot join on that, so all attempts come along.
    const { data, error } = await this.client
      .from('test_runs')
      .select(
        'id, case_id, current_attempt_no, ' +
          `case:test_cases!test_runs_case_fkey(automation_key, ${ticketEmbed('test_cases')}), ` +
          'attempts:test_run_attempts!test_run_attempts_run_fkey(attempt_no, status, status_overridden, comment, actual_minutes, step_results)',
      )
      .eq('execution_id', executionId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .range(0, TEST_EXECUTION_LIMITS.runs - 1)
      .returns<
        (Omit<RunRow, 'case'> & {
          case: {
            automation_key: string | null;
            task: { key: string; summary: string };
          } | null;
        })[]
      >();

    if (error) throw tmDbError(this.logger, 'load runs', error);

    return (data ?? []).map((run) => ({
      ...run,
      case: run.case && {
        key: run.case.task.key,
        title: ticketName(run.case.task.summary),
        automation_key: run.case.automation_key,
      },
    }));
  }

  /** Test cases named by their ticket's key in the file. */
  private async casesByTestKey(
    organizationId: string,
    spaceId: string,
    keys: string[],
  ): Promise<Map<string, KeyedCase>> {
    const found = new Map<string, KeyedCase>();

    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      const { data, error } = await this.client
        .from('test_cases')
        .select(`id, is_archived, readiness, ${ticketEmbed('test_cases')}`)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .in('task.key', keys.slice(i, i + KEY_CHUNK))
        .returns<
          (Omit<KeyedCase, 'key' | 'title'> & {
            task: { key: string; summary: string };
          })[]
        >();

      if (error) throw tmDbError(this.logger, 'match test keys', error);

      for (const { task, ...row } of data ?? []) {
        found.set(task.key, {
          ...row,
          key: task.key,
          title: ticketName(task.summary),
        });
      }
    }

    return found;
  }

  /** Test cases of the space by automation key; a key too long for the column cannot match any. */
  private async casesByKey(
    organizationId: string,
    spaceId: string,
    keys: string[],
  ): Promise<Map<string, KeyedCase>> {
    const unique = [...new Set(keys)].filter(
      (k) => Buffer.byteLength(k, 'utf8') <= TEST_CASE_LIMITS.automationKey,
    );
    const found = new Map<string, KeyedCase>();

    for (let i = 0; i < unique.length; i += NAME_CHUNK) {
      const { data, error } = await this.client
        .from('test_cases')
        .select(
          `id, automation_key, is_archived, readiness, ${ticketEmbed('test_cases')}`,
        )
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .in('automation_key', unique.slice(i, i + NAME_CHUNK))
        .returns<
          (Omit<KeyedCase, 'key' | 'title'> & {
            automation_key: string;
            task: { key: string; summary: string };
          })[]
        >();

      if (error) throw tmDbError(this.logger, 'match automation keys', error);

      for (const { task, automation_key, ...row } of data ?? []) {
        found.set(automation_key, {
          ...row,
          key: task.key,
          title: ticketName(task.summary),
        });
      }
    }

    return found;
  }

  private async spaceTestTypes(
    organizationId: string,
    spaceId: string,
  ): Promise<SpaceTestType[]> {
    const { data, error } = await this.client
      .from('test_management_space_settings')
      .select('test_types')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle<{ test_types: SpaceTestType[] | null }>();

    if (error) throw tmDbError(this.logger, 'load test types', error);

    return data?.test_types ?? [];
  }

  private can(
    user: RequestUser,
    spaceId: string,
    permission: string,
  ): Promise<boolean> {
    return this.permissions.hasSpacePermission(
      user.userId,
      user.organizationId,
      spaceId,
      permission,
    );
  }

  private forbidden(message: string): ForbiddenException {
    return new ForbiddenException({ code: 'FORBIDDEN', message });
  }
}
