import {
  csvCell,
  neutraliseFormula,
} from '../../backup/engine/writers/delimited.writer';
import { escapeHtml } from '../../document-designer/rendering/field-formatter';
import type {
  EffortRow,
  ExecutionProgressRow,
  PlanProgressRow,
  RunHistoryRow,
  TestReportLang,
  TestReportRange,
  TestReportRoute,
  TesterWorkloadRow,
} from '../dto/test-report.dto';

export type ExportCell = string | number | boolean | null;

export interface ExportTable {
  headers: string[];
  rows: ExportCell[][];
}

type Text = Record<TestReportLang, string>;

const LABELS = {
  unassigned: { en: 'Unassigned', de: 'Nicht zugewiesen' },
  noPlan: { en: 'No plan', de: 'Kein Plan' },
  yes: { en: 'Yes', de: 'Ja' },
  no: { en: 'No', de: 'Nein' },
  noData: { en: 'No data', de: 'Keine Daten' },
  plan: { en: 'Test plan', de: 'Testplan' },
} satisfies Record<string, Text>;

export const REPORT_TITLES: Record<TestReportRoute, Text> = {
  'execution-progress': {
    en: 'Execution progress',
    de: 'Ausführungsfortschritt',
  },
  'plan-progress': { en: 'Plan progress', de: 'Planfortschritt' },
  'tester-workload': { en: 'Tester workload', de: 'Auslastung der Tester' },
  'run-history': { en: 'Run history', de: 'Ergebnisverlauf' },
  effort: { en: 'Effort', de: 'Aufwand' },
};

interface Column<Row> {
  header: Text;
  value: (row: Row, lang: TestReportLang) => ExportCell;
}

const STATUS_COLUMNS = <Row extends Record<string, unknown>>(): Column<Row>[] =>
  (
    [
      ['total', { en: 'Total', de: 'Gesamt' }],
      ['todo', { en: 'To do', de: 'Offen' }],
      ['executing', { en: 'Executing', de: 'In Ausführung' }],
      ['pass', { en: 'Passed', de: 'Bestanden' }],
      ['fail', { en: 'Failed', de: 'Fehlgeschlagen' }],
      ['blocked', { en: 'Blocked', de: 'Blockiert' }],
      ['aborted', { en: 'Aborted', de: 'Abgebrochen' }],
      ['not_applicable', { en: 'Not applicable', de: 'Nicht anwendbar' }],
    ] as const
  ).map(([field, header]) => ({
    header,
    value: (row: Row) => row[field] as ExportCell,
  }));

const COLUMNS: {
  'execution-progress': Column<ExecutionProgressRow>[];
  'plan-progress': Column<PlanProgressRow>[];
  'tester-workload': Column<TesterWorkloadRow>[];
  'run-history': Column<RunHistoryRow>[];
  effort: Column<EffortRow>[];
} = {
  'execution-progress': [
    {
      header: { en: 'Execution', de: 'Ausführung' },
      value: (r) => r.execution_key,
    },
    { header: { en: 'Name', de: 'Name' }, value: (r) => r.execution_name },
    {
      header: { en: 'Environment', de: 'Umgebung' },
      value: (r) => r.environment,
    },
    { header: { en: 'Created', de: 'Erstellt' }, value: (r) => r.created_at },
    ...STATUS_COLUMNS<ExecutionProgressRow & Record<string, unknown>>(),
    {
      header: { en: 'Finished (share)', de: 'Abgeschlossen (Anteil)' },
      value: (r) => r.final_ratio,
    },
    {
      header: { en: 'Success rate', de: 'Erfolgsquote' },
      value: (r) => r.success_rate,
    },
  ],
  'plan-progress': [
    { header: { en: 'Plan', de: 'Plan' }, value: (r) => r.plan_key },
    { header: { en: 'Name', de: 'Name' }, value: (r) => r.plan_name },
    { header: { en: 'Start', de: 'Beginn' }, value: (r) => r.start_date },
    { header: { en: 'End', de: 'Ende' }, value: (r) => r.end_date },
    {
      header: { en: 'Tests (all in plan)', de: 'Tests (alle im Plan)' },
      value: (r) => r.tests,
    },
    { header: { en: 'Passed', de: 'Bestanden' }, value: (r) => r.pass },
    { header: { en: 'Failed', de: 'Fehlgeschlagen' }, value: (r) => r.fail },
    { header: { en: 'Blocked', de: 'Blockiert' }, value: (r) => r.blocked },
    {
      header: { en: 'Not run', de: 'Nicht ausgeführt' },
      value: (r) => r.not_run,
    },
    {
      header: { en: 'Not applicable', de: 'Nicht anwendbar' },
      value: (r) => r.not_applicable,
    },
    {
      header: { en: 'Success rate', de: 'Erfolgsquote' },
      value: (r) => r.success_rate,
    },
  ],
  'tester-workload': [
    {
      header: { en: 'Tester', de: 'Tester' },
      value: (r, l) => r.name ?? LABELS.unassigned[l],
    },
    ...STATUS_COLUMNS<TesterWorkloadRow & Record<string, unknown>>(),
  ],
  'run-history': [
    { header: { en: 'Day', de: 'Tag' }, value: (r) => r.day },
    { header: { en: 'Results', de: 'Ergebnisse' }, value: (r) => r.total },
    { header: { en: 'Passed', de: 'Bestanden' }, value: (r) => r.pass },
    { header: { en: 'Failed', de: 'Fehlgeschlagen' }, value: (r) => r.fail },
    { header: { en: 'Blocked', de: 'Blockiert' }, value: (r) => r.blocked },
    { header: { en: 'Aborted', de: 'Abgebrochen' }, value: (r) => r.aborted },
    {
      header: { en: 'Not applicable', de: 'Nicht anwendbar' },
      value: (r) => r.not_applicable,
    },
  ],
  effort: [
    {
      header: { en: 'Grouped by', de: 'Gruppiert nach' },
      value: (r, l) =>
        r.dimension === 'execution'
          ? { en: 'Execution', de: 'Ausführung' }[l]
          : r.dimension === 'plan'
            ? LABELS.plan[l]
            : { en: 'Tester', de: 'Tester' }[l],
    },
    {
      header: { en: 'Name', de: 'Name' },
      value: (r, l) =>
        r.dimension === 'tester'
          ? (r.name ?? LABELS.unassigned[l])
          : r.dimension === 'plan' && r.dimension_id === null
            ? LABELS.noPlan[l]
            : r.dimension_key,
    },
    { header: { en: 'Runs', de: 'Läufe' }, value: (r) => r.runs },
    {
      header: { en: 'Estimate (min)', de: 'Schätzung (Min.)' },
      value: (r) => r.estimate_minutes,
    },
    {
      header: { en: 'Entered time (min)', de: 'Erfasste Zeit (Min.)' },
      value: (r) => r.actual_minutes,
    },
    {
      header: { en: 'Variance (min)', de: 'Abweichung (Min.)' },
      value: (r) => r.variance,
    },
    {
      header: { en: 'Runs without estimate', de: 'Läufe ohne Schätzung' },
      value: (r) => r.no_estimate_runs,
    },
    {
      header: {
        en: 'Entered time without estimate (min)',
        de: 'Erfasste Zeit ohne Schätzung (Min.)',
      },
      value: (r) => r.no_estimate_actual_minutes,
    },
  ],
};

function build<Row>(
  columns: Column<Row>[],
  rows: Row[],
  lang: TestReportLang,
): ExportTable {
  return {
    headers: columns.map((c) => c.header[lang]),
    rows: rows.map((row) => columns.map((c) => c.value(row, lang))),
  };
}

export type ExportRows =
  | { route: 'execution-progress'; rows: ExecutionProgressRow[] }
  | { route: 'plan-progress'; rows: PlanProgressRow[] }
  | { route: 'tester-workload'; rows: TesterWorkloadRow[] }
  | { route: 'run-history'; rows: RunHistoryRow[] }
  | { route: 'effort'; rows: EffortRow[] };

export function exportTable(
  input: ExportRows,
  lang: TestReportLang,
): ExportTable {
  switch (input.route) {
    case 'execution-progress':
      return build(COLUMNS[input.route], input.rows, lang);
    case 'plan-progress':
      return build(COLUMNS[input.route], input.rows, lang);
    case 'tester-workload':
      return build(COLUMNS[input.route], input.rows, lang);
    case 'run-history':
      return build(COLUMNS[input.route], input.rows, lang);
    case 'effort':
      return build(COLUMNS[input.route], input.rows, lang);
  }
}

function csvValue(value: ExportCell, lang: TestReportLang): string {
  if (value === null) return '';
  if (typeof value === 'boolean')
    return value ? LABELS.yes[lang] : LABELS.no[lang];

  // Numbers stay as they are; only text can carry a formula prefix.
  if (typeof value === 'number') return String(value);

  return csvCell(neutraliseFormula(value), ',');
}

/** UTF-8 with BOM and CRLF, so spreadsheets open umlauts and line ends correctly; zero rows give the header only. */
export function toCsv(table: ExportTable, lang: TestReportLang): Buffer {
  const lines = [table.headers, ...table.rows].map((cells) =>
    cells.map((cell) => csvValue(cell, lang)).join(','),
  );

  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

export const PDF_PAGE = { widthPx: 1123, heightPx: 794 } as const;

/** Every value is escaped; the page carries its own print size like the resource planning export. */
export function toPdfHtml(
  table: ExportTable,
  meta: { title: string; spaceKey: string; range: TestReportRange },
  lang: TestReportLang,
): string {
  const cell = (value: ExportCell) =>
    escapeHtml(
      typeof value === 'boolean'
        ? value
          ? LABELS.yes[lang]
          : LABELS.no[lang]
        : value,
    );
  const body =
    table.rows.length === 0
      ? `<tr><td colspan="${table.headers.length}">${escapeHtml(LABELS.noData[lang])}</td></tr>`
      : table.rows
          .map(
            (row) =>
              `<tr>${row.map((v) => `<td>${cell(v)}</td>`).join('')}</tr>`,
          )
          .join('');

  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${escapeHtml(meta.title)}</title><style>
@page { size: ${PDF_PAGE.widthPx}px ${PDF_PAGE.heightPx}px; margin: 28px; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #1f2937; }
h1 { font-size: 16px; margin: 0 0 4px; }
p { margin: 0 0 12px; color: #4b5563; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
th, td { border: 1px solid #d1d5db; padding: 4px 6px; text-align: left; vertical-align: top; word-break: break-word; }
th { background: #f3f4f6; }
tr { page-break-inside: avoid; }
</style></head><body><h1>${escapeHtml(meta.title)}</h1><p>${escapeHtml(
    `${meta.spaceKey} · ${meta.range.from} – ${meta.range.to} · ${meta.range.tz}`,
  )}</p><table><thead><tr>${table.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></body></html>`;
}
