import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { setImmediate as nextLoopTurn } from 'timers/promises';
import { TextDecoder } from 'util';

import { AuditLogsService } from '../../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../../auth/interfaces/request-user.interface';
import { fetchAllRows } from '../../../common/utils/fetch-all-rows';
import { PermissionsService } from '../../../permissions/permissions.service';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../../access/test-management-access.service';
import { TestCasesService } from '../../cases/test-cases.service';
import { addCaseLabels } from '../../common/case-labels';
import { TaskVisibilityService } from '../../common/task-visibility.service';
import { ticketEmbed, ticketName } from '../../common/ticket-keys';
import { TEST_CASE_LIMITS } from '../../dto/test-case.dto';
import { TEST_COVERAGE_LIMITS } from '../../dto/test-coverage.dto';
import { TEST_PRECONDITION_LIMITS } from '../../dto/test-precondition.dto';
import {
  TEST_TRANSFER_LIMITS,
  type FeatureImportOptionsDto,
  type FeatureImportPreview,
  type FeatureImportResult,
  type FeatureImportRow,
  type TransferIssue,
} from '../../dto/test-transfer.dto';
import { TestPreconditionsService } from '../../preconditions/test-preconditions.service';
import { TestRequirementLinksService } from '../../requirements/test-requirement-links.service';
import {
  notFound,
  tmDbError,
  type TmRpcError,
} from '../../test-management-errors';
import {
  featureAutomationKey,
  normalisePath,
  parseFeatureFile,
  requirementKeys,
  scenarioKeys,
  type GherkinBackground,
  type GherkinScenario,
  type ParsedFeature,
} from '../gherkin/gherkin.util';
import {
  assertCaseTicketsAllowed,
  caseImportError,
  fileError,
  folderPaths,
  type FolderNode,
} from '../shared/transfer-helpers';
import { isZip, readZipEntries } from '../shared/zip-entries';

// Keys looked up per request; keeps the request URL short.
const KEY_CHUNK = 100;
const PAGE = 1000;
const MAX_DEFINITION = TEST_CASE_LIMITS.longText;
const MAX_NAME = TEST_CASE_LIMITS.title;

const UTF8 = new TextDecoder('utf-8', { fatal: true });

// Names can be long, so fewer of them fit in one request URL.
const TITLE_CHUNK = 20;

const CASE_COLUMNS = `id, folder_id, is_archived, test_type, definition, revision, precondition_ids, ${ticketEmbed('test_cases', 'key, summary')}`;

interface SpaceTestType {
  id: string;
  kind: string;
}

interface TargetCase {
  id: string;
  key: string;
  title: string;
  folder_id: string | null;
  is_archived: boolean;
  test_type: string;
  definition: string | null;
  revision: number;
  precondition_ids: string[] | null;
}

type TargetCaseRow = Omit<TargetCase, 'key' | 'title'> & {
  task: { key: string; summary: string };
};

interface PreconditionRow {
  id: string;
  key: string;
  test_type: string;
  definition: string | null;
  is_archived: boolean;
}

interface SourceFile {
  name: string;
  data: Buffer;
}

interface Item {
  row: number;
  feature: ParsedFeature;
  scenario: GherkinScenario;
  title: string;
  automationKey: string;
  testKey?: string;
  folderPath: string;
  target?: TargetCase;
  caseId?: string;
  out: FeatureImportRow;
}

interface Analysis {
  files: number;
  scenarios: number;
  features: ParsedFeature[];
  items: Item[];
  gherkinType: string;
  errors: TransferIssue[];
  warnings: TransferIssue[];

  // Shown after the warnings, so advice can never push a real problem out of view.
  lint: TransferIssue[];
}

interface ImportFunctionResult {
  created: { row: number; case_id: string; key: string }[];
  skipped: { row: number; reason: string }[];
}

// Line endings and trailing spaces do not make a scenario different.
const normText = (s: string | null): string =>
  (s ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();

const sameText = (a: string | null, b: string | null): boolean =>
  normText(a) === normText(b);

const targetCase = ({ task, ...row }: TargetCaseRow): TargetCase => ({
  ...row,
  key: task.key,
  title: ticketName(task.summary),
});

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

@Injectable()
export class FeatureImportService {
  private readonly logger = new Logger(FeatureImportService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly permissions: PermissionsService,
    private readonly cases: TestCasesService,
    private readonly preconditions: TestPreconditionsService,
    private readonly requirements: TestRequirementLinksService,
    private readonly visibility: TaskVisibilityService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async preview(
    user: RequestUser,
    spaceId: string,
    file: Express.Multer.File,
    options: FeatureImportOptionsDto,
  ): Promise<FeatureImportPreview> {
    const analysis = await this.analyse(user, spaceId, file, options);

    return {
      file_name: file.originalname,
      files: analysis.files,
      scenarios: analysis.scenarios,
      rows: analysis.items.map((i) => i.out),
      errors: analysis.errors,
      warnings: [...analysis.warnings, ...analysis.lint],
    };
  }

  /** Not atomic: every scenario that can be saved is saved, the rest is reported. */
  async commit(
    user: RequestUser,
    spaceId: string,
    file: Express.Multer.File,
    options: FeatureImportOptionsDto,
  ): Promise<FeatureImportResult> {
    const analysis = await this.analyse(user, spaceId, file, options);
    const { errors, warnings, gherkinType } = analysis;
    const canEdit = await this.can(user, spaceId, 'edit_tests');
    const live = () =>
      analysis.items.filter(
        (i) => i.out.action !== 'error' && i.out.action !== 'exists',
      );

    if (live().some((i) => i.out.action === 'create')) {
      await assertCaseTicketsAllowed(
        this.client,
        this.logger,
        this.permissions,
        user,
        spaceId,
      );
    }

    const { idsFor, created: preconditionsCreated } =
      await this.resolvePreconditions(user, spaceId, analysis, live());
    const created = await this.createCases(
      user,
      spaceId,
      live().filter((i) => i.out.action === 'create'),
      gherkinType,
      idsFor,
      errors,
      warnings,
    );
    const updated = await this.updateCases(
      user,
      spaceId,
      live().filter((i) => i.out.action === 'update'),
      canEdit,
      errors,
    );

    // Before the labels, so an unchanged scenario still gets the tags added to its file.
    for (const item of live()) {
      if (item.out.action === 'unchanged') item.caseId = item.target?.id;
    }

    await this.addLabels(
      user,
      spaceId,
      live().filter((i) => i.caseId && (canEdit || i.out.action === 'create')),
      warnings,
    );

    await this.addPreconditions(
      user,
      spaceId,
      live().filter((i) => i.target && i.caseId),
      gherkinType,
      idsFor,
      canEdit,
      warnings,
    );

    const requirementsAdded = await this.linkRequirements(
      user,
      spaceId,
      analysis.features,
      live(),
      canEdit,
      warnings,
    );

    void this.auditLogs.logActionForRequest(user, 'space', spaceId, 'update', {
      entity_type: 'test_case',
      action: 'feature_import',
      files: analysis.files,
      created: created.length,
      updated: updated.length,
    });

    for (const row of created) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_case',
        row.case_id,
        'create',
        { action: 'feature_import', key: row.key, space_id: spaceId },
      );
    }

    return {
      created,
      updated,
      unchanged: live().filter((i) => i.out.action === 'unchanged').length,
      preconditions_created: preconditionsCreated,
      requirements_added: requirementsAdded,
      errors,
      warnings: [...warnings, ...analysis.lint],
    };
  }

  private async analyse(
    user: RequestUser,
    spaceId: string,
    file: Express.Multer.File,
    options: FeatureImportOptionsDto,
  ): Promise<Analysis> {
    const organizationId = user.organizationId;

    await this.access.assertAvailable(organizationId, spaceId, { write: true });

    if (!(await this.can(user, spaceId, 'create_tests'))) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You cannot create tests in this space',
      });
    }

    const types = await this.spaceTestTypes(organizationId, spaceId);
    const gherkin = types.find((t) => t.kind === 'gherkin');

    if (!gherkin) {
      throw new BadRequestException({
        code: 'NO_GHERKIN_TYPE',
        message: 'This space has no Cucumber test type',
      });
    }

    const errors: TransferIssue[] = [];
    const warnings: TransferIssue[] = [];
    const lint: TransferIssue[] = [];
    const sources = await this.readFiles(file, warnings);
    const features: ParsedFeature[] = [];
    let scenarios = 0;

    for (const source of sources) {
      if (source.data.length > TEST_TRANSFER_LIMITS.featureFileBytes) {
        errors.push({
          row: 0,
          code: 'FILE_TOO_LARGE',
          message: `The file is larger than ${TEST_TRANSFER_LIMITS.featureFileBytes / (1024 * 1024)} MB`,
          file: source.name,
          line: 1,
        });
        continue;
      }

      let text: string;

      try {
        text = UTF8.decode(source.data);

        // Valid UTF-8, but a database text column refuses it and the whole batch would fail.
        if (text.includes('\0')) throw new Error('NUL');
      } catch {
        errors.push({
          row: 0,
          code: 'FILE_NOT_UTF8',
          message: 'The file is not UTF-8 text',
          file: source.name,
          line: 1,
        });
        continue;
      }

      const parsed = parseFeatureFile(text, source.name);

      if ('error' in parsed) {
        errors.push({
          row: 0,
          code: parsed.error.code,
          message: parsed.error.message,
          ...(parsed.error.value !== undefined && {
            value: parsed.error.value,
          }),
          file: source.name,
          line: parsed.error.line,
        });
        continue;
      }

      features.push(parsed);
      lint.push(
        ...parsed.lint.map((issue) => ({
          row: 0,
          ...issue,
          file: source.name,
        })),
      );
      scenarios += parsed.scenarios.length;

      if (scenarios > TEST_TRANSFER_LIMITS.featureScenarios) {
        throw fileError(
          `The upload has more than ${TEST_TRANSFER_LIMITS.featureScenarios} scenarios`,
          undefined,
          'TOO_MANY_SCENARIOS',
        );
      }

      // Parsing blocks the server, so other requests get a turn between files.
      await nextLoopTurn();
    }

    const paths = await this.spaceFolderPaths(organizationId, spaceId);
    const base = this.basePath(paths, options.folder_id);
    const items = this.buildItems(features, base, errors, warnings);

    await this.matchCases(
      organizationId,
      spaceId,
      items,
      new Set(types.filter((t) => t.kind === 'gherkin').map((t) => t.id)),
      paths,
      await this.can(user, spaceId, 'edit_tests'),
      errors,
      warnings,
    );

    return {
      files: sources.length,
      scenarios,
      features,
      items,
      gherkinType: gherkin.id,
      errors,
      warnings,
      lint,
    };
  }

  private async readFiles(
    file: Express.Multer.File,
    warnings: TransferIssue[],
  ): Promise<SourceFile[]> {
    const lower = file.originalname.toLowerCase();

    if (lower.endsWith('.feature') && !isZip(file.buffer)) {
      const name = normalisePath(file.originalname).split('/').pop() ?? '';

      return [{ name, data: file.buffer }];
    }

    if (!lower.endsWith('.zip') || !isZip(file.buffer)) {
      throw fileError(
        'Choose a .feature or .zip file',
        undefined,
        'FILE_WRONG_TYPE',
      );
    }

    const { entries, skipped } = await readZipEntries(file.buffer, {
      maxEntries: TEST_TRANSFER_LIMITS.featureZipEntries,
      maxBytes: TEST_TRANSFER_LIMITS.zipBytes,
      accept: (name) => name.toLowerCase().endsWith('.feature'),
    });

    if (skipped.length > 0) {
      warnings.push({
        row: 0,
        code: 'FILES_SKIPPED',
        message:
          skipped.length === 1
            ? '1 file that is not a .feature file was skipped'
            : `${skipped.length} files that are not .feature files were skipped`,
        value: String(skipped.length),
      });
    }

    if (entries.length === 0) {
      throw fileError(
        'The ZIP file has no .feature files',
        undefined,
        'ZIP_NO_FEATURES',
      );
    }

    // Full paths: a file keeps its identity whatever else is in the ZIP.
    return entries.map((e) => ({
      name: normalisePath(e.name),
      data: e.data,
    }));
  }

  private buildItems(
    features: ParsedFeature[],
    base: string[],
    errors: TransferIssue[],
    warnings: TransferIssue[],
  ): Item[] {
    const destination = base.join('/');
    const items: Item[] = [];
    const keys = new Set<string>();
    let row = 0;

    for (const feature of features) {
      const folderPath = this.folderFor(feature.path, base, warnings);
      const titles = new Set<string>();

      for (const scenario of feature.scenarios) {
        const tagKeys = scenarioKeys(scenario.tags);
        const title = scenario.name.trim().slice(0, MAX_NAME).trim();
        const automationKey = featureAutomationKey(
          destination,
          feature.path,
          tagKeys.id ?? scenario.name.trim(),
        );
        const item: Item = {
          row: ++row,
          feature,
          scenario,
          title,
          automationKey,
          testKey: tagKeys.testKey,
          folderPath,
          out: {
            file: feature.path,
            line: scenario.line,
            title,
            action: 'create',
          },
        };
        const lowerTitle = title.toLowerCase();

        items.push(item);

        if (title === '') {
          this.fail(item, errors, 'TITLE_MISSING', 'The scenario has no name');
        } else if (titles.has(lowerTitle) || keys.has(automationKey)) {
          this.fail(
            item,
            errors,
            'DUPLICATE_SCENARIO',
            'Another scenario in this upload has the same name or id',
          );
        } else if (tagKeys.testKeys.length > 1) {
          this.fail(
            item,
            errors,
            'TEST_KEY_CONFLICT',
            `The scenario names more than one test: ${tagKeys.testKeys.join(', ')}`,
            tagKeys.testKeys.join(', '),
          );
        } else if (scenario.definition.length > MAX_DEFINITION) {
          this.fail(
            item,
            errors,
            'DEFINITION_TOO_LONG',
            `The scenario is longer than ${MAX_DEFINITION} characters`,
          );
        }

        titles.add(lowerTitle);
        keys.add(automationKey);
      }
    }

    return items;
  }

  /** Feature folders plus the file name; levels beyond the limit are joined into the deepest folder. */
  private folderFor(
    path: string,
    base: string[],
    warnings: TransferIssue[],
  ): string {
    const parts = path.split('/');
    const fileName = (parts.pop() ?? '').replace(/\.feature$/i, '');
    let segments = [...parts, fileName]
      .map((s) => s.trim().slice(0, MAX_NAME).trim())
      .filter((s) => s !== '' && s !== '.');
    const room = TEST_TRANSFER_LIMITS.folderDepth - base.length;

    if (segments.length > room) {
      // '/' separates folders, so joined names use ' - '.
      segments =
        room <= 0
          ? []
          : [
              ...segments.slice(0, room - 1),
              segments
                .slice(room - 1)
                .join(' - ')
                .slice(0, MAX_NAME)
                .trim(),
            ];
      warnings.push({
        row: 0,
        code: 'FOLDER_FLATTENED',
        message: `Folders can be at most ${TEST_TRANSFER_LIMITS.folderDepth} levels deep; the deepest ones were joined`,
        file: path,
      });
    }

    return [...base, ...segments].join('/');
  }

  private async matchCases(
    organizationId: string,
    spaceId: string,
    items: Item[],
    gherkinTypes: Set<string>,
    folders: Map<string, string>,
    canEdit: boolean,
    errors: TransferIssue[],
    warnings: TransferIssue[],
  ): Promise<void> {
    const open = items.filter((i) => i.out.action !== 'error');
    const byTestKey = await this.casesByTestKey(organizationId, spaceId, [
      ...new Set(open.flatMap((i) => (i.testKey ? [i.testKey] : []))),
    ]);
    const byAutomationKey = await this.casesByAutomationKey(
      organizationId,
      spaceId,
      open.filter((i) => !i.testKey).map((i) => i.automationKey),
    );
    const claimed = new Set<string>();

    for (const item of open) {
      const found = item.testKey
        ? byTestKey.get(item.testKey)
        : byAutomationKey.get(item.automationKey);
      const value = item.testKey;

      if (!found) {
        if (item.testKey) {
          this.fail(
            item,
            errors,
            'TEST_KEY_UNKNOWN',
            `No test case has the key ${item.testKey} in this space`,
            value,
          );
        }
        continue;
      }

      if (found.is_archived) {
        this.fail(
          item,
          errors,
          'TEST_KEY_ARCHIVED',
          `Test case ${found.key} is archived`,
          found.key,
        );
      } else if (!gherkinTypes.has(found.test_type)) {
        this.fail(
          item,
          errors,
          'TEST_TYPE_MISMATCH',
          `Test case ${found.key} is not a Cucumber test`,
          found.key,
        );
      } else if (
        // A key tag names its test on purpose; a matching path may be a test someone moved away.
        !item.testKey &&
        (folders.get(found.folder_id ?? '') ?? '').toLowerCase() !==
          item.folderPath.toLowerCase()
      ) {
        this.fail(
          item,
          errors,
          'CASE_IN_OTHER_FOLDER',
          `Test case ${found.key} came from this file but is now in another folder, so it was not changed`,
          found.key,
        );
      } else if (claimed.has(found.id)) {
        this.fail(
          item,
          errors,
          'DUPLICATE_SCENARIO',
          `Another scenario already updates test case ${found.key}`,
          found.key,
        );
      } else {
        claimed.add(found.id);
        item.target = found;
        item.out.case_key = found.key;
        item.out.action =
          found.title === item.title &&
          sameText(found.definition, item.scenario.definition)
            ? 'unchanged'
            : 'update';

        if (item.out.action === 'update' && !canEdit) {
          this.fail(
            item,
            errors,
            'CASE_EDIT_NOT_ALLOWED',
            `You cannot change test case ${found.key}`,
            found.key,
          );
        }
      }
    }

    await this.markExisting(
      organizationId,
      spaceId,
      open.filter((i) => i.out.action === 'create'),
      folders,
      warnings,
    );
  }

  /** The same rule as the import function, so the review says what the import will really do. */
  private async markExisting(
    organizationId: string,
    spaceId: string,
    items: Item[],
    folders: Map<string, string>,
    warnings: TransferIssue[],
  ): Promise<void> {
    const titles = [...new Set(items.map((i) => i.title))];

    for (let i = 0; i < titles.length; i += TITLE_CHUNK) {
      const { data, error } = await this.client
        .from('test_cases')
        .select(`folder_id, ${ticketEmbed('test_cases', 'key, summary')}`)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .eq('is_archived', false)
        .in('task.summary', titles.slice(i, i + TITLE_CHUNK))
        .returns<
          {
            folder_id: string | null;
            task: { key: string; summary: string };
          }[]
        >();

      if (error) throw tmDbError(this.logger, 'find same-named tests', error);

      for (const row of data ?? []) {
        const path = (folders.get(row.folder_id ?? '') ?? '').toLowerCase();

        for (const item of items) {
          if (
            item.title.toLowerCase() ===
              row.task.summary.trim().toLowerCase() &&
            item.folderPath.toLowerCase() === path
          ) {
            item.out.action = 'exists';
            item.out.case_key = row.task.key;
            warnings.push({
              row: item.row,
              code: 'DUPLICATE_SKIPPED',
              message: `A test case named "${item.title}" already exists in this folder`,
              value: item.title,
              file: item.out.file,
              line: item.out.line,
            });
          }
        }
      }
    }
  }

  /** Precondition ids per background: named by key, else an identical one, else a new one. */
  private async resolvePreconditions(
    user: RequestUser,
    spaceId: string,
    analysis: Analysis,
    items: Item[],
  ): Promise<{
    idsFor: (item: Item) => string[];
    created: { id: string; key: string }[];
  }> {
    const resolved = new Map<GherkinBackground, string[]>();
    const created: { id: string; key: string }[] = [];
    const idsFor = (item: Item): string[] => [
      ...new Set(
        item.scenario.backgroundIds.flatMap(
          (b) => resolved.get(item.feature.backgrounds[b]) ?? [],
        ),
      ),
    ];
    const needed = new Set<GherkinBackground>(
      items.flatMap((i) =>
        i.scenario.backgroundIds.map((b) => i.feature.backgrounds[b]),
      ),
    );

    if (needed.size === 0) return { idsFor, created };

    const { gherkinType, warnings } = analysis;
    const byKey = await this.preconditionsByKey(user.organizationId, spaceId, [
      ...new Set([...needed].flatMap((b) => b.precondKeys)),
    ]);
    // By text, so each background finds its match without scanning them all.
    const pool = new Map<string, PreconditionRow>();

    if ([...needed].some((b) => b.precondKeys.length === 0)) {
      const active = await this.activePreconditions(
        user.organizationId,
        spaceId,
        gherkinType,
      );

      for (const row of active) {
        const text = normText(row.definition);

        if (!pool.has(text)) pool.set(text, row);
      }
    }

    for (const feature of analysis.features) {
      for (const bg of feature.backgrounds.filter((b) => needed.has(b))) {
        const where = { row: 0, file: feature.path, line: bg.line };

        if (bg.precondKeys.length > 0) {
          const ids: string[] = [];

          for (const key of bg.precondKeys) {
            const found = byKey.get(key);

            if (
              found &&
              !found.is_archived &&
              found.test_type === gherkinType
            ) {
              ids.push(found.id);
            } else {
              warnings.push({
                ...where,
                code: 'PRECONDITION_UNKNOWN',
                message: `Precondition ${key} was not found or is not an active Cucumber precondition`,
                value: key,
              });
            }
          }

          resolved.set(bg, ids);
          continue;
        }

        const same = pool.get(normText(bg.definition));

        if (same) {
          resolved.set(bg, [same.id]);
          continue;
        }

        if (bg.definition.length > TEST_PRECONDITION_LIMITS.definition) {
          warnings.push({
            ...where,
            code: 'DEFINITION_TOO_LONG',
            message: `The background is longer than ${TEST_PRECONDITION_LIMITS.definition} characters`,
          });
          continue;
        }

        const title = (
          bg.name.trim() ||
          `${feature.featureName.trim() || feature.path} – Background`
        )
          .slice(0, TEST_PRECONDITION_LIMITS.title)
          .trim();

        try {
          const row = await this.preconditions.create(user, spaceId, {
            title,
            test_type: gherkinType,
            definition: bg.definition,
          });

          pool.set(normText(row.definition), row);
          created.push({ id: row.id, key: row.key });
          resolved.set(bg, [row.id]);
        } catch (error) {
          warnings.push({
            ...where,
            code: 'PRECONDITION_NOT_CREATED',
            message: `The background could not be saved as a precondition: ${errorText(error)}`,
          });
        }
      }
    }

    return { idsFor, created };
  }

  private async createCases(
    user: RequestUser,
    spaceId: string,
    items: Item[],
    gherkinType: string,
    idsFor: (item: Item) => string[],
    errors: TransferIssue[],
    warnings: TransferIssue[],
  ): Promise<{ case_id: string; key: string }[]> {
    const created: { case_id: string; key: string }[] = [];

    for (let i = 0; i < items.length; i += TEST_TRANSFER_LIMITS.importRows) {
      const chunk = items.slice(i, i + TEST_TRANSFER_LIMITS.importRows);
      const byRow = new Map<number, Item>(chunk.map((c) => [c.row, c]));
      const { data, error } = (await this.client.rpc('tm_import_cases', {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_rows: chunk.map((c) => ({
          row: c.row,
          title: c.title,
          folder_path: c.folderPath,
          readiness: 'draft',
          automation_key: c.automationKey,
          test_type: gherkinType,
          definition: c.scenario.definition,
          precondition_ids: idsFor(c),
        })),
        p_skip_duplicates: true,
      })) as { data: ImportFunctionResult | null; error: TmRpcError | null };

      if (error) {
        const failure = caseImportError(
          this.logger,
          'import feature scenarios',
          error,
        );
        const { code } = failure.getResponse() as { code?: string };

        // Without ticket settings no scenario can be saved, so the whole import is refused.
        if (code?.startsWith('TICKET_')) throw failure;

        for (const c of chunk) {
          this.fail(c, errors, 'CASE_NOT_CREATED', failure.message);
        }
        continue;
      }

      for (const row of data?.created ?? []) {
        const item = byRow.get(Number(row.row));

        if (!item) continue;

        item.caseId = row.case_id;
        item.out.case_key = row.key;
        created.push({ case_id: row.case_id, key: row.key });
      }

      for (const row of data?.skipped ?? []) {
        const item = byRow.get(Number(row.row));

        if (!item) continue;

        warnings.push({
          row: item.row,
          code: 'DUPLICATE_SKIPPED',
          message: `A test case named "${item.title}" already exists in this folder`,
          value: item.title,
          file: item.out.file,
          line: item.out.line,
        });
      }
    }

    return created;
  }

  private async updateCases(
    user: RequestUser,
    spaceId: string,
    items: Item[],
    canEdit: boolean,
    errors: TransferIssue[],
  ): Promise<{ case_id: string; key: string }[]> {
    const updated: { case_id: string; key: string }[] = [];

    for (const item of items) {
      const target = item.target as TargetCase;

      if (!canEdit) {
        this.fail(
          item,
          errors,
          'CASE_EDIT_NOT_ALLOWED',
          `You cannot change test case ${target.key}`,
          target.key,
        );
        continue;
      }

      try {
        await this.cases.update(user, spaceId, target.id, {
          expected_revision: target.revision,
          ...(!sameText(target.definition, item.scenario.definition) && {
            definition: item.scenario.definition,
          }),
          ...(target.title !== item.title && { title: item.title }),
        });
        item.caseId = target.id;
        updated.push({ case_id: target.id, key: target.key });
      } catch (error) {
        this.fail(
          item,
          errors,
          'CASE_NOT_UPDATED',
          `Test case ${target.key} was not updated: ${errorText(error)}`,
          target.key,
        );
      }
    }

    return updated;
  }

  /** Plain feature, Rule and scenario tags become labels of the saved cases; labels set by hand stay. */
  private async addLabels(
    user: RequestUser,
    spaceId: string,
    items: Item[],
    warnings: TransferIssue[],
  ): Promise<void> {
    try {
      await addCaseLabels(
        this.client,
        this.logger,
        user.organizationId,
        spaceId,
        user.userId,
        items.map((item) => ({
          caseId: item.caseId as string,
          labels: item.scenario.labels,
        })),
      );
    } catch (error) {
      warnings.push({
        row: 0,
        code: 'LABELS_NOT_SAVED',
        message: `The scenario tags were not saved as labels: ${errorText(error)}`,
      });
    }
  }

  /** Adds the background preconditions an existing case lacks; links made by hand are kept. */
  private async addPreconditions(
    user: RequestUser,
    spaceId: string,
    items: Item[],
    gherkinType: string,
    idsFor: (item: Item) => string[],
    canEdit: boolean,
    warnings: TransferIssue[],
  ): Promise<void> {
    for (const item of items) {
      const target = item.target as TargetCase;
      const current = target.precondition_ids ?? [];
      const missing = idsFor(item).filter((id) => !current.includes(id));

      if (missing.length === 0) continue;

      const where = {
        row: item.row,
        file: item.out.file,
        line: item.out.line,
        value: target.key,
      };

      if (!canEdit || target.test_type !== gherkinType) {
        warnings.push({
          ...where,
          code: canEdit
            ? 'PRECONDITIONS_NOT_SET'
            : 'PRECONDITIONS_EDIT_NOT_ALLOWED',
          message: `The background preconditions were not added to ${target.key}`,
        });
        continue;
      }

      try {
        await this.preconditions.setCasePreconditions(
          user,
          spaceId,
          target.id,
          {
            precondition_ids: [...current, ...missing],
          },
        );
      } catch (error) {
        warnings.push({
          ...where,
          code: 'PRECONDITIONS_NOT_SET',
          message: `The background preconditions were not added to ${target.key}: ${errorText(error)}`,
        });
      }
    }
  }

  /** Feature `@REQ_<KEY>` tags link every saved case of that file, as the link screen does. */
  private async linkRequirements(
    user: RequestUser,
    spaceId: string,
    features: ParsedFeature[],
    items: Item[],
    canEdit: boolean,
    warnings: TransferIssue[],
  ): Promise<number> {
    const wanted = features
      .map((feature) => ({
        feature,
        keys: requirementKeys(feature.featureTags),
      }))
      .filter((w) => w.keys.length > 0);

    if (wanted.length === 0) return 0;

    if (!canEdit) {
      warnings.push({
        row: 0,
        code: 'REQUIREMENTS_EDIT_NOT_ALLOWED',
        message: 'You cannot link requirements, so the @REQ tags were not used',
      });

      return 0;
    }

    const { tickets, visible } = await this.visibleTickets(user, spaceId, [
      ...new Set(wanted.flatMap((w) => w.keys)),
    ]);
    const reported = new Set<string>();
    let added = 0;

    for (const { feature, keys } of wanted) {
      const taskIds: string[] = [];

      for (const key of keys) {
        const id = tickets.get(key);

        // Missing and hidden tickets look the same, as on the link screen.
        if (id && visible.has(id)) taskIds.push(id);
        else if (!reported.has(key)) {
          reported.add(key);
          warnings.push({
            row: 0,
            code: 'REQUIREMENT_UNKNOWN',
            message: `Requirement ${key} was not found or is not visible to you`,
            value: key,
            file: feature.path,
          });
        }
      }

      const caseIds = items
        .filter((i) => i.feature === feature && i.caseId)
        .map((i) => i.caseId as string);

      for (const caseId of taskIds.length > 0 ? caseIds : []) {
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

            added += change.added;
          } catch (error) {
            warnings.push({
              row: 0,
              code: 'REQUIREMENTS_NOT_LINKED',
              message: `Requirements could not be linked: ${errorText(error)}`,
              file: feature.path,
            });
          }
        }
      }
    }

    return added;
  }

  private fail(
    item: Item,
    errors: TransferIssue[],
    code: string,
    message: string,
    value?: string,
  ): void {
    item.out.action = 'error';
    errors.push({
      row: item.row,
      code,
      message,
      file: item.out.file,
      line: item.out.line,
      ...(value !== undefined && { value }),
    });
  }

  /** Path of every folder of the space, by id. */
  private async spaceFolderPaths(
    organizationId: string,
    spaceId: string,
  ): Promise<Map<string, string>> {
    const { rows } = await fetchAllRows<FolderNode>(async (from, to) => {
      const page = await this.client
        .from('test_folders')
        .select('id, parent_id, name')
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .order('id')
        .range(from, to)
        .returns<FolderNode[]>();

      if (page.error) throw tmDbError(this.logger, 'load folders', page.error);

      return page;
    });

    return folderPaths(rows);
  }

  /** Path segments of the chosen base folder, root first. */
  private basePath(
    paths: Map<string, string>,
    folderId: string | undefined,
  ): string[] {
    if (!folderId) return [];

    const path = paths.get(folderId);

    if (path === undefined) throw notFound();

    const segments = path.split('/');

    // Folders can nest without limit, but the import function stops at this depth.
    if (segments.length > TEST_TRANSFER_LIMITS.folderDepth) {
      throw fileError(
        `This folder is more than ${TEST_TRANSFER_LIMITS.folderDepth} levels deep, so nothing can be imported into it`,
        undefined,
        'FOLDER_TOO_DEEP',
      );
    }

    return segments;
  }

  /** Test cases named by their ticket's key. */
  private async casesByTestKey(
    organizationId: string,
    spaceId: string,
    keys: string[],
  ): Promise<Map<string, TargetCase>> {
    const found = new Map<string, TargetCase>();

    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      const { data, error } = await this.client
        .from('test_cases')
        .select(CASE_COLUMNS)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .in('task.key', keys.slice(i, i + KEY_CHUNK))
        .returns<TargetCaseRow[]>();

      if (error) throw tmDbError(this.logger, 'match test keys', error);

      for (const row of data ?? []) found.set(row.task.key, targetCase(row));
    }

    return found;
  }

  private async casesByAutomationKey(
    organizationId: string,
    spaceId: string,
    keys: string[],
  ): Promise<Map<string, TargetCase>> {
    const unique = [...new Set(keys)];
    const found = new Map<string, TargetCase>();

    for (let i = 0; i < unique.length; i += KEY_CHUNK) {
      const { data, error } = await this.client
        .from('test_cases')
        .select(`${CASE_COLUMNS}, automation_key`)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .in('automation_key', unique.slice(i, i + KEY_CHUNK))
        .returns<(TargetCaseRow & { automation_key: string })[]>();

      if (error) throw tmDbError(this.logger, 'match automation keys', error);

      for (const { automation_key, ...row } of data ?? []) {
        found.set(automation_key, targetCase(row));
      }
    }

    return found;
  }

  private async preconditionsByKey(
    organizationId: string,
    spaceId: string,
    keys: string[],
  ): Promise<Map<string, PreconditionRow>> {
    const found = new Map<string, PreconditionRow>();

    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      const { data, error } = await this.client
        .from('test_preconditions')
        .select('id, key, test_type, definition, is_archived')
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .in('key', keys.slice(i, i + KEY_CHUNK))
        .returns<PreconditionRow[]>();

      if (error) throw tmDbError(this.logger, 'match precondition keys', error);

      for (const row of data ?? []) found.set(row.key, row);
    }

    return found;
  }

  /** Active preconditions of the Cucumber type; definitions are compared here, not in the URL. */
  private async activePreconditions(
    organizationId: string,
    spaceId: string,
    testType: string,
  ): Promise<PreconditionRow[]> {
    const rows: PreconditionRow[] = [];

    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.client
        .from('test_preconditions')
        .select('id, key, test_type, definition, is_archived')
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .eq('test_type', testType)
        .eq('is_archived', false)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
        .returns<PreconditionRow[]>();

      if (error) throw tmDbError(this.logger, 'load preconditions', error);

      rows.push(...(data ?? []));

      if ((data ?? []).length < PAGE) return rows;
    }
  }

  /** Ticket ids by key in this space, and which of them the user may see; only those can be linked. */
  private async visibleTickets(
    user: RequestUser,
    spaceId: string,
    keys: string[],
  ): Promise<{ tickets: Map<string, string>; visible: Map<string, unknown> }> {
    const tickets = new Map<string, string>();

    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      const { data, error } = await this.client
        .from('tasks')
        .select('id, key')
        .eq('organization_id', user.organizationId)
        .eq('space_id', spaceId)
        .in('key', keys.slice(i, i + KEY_CHUNK))
        .returns<{ id: string; key: string }[]>();

      if (error) throw tmDbError(this.logger, 'match ticket keys', error);

      for (const row of data ?? []) tickets.set(row.key, row.id);
    }

    const visible =
      tickets.size > 0
        ? await this.visibility.visibleTasks(user, [...tickets.values()])
        : new Map<string, unknown>();

    return { tickets, visible };
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
}
