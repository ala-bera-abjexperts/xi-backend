import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { dialects, type Dialect } from '@cucumber/gherkin';
import type { Archiver } from 'archiver';
import { setImmediate as nextLoopTurn } from 'timers/promises';

import type { RequestUser } from '../../../auth/interfaces/request-user.interface';
import { fetchAllRows } from '../../../common/utils/fetch-all-rows';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../../access/test-management-access.service';
import { cleanLabels } from '../../common/case-labels';
import { TaskVisibilityService } from '../../common/task-visibility.service';
import {
  ticketEmbed,
  ticketKeyNumber,
  ticketName,
} from '../../common/ticket-keys';
import { TEST_CASE_LIMITS } from '../../dto/test-case.dto';
import { TEST_REPORT_LIMITS } from '../../dto/test-report.dto';
import {
  TEST_TRANSFER_LIMITS,
  type FeatureExportQueryDto,
  type FeatureExportScope,
} from '../../dto/test-transfer.dto';
import { notFound, tmDbError } from '../../test-management-errors';
import {
  isKeyTag,
  parseFeatureFile,
  requirementKeys,
  scenarioKeys,
  type ParsedFeature,
} from '../gherkin/gherkin.util';
import { folderSubtree } from '../shared/folder-path.util';
import type { FolderNode } from '../shared/transfer-helpers';

const CHUNK = 100;
const MAX_FILE_NAME = 50;
const CASES_PER_TURN = 200;
const LANGUAGE_LINE = /^\s*#\s*language:\s*(\S+)\s*$/;
const PRECOND_COMMENT = /^\s*#\s*@PRECOND_/i;

const CASE_SELECT = `id, test_type, definition, precondition_ids, labels, ${ticketEmbed('test_cases')}`;

interface CaseRow {
  id: string;
  task: { key: string; summary: string };
  test_type: string | null;
  definition: string | null;
  precondition_ids: string[] | null;
  labels: string[] | null;
}

interface PreconditionRow {
  id: string;
  key: string;
  definition: string | null;
  test_type: string | null;
  is_archived: boolean;
}

interface DbError {
  code?: string;
  message: string;
}

type Rows<T> = PromiseLike<{ data: T[] | null; error: DbError | null }>;

export interface ExportPrecondition {
  key: string;
  definition: string | null;
}

export interface ExportRequirement {
  key: string;
  summary: string;
}

export interface ExportCase {
  key: string;
  title: string;
  definition: string | null;
  gherkin: boolean;
  // Written as tags next to the ones in the definition.
  labels?: string[];
  // Active Cucumber preconditions in the case's order.
  preconditions: ExportPrecondition[];
  // Requirement tickets the caller may see.
  requirements: ExportRequirement[];
}

export interface FeatureFile {
  name: string;
  text: string;
}

export interface SkippedCase {
  key: string;
  title: string;
  reason: string;
}

interface StoredScenario {
  language: string;
  tags: string[];
  lines: string[];
}

interface GroupCase {
  key: string;
  tags: string[];
  lines: string[];
}

interface Group {
  language: string;
  requirements: ExportRequirement[];
  preconditions: { key: string; lines: string[] }[];
  cases: GroupCase[];
  firstTitle: string;
  // Lower-case titles in this file and its size so far, against the import's limits.
  titles: Set<string>;
  bytes: number;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

// Spaces inside a title stay, otherwise re-importing would rename the ticket.
const scenarioName = (text: string): string =>
  text.replace(/\s*[\r\n]+\s*/g, ' ').trim();

// The way the import compares titles within one file.
const titleId = (title: string): string =>
  scenarioName(title).slice(0, TEST_CASE_LIMITS.title).trim().toLowerCase();

const indented = (lines: string[], by: string): string[] =>
  lines.map((l) => (l === '' ? '' : `${by}${l}`));

function dialectOf(language: string): Dialect | undefined {
  return Object.prototype.hasOwnProperty.call(dialects, language)
    ? dialects[language]
    : undefined;
}

function dedent(lines: string[]): string[] {
  const block = [...lines];

  while (block.length > 0 && block[0].trim() === '') block.shift();
  while (block.length > 0 && block[block.length - 1].trim() === '') {
    block.pop();
  }

  const indents = block
    .filter((l) => l.trim() !== '')
    .map((l) => (/^[ \t]*/.exec(l) as RegExpExecArray)[0].length);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;

  return block.map((l) => (l.trim() === '' ? '' : l.slice(indent).trimEnd()));
}

function splitLanguage(definition: string): {
  language?: string;
  lines: string[];
} {
  const lines = definition
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const language = LANGUAGE_LINE.exec(lines[0] ?? '')?.[1];

  return { language, lines: language ? lines.slice(1) : lines };
}

const withLanguage = (language: string, lines: string[]): string =>
  [...(language === 'en' ? [] : [`# language: ${language}`]), ...lines].join(
    '\n',
  );

/** Parsed by the import's own reader, so what passes here also reads back. */
function readBack(
  language: string,
  lines: string[],
): ParsedFeature | { error: string } {
  const dialect = dialectOf(language) as Dialect;
  const parsed = parseFeatureFile(
    withLanguage(language, [`${dialect.feature[0]}: x`, ...lines]),
    '',
  );

  if ('error' in parsed) return { error: parsed.error.message };

  // A Rule would take in the cases written after it in the same file.
  if (parsed.hasRule) return { error: 'A Rule cannot be part of a test' };

  return parsed;
}

/** A stored scenario with its header named after the case; a missing header is added. */
export function storedScenario(
  definition: string,
  title: string,
  caseKey: string,
): StoredScenario | { error: string } {
  const split = splitLanguage(definition);
  const language = split.language ?? 'en';
  const dialect = dialectOf(language);

  if (!dialect) return { error: `Unknown language ${language}` };

  const tags: string[] = [];
  let i = 0;

  for (; i < split.lines.length; i++) {
    const line = split.lines[i].trim();

    if (line !== '' && !line.startsWith('@')) break;

    // Split at every @ as the parser does; stored key tags would point at other tests.
    tags.push(
      ...line
        .replace(/\s+#.*$/, '')
        .split(/\s+|(?=@)/)
        .filter((t) => t.startsWith('@') && !isKeyTag(t.slice(1))),
    );
  }

  const body = dedent(split.lines.slice(i));
  const name = scenarioName(title);
  const header = body.findIndex((l) => l !== '' && !l.startsWith('#'));
  const keyword =
    header < 0
      ? undefined
      : [...dialect.scenarioOutline, ...dialect.scenario].find((k) =>
          body[header].startsWith(`${k}:`),
        );
  let lines: string[];

  if (keyword) {
    lines = [...body];
    lines[header] = `${keyword}: ${name}`;
  } else {
    lines = [
      `${dialect.scenario[dialect.scenario.length - 1]}: ${name}`,
      ...indented(body, '  '),
    ];
  }

  const unique = [...new Set([`@TEST_${caseKey}`, ...tags])];
  const parsed = readBack(language, [unique.join(' '), ...lines]);

  if ('error' in parsed) return parsed;

  // A second scenario would come back without a key and become a new test.
  if (parsed.scenarios.length !== 1 || parsed.backgrounds.length > 0) {
    return { error: 'A test must hold exactly one scenario' };
  }

  const keys = scenarioKeys(parsed.scenarios[0].tags).testKeys;

  if (keys.length !== 1 || keys[0] !== caseKey) {
    return { error: `The key ${caseKey} cannot be written as a test tag` };
  }

  return { language, tags: unique, lines };
}

/** Steps of a stored precondition for a Background in `language`, without its own header. */
export function backgroundBody(
  definition: string | null,
  language: string,
): string[] | { error: string } {
  const split = splitLanguage(definition ?? '');
  const dialect = dialectOf(language) as Dialect;
  const keywords = [
    ...dialect.background,
    ...(dialectOf(split.language ?? 'en')?.background ?? []),
  ];
  const body = dedent(split.lines.filter((l) => !PRECOND_COMMENT.test(l)));

  if (body.length > 0 && keywords.some((k) => body[0].startsWith(`${k}:`))) {
    body.splice(0, 1);
  }

  const lines = dedent(body);
  const parsed = readBack(language, [
    `${dialect.background[0]}:`,
    ...indented(lines, '  '),
  ]);

  if ('error' in parsed) return parsed;

  return parsed.scenarios.length > 0
    ? { error: 'A precondition cannot hold a scenario' }
    : lines;
}

const caseBlock = (c: GroupCase): string[] => [
  `  ${c.tags.join(' ')}`,
  ...indented(c.lines, '  '),
  '',
];

function featureText(group: Group, contextTitle?: string): string {
  const dialect = dialectOf(group.language) as Dialect;
  const only =
    group.requirements.length === 1 ? group.requirements[0].summary : undefined;
  const title = oneLine(only ?? contextTitle ?? group.firstTitle);
  const out: string[] = [
    ...(group.language === 'en' ? [] : [`# language: ${group.language}`]),
    ...(group.requirements.length > 0
      ? [group.requirements.map((r) => `@REQ_${r.key}`).join(' ')]
      : []),
    `${dialect.feature[0]}: ${title}`,
    '',
  ];

  if (group.preconditions.length > 0) {
    out.push(
      `  ${dialect.background[0]}:`,
      ...group.preconditions.map((p) => `    #@PRECOND_${p.key}`),
      ...group.preconditions.flatMap((p) => indented(p.lines, '    ')),
      '',
    );
  }

  out.push(...group.cases.flatMap(caseBlock));

  while (out[out.length - 1] === '') out.pop();

  return `${out.join('\n')}\n`;
}

/**
 * One .feature file per language, requirement set and precondition list, in the layout the feature
 * import reads back to the same cases. Each case is in exactly one file, with all its @REQ_ tags on
 * the Feature line. A further file is started only where the import would refuse the first one:
 * a repeated title, or a file over its limits.
 */
export async function buildFeatureFiles(
  cases: ExportCase[],
  contextTitle?: string,
): Promise<{ files: FeatureFile[]; skipped: SkippedCase[] }> {
  const groups = new Map<string, Group[]>();
  const skipped: SkippedCase[] = [];
  const skip = (c: ExportCase, reason: string) =>
    skipped.push({ key: c.key, title: c.title, reason });

  for (const [index, c] of cases.entries()) {
    // Parsing blocks the server, so other requests get a turn.
    if (index > 0 && index % CASES_PER_TURN === 0) await nextLoopTurn();

    if (!c.gherkin) {
      skip(c, 'Not a Cucumber test');
      continue;
    }

    if (!c.definition?.trim()) {
      skip(c, 'The test has no definition');
      continue;
    }

    const scenario = storedScenario(c.definition, c.title, c.key);

    if ('error' in scenario) {
      skip(c, `The definition cannot be exported: ${scenario.error}`);
      continue;
    }

    const preconditions: Group['preconditions'] = [];
    let failed: string | undefined;

    for (const p of c.preconditions) {
      const lines = backgroundBody(p.definition, scenario.language);

      if (Array.isArray(lines)) preconditions.push({ key: p.key, lines });
      else {
        failed = `Precondition ${p.key} cannot be exported: ${lines.error}`;
        break;
      }
    }

    if (failed) {
      skip(c, failed);
      continue;
    }

    const requirements = c.requirements.filter(
      (r) => requirementKeys([`REQ_${r.key}`])[0] === r.key,
    );
    const id = [
      scenario.language,
      requirements
        .map((r) => r.key)
        .sort()
        .join(','),
      preconditions.map((p) => p.key).join(','),
    ].join('\n');
    const entry: GroupCase = {
      key: c.key,
      tags: [
        ...new Set([
          ...scenario.tags,
          ...cleanLabels(c.labels ?? [])
            .filter((label) => !isKeyTag(label))
            .map((label) => `@${label}`),
        ]),
      ],
      lines: scenario.lines,
    };
    const title = titleId(c.title);
    const size = Buffer.byteLength(`${caseBlock(entry).join('\n')}\n`, 'utf8');
    const parts = groups.get(id) ?? [];
    let group = parts.find(
      (g) =>
        !g.titles.has(title) &&
        g.cases.length < TEST_TRANSFER_LIMITS.featureScenarios &&
        g.bytes + size <= TEST_TRANSFER_LIMITS.featureFileBytes,
    );

    if (!group) {
      group = {
        language: scenario.language,
        requirements,
        preconditions,
        cases: [],
        firstTitle: c.title,
        titles: new Set(),
        bytes: 0,
      };
      group.bytes = Buffer.byteLength(featureText(group, contextTitle), 'utf8');
      parts.push(group);
      groups.set(id, parts);
    }

    group.cases.push(entry);
    group.titles.add(title);
    group.bytes += size;
  }

  const files = [...groups.values()].flat().map((group, index) => {
    const label =
      group.requirements.length > 0
        ? group.requirements.map((r) => r.key).join(',')
        : group.cases.map((c) => c.key).join(',');
    const precondKeys = group.preconditions.map((p) => p.key).join(',');

    // The index keeps names unique after the cut.
    const name = `${index + 1}_${label}${precondKeys ? `_${precondKeys}` : ''}`
      .slice(0, MAX_FILE_NAME)
      .replace(/[^\w,.-]/g, '_');

    return {
      name: `${name}.feature`,
      text: featureText(group, contextTitle),
    };
  });

  return { files, skipped };
}

export const skippedText = (skipped: SkippedCase[]): string =>
  skipped
    .map((s) => `${s.key}\t${oneLine(s.title)}\t${oneLine(s.reason)}\n`)
    .join('');

function exportError(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}

const chunks = (ids: string[]): string[][] => {
  const out: string[][] = [];

  for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));

  return out;
};

/** Cucumber test cases of a space, folder, set, plan, execution or single case as a .zip of .feature files. */
@Injectable()
export class FeatureExportService {
  private readonly logger = new Logger(FeatureExportService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly visibility: TaskVisibilityService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async export(
    user: RequestUser,
    spaceId: string,
    query: FeatureExportQueryDto,
  ): Promise<{ fileName: string; buffer: Buffer }> {
    const organizationId = user.organizationId;

    await this.access.assertAvailable(organizationId, spaceId);

    if (query.scope !== 'space' && !query.id) {
      throw exportError('ID_REQUIRED', 'Choose what to export');
    }

    const scope = await this.resolveScope(
      organizationId,
      spaceId,
      query.scope,
      query.id ?? '',
    );
    const rows = await this.loadCases(
      organizationId,
      spaceId,
      scope,
      query.include_archived === true,
    );
    const gherkinTypes = await this.gherkinTypes(organizationId, spaceId);
    const preconditions = await this.preconditions(
      organizationId,
      spaceId,
      rows,
      gherkinTypes,
    );
    const requirements = await this.requirements(user, spaceId, rows);
    const { files, skipped } = await buildFeatureFiles(
      rows.map((row) => ({
        key: row.task.key,
        title: ticketName(row.task.summary),
        definition: row.definition,
        gherkin: gherkinTypes.has(row.test_type ?? ''),
        labels: row.labels ?? [],
        preconditions: (row.precondition_ids ?? []).flatMap((id) => {
          const found = preconditions.get(id);

          return found ? [found] : [];
        }),
        requirements: requirements.get(row.id) ?? [],
      })),
      scope.title,
    );

    if (files.length === 0) {
      throw exportError(
        'NOTHING_TO_EXPORT',
        'None of these tests can be exported as a .feature file',
      );
    }

    const entries = files.map((f) => ({ name: f.name, text: f.text }));

    if (skipped.length > 0) {
      entries.push({ name: 'skipped.txt', text: skippedText(skipped) });
    }

    const spaceKey = await this.spaceKey(organizationId, spaceId);

    return {
      fileName: `${spaceKey}-features-${new Date().toISOString().slice(0, 10)}.zip`,
      buffer: await this.zip(entries),
    };
  }

  /** Built in memory: at most 10,000 cases of 10,000 characters, so about 100 MB of text at worst. */
  protected async zip(entries: FeatureFile[]): Promise<Buffer> {
    const { ZipArchive } = await import('archiver');
    const archive: Archiver = new ZipArchive({ zlib: { level: 6 } });
    const parts: Buffer[] = [];
    const done = new Promise<void>((resolve, reject) => {
      archive.on('data', (chunk: Buffer) => parts.push(chunk));
      archive.once('end', () => resolve());
      archive.once('error', reject);
    });

    for (const entry of entries) {
      archive.append(Buffer.from(entry.text, 'utf8'), { name: entry.name });
    }

    // Together, so a failure in either is the one error the caller sees.
    await Promise.all([archive.finalize(), done]);

    return Buffer.concat(parts);
  }

  private async resolveScope(
    organizationId: string,
    spaceId: string,
    scope: FeatureExportScope,
    id: string,
  ): Promise<{ caseIds?: string[]; folderIds?: string[]; title?: string }> {
    if (scope === 'space') return {};

    if (scope === 'folder') {
      const folders = await this.allPages<FolderNode>(
        'load folders for export',
        (from, to) =>
          this.client
            .from('test_folders')
            .select('id, parent_id, name')
            .eq('space_id', spaceId)
            .eq('organization_id', organizationId)
            .order('id', { ascending: true })
            .range(from, to),
      );

      if (!folders.some((f) => f.id === id)) throw notFound();

      return { folderIds: [...folderSubtree(folders, id)] };
    }

    if (scope === 'case') {
      await this.one(organizationId, spaceId, 'test_cases', id, 'id');

      return { caseIds: [id] };
    }

    const source = {
      set: {
        table: 'test_sets' as const,
        members: 'test_set_members',
        on: 'set_id',
      },
      plan: {
        table: 'test_plans' as const,
        members: 'test_plan_tests',
        on: 'plan_id',
      },
      execution: {
        table: 'test_executions' as const,
        members: 'test_runs',
        on: 'execution_id',
      },
    }[scope];
    const owner = await this.one(
      organizationId,
      spaceId,
      source.table,
      id,
      `id, ${ticketEmbed(source.table, 'summary')}`,
    );
    const members = await this.allPages<{ case_id: string }>(
      `load ${scope} tests for export`,
      (from, to) =>
        this.client
          .from(source.members)
          .select('case_id')
          .eq(source.on, id)
          .eq('space_id', spaceId)
          .eq('organization_id', organizationId)
          .order('case_id', { ascending: true })
          .range(from, to)
          .returns<{ case_id: string }[]>(),
    );

    return {
      caseIds: [...new Set(members.map((m) => m.case_id))],
      // Executions keep the first test's title, like a space export.
      title:
        scope === 'execution' || !owner.task
          ? undefined
          : ticketName(owner.task.summary),
    };
  }

  private async one(
    organizationId: string,
    spaceId: string,
    table: string,
    id: string,
    columns: string,
  ): Promise<{ id: string; task?: { summary: string } }> {
    const { data, error } = await this.client
      .from(table)
      .select(columns)
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle<{ id: string; task?: { summary: string } }>();

    if (error) throw tmDbError(this.logger, `load ${table} for export`, error);
    if (!data) throw notFound();

    return data;
  }

  private async loadCases(
    organizationId: string,
    spaceId: string,
    scope: { caseIds?: string[]; folderIds?: string[] },
    includeArchived: boolean,
  ): Promise<CaseRow[]> {
    const max = TEST_REPORT_LIMITS.exportRows;
    const tooLarge = (count: number) =>
      new BadRequestException({
        code: 'EXPORT_TOO_LARGE',
        message: `The export has more than ${max} test cases. Choose a smaller part.`,
        data: { rows: count, max },
      });
    const filtered = (
      columns: string,
      head: boolean,
      column: string | null,
      ids: string[] | null,
    ) => {
      let q = this.client
        .from('test_cases')
        .select(columns, head ? { count: 'exact', head: true } : undefined)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId);

      if (!includeArchived) q = q.eq('is_archived', false);
      if (column && ids) q = q.in(column, ids);

      return q;
    };
    const rows: CaseRow[] = [];

    if (scope.caseIds) {
      if (scope.caseIds.length > max) throw tooLarge(scope.caseIds.length);

      for (const part of chunks(scope.caseIds)) {
        const { data, error } = await filtered(
          CASE_SELECT,
          false,
          'id',
          part,
        ).returns<CaseRow[]>();

        if (error) throw tmDbError(this.logger, 'load cases for export', error);

        rows.push(...(data ?? []));
      }
    } else {
      const parts = scope.folderIds ? chunks(scope.folderIds) : [null];
      let total = 0;

      for (const part of parts) {
        const { count, error } = await filtered('id', true, 'folder_id', part);

        if (error)
          throw tmDbError(this.logger, 'count cases for export', error);

        total += count ?? 0;
      }

      if (total > max) throw tooLarge(total);

      for (const part of parts) {
        rows.push(
          ...(await this.allPages<CaseRow>(
            'load cases for export',
            (from, to) =>
              filtered(CASE_SELECT, false, 'folder_id', part)
                .order('created_at', { ascending: true })
                .order('id', { ascending: true })
                .range(from, to)
                .returns<CaseRow[]>(),
          )),
        );
      }
    }

    return rows.sort(
      (a, b) => ticketKeyNumber(a.task.key) - ticketKeyNumber(b.task.key),
    );
  }

  private async gherkinTypes(
    organizationId: string,
    spaceId: string,
  ): Promise<Set<string>> {
    const { data, error } = await this.client
      .from('test_management_space_settings')
      .select('test_types')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle<{ test_types: { id: string; kind: string }[] | null }>();

    if (error) throw tmDbError(this.logger, 'load test types', error);

    return new Set(
      (data?.test_types ?? [])
        .filter((t) => t.kind === 'gherkin')
        .map((t) => t.id),
    );
  }

  /** Active Cucumber preconditions by id; archived and other kinds are left out, as the import would refuse them. */
  private async preconditions(
    organizationId: string,
    spaceId: string,
    cases: CaseRow[],
    gherkinTypes: Set<string>,
  ): Promise<Map<string, ExportPrecondition>> {
    const ids = [...new Set(cases.flatMap((c) => c.precondition_ids ?? []))];
    const found = new Map<string, ExportPrecondition>();

    for (const part of chunks(ids)) {
      const { data, error } = await this.client
        .from('test_preconditions')
        .select('id, key, definition, test_type, is_archived')
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .in('id', part)
        .returns<PreconditionRow[]>();

      if (error) throw tmDbError(this.logger, 'load preconditions', error);

      for (const row of data ?? []) {
        if (!row.is_archived && gherkinTypes.has(row.test_type ?? '')) {
          found.set(row.id, { key: row.key, definition: row.definition });
        }
      }
    }

    return found;
  }

  /** Requirement tickets per case id, sorted by key; tickets the caller cannot see are left out. */
  private async requirements(
    user: RequestUser,
    spaceId: string,
    cases: CaseRow[],
  ): Promise<Map<string, ExportRequirement[]>> {
    const links: { case_id: string; task_id: string }[] = [];

    for (const part of chunks(cases.map((c) => c.id))) {
      links.push(
        ...(await this.allPages<{ case_id: string; task_id: string }>(
          'load requirement links',
          (from, to) =>
            this.client
              .from('test_ticket_links')
              .select('case_id, task_id')
              .eq('link_type', 'requirement')
              .eq('space_id', spaceId)
              .eq('organization_id', user.organizationId)
              .in('case_id', part)
              .order('id', { ascending: true })
              .range(from, to)
              .returns<{ case_id: string; task_id: string }[]>(),
        )),
      );
    }

    const byCase = new Map<string, ExportRequirement[]>();

    if (links.length === 0) return byCase;

    const visible = await this.visibility.visibleTasks(
      user,
      links.map((l) => l.task_id),
    );

    for (const link of links) {
      const task = visible.get(link.task_id);
      const list = byCase.get(link.case_id) ?? [];

      if (!task || list.some((r) => r.key === task.key)) continue;

      list.push({ key: task.key, summary: task.summary });
      byCase.set(link.case_id, list);
    }

    for (const list of byCase.values()) {
      list.sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
    }

    return byCase;
  }

  private async spaceKey(
    organizationId: string,
    spaceId: string,
  ): Promise<string> {
    const { data, error } = await this.client
      .from('spaces')
      .select('key')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle<{ key: string }>();

    if (error) throw tmDbError(this.logger, 'load space key', error);
    if (!data) throw notFound();

    return data.key;
  }

  private async allPages<T>(
    action: string,
    page: (from: number, to: number) => Rows<T>,
  ): Promise<T[]> {
    const { rows } = await fetchAllRows<T>(async (from, to) => {
      const result = await page(from, to);

      if (result.error) throw tmDbError(this.logger, action, result.error);

      return result;
    }, Infinity);

    return rows;
  }
}
