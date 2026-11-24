/** Pure CSV/HTML rendering for the already-sanitized migration report model. */

import type { MigrationReportExport } from './migration-report.service';

export function renderMigrationReportCsv(
  bundle: MigrationReportExport,
): string {
  const { report } = bundle;
  const lines = [
    `# Migration run ${report.runId} (${report.mode}) — ${report.status}`,
  ];

  if (report.unimplementedStages.length > 0) {
    lines.push(
      `# NOT ATTEMPTED — no handler in this build: ${report.unimplementedStages.join(' ')}`,
    );
  }

  lines.push('', 'entity_type,created,skipped,failed,blocked,mapped_in_target');
  for (const row of report.entities) {
    lines.push(
      [
        row.entityType,
        row.created,
        row.skipped,
        row.failed,
        row.blocked,
        row.mapped,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  if (report.reconciliation.length > 0) {
    lines.push(
      '',
      '# Source vs target reconciliation',
      'entity_type,source_count,target_count,shortfall',
    );
    for (const row of report.reconciliation) {
      lines.push(
        [
          row.entityType,
          row.sourceCount ?? 'INCONCLUSIVE',
          row.targetCount,
          row.shortfall ?? 'INCONCLUSIVE',
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }

  if (report.failures.length > 0) {
    lines.push(
      '',
      `# Why items failed (${report.failures.length} distinct cause(s))`,
      'entity_type,error_class,count,cause,affected_source_refs',
    );
    for (const row of report.failures) {
      const samples =
        row.samples.map((sample) => sample.sourceRef ?? '').join(' ') +
        (row.count > row.samples.length
          ? ` (+${row.count - row.samples.length} more)`
          : '');
      lines.push(
        [
          row.entityType,
          row.errorClass,
          row.count,
          sanitizeAuditText(row.cause),
          sanitizeAuditText(samples),
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }

  lines.push(
    '',
    `# Fidelity losses (${report.lossy.length})`,
    'stage,at,message,sourceRef,macroName,reason',
  );
  for (const row of report.lossy) {
    lines.push(
      [
        row.stage,
        row.at,
        sanitizeAuditText(row.message),
        row.sourceRef ?? null,
        row.macroName ?? null,
        row.reason ?? null,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  lines.push(
    '',
    `# Audit items (${bundle.items.length})`,
    [
      'stage',
      'entity_type',
      'item_kind',
      'source_ref',
      'title_or_filename',
      'parent_source_ref',
      'outcome',
      'match_method',
      'target_table',
      'target_id_or_key',
      'attempts',
      'started_at',
      'finished_at',
      'duration_ms',
      'error_class',
      'error_message',
      'skip_reason',
    ].join(','),
  );
  for (const row of bundle.items) {
    lines.push(
      [
        row.stage,
        row.entityType,
        row.itemKind,
        row.sourceRef,
        row.titleOrFilename,
        row.parentSourceRef,
        row.outcome,
        row.matchMethod,
        row.targetTable,
        row.targetIdOrKey,
        row.attempts,
        row.startedAt,
        row.finishedAt,
        row.durationMs,
        row.errorClass,
        row.errorMessage,
        row.skipReason ?? null,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  return `\uFEFF${lines.join('\r\n')}`;
}

export function renderMigrationReportHtml(
  bundle: MigrationReportExport,
): string {
  const { report } = bundle;
  const entityRows = report.entities
    .map(
      (row) =>
        `<tr><td>${html(row.entityType)}</td><td>${row.created}</td><td>${row.skipped}</td><td>${row.failed}</td><td>${row.blocked}</td><td>${row.mapped}</td></tr>`,
    )
    .join('');
  const auditRows = bundle.items
    .map(
      (row) => `<tr${outcomeClass(row.outcome)}>
<td>${html(row.stage)}<small>${html(row.entityType)} · ${html(row.itemKind)}</small></td>
<td>${htmlNullable(row.sourceRef)}<small>${htmlNullable(row.titleOrFilename)}</small></td>
<td>${htmlNullable(row.parentSourceRef)}</td>
<td>${html(row.outcome)}<small>${htmlNullable(row.matchMethod)}</small></td>
<td>${htmlNullable(row.targetTable)}<small>${htmlNullable(row.targetIdOrKey)}</small></td>
<td>${row.attempts}<small>${htmlNullable(row.startedAt)} → ${htmlNullable(row.finishedAt)} · ${row.durationMs ?? '—'} ms</small></td>
<td>${htmlNullable(row.errorClass)}<small>${htmlNullable(row.errorMessage)}</small><small>${htmlNullable(row.skipReason ?? null)}</small></td>
</tr>`,
    )
    .join('');
  const reconciliationRows = report.reconciliation
    .map(
      (row) =>
        `<tr><td>${html(row.entityType)}</td><td>${row.sourceCount ?? 'Inconclusive'}</td><td>${row.targetCount}</td><td>${row.shortfall ?? 'Inconclusive'}</td></tr>`,
    )
    .join('');
  const lossRows = report.lossy
    .map(
      (row) =>
        `<tr><td>${htmlNullable(row.stage)}</td><td>${html(row.at)}</td><td>${html(sanitizeAuditText(row.message))}${[
          row.sourceRef ?? null,
          row.macroName ?? null,
          row.reason ?? null,
        ]
          .filter(Boolean)
          .map((value) => `<br>${html(sanitizeAuditText(value!))}`)
          .join('')}</td></tr>`,
    )
    .join('');
  const failureRows = report.failures
    .map(
      (row) =>
        `<tr><td>${html(row.entityType)}</td><td>${htmlNullable(row.errorClass)}</td><td>${row.count}</td><td>${html(sanitizeAuditText(row.cause))}</td><td>${html(
          sanitizeAuditText(
            row.samples
              .map(
                (sample) =>
                  `${sample.sourceRef ?? '—'}${sample.title ? ` (${sample.title})` : ''}`,
              )
              .join(', '),
          ),
        )}</td></tr>`,
    )
    .join('');
  const unimplemented = report.unimplementedStages
    .map((stage) => `<li>${html(stage)}</li>`)
    .join('');
  const emptyAudit =
    bundle.items.length === 0
      ? '<p class="empty">No audit items were recorded for this run.</p>'
      : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page {
  size: 1123px 794px;
  margin: 34px 28px 42px;
  @bottom-left { content: "Migration audit report"; color: #607086; font: 9px Arial, sans-serif; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); color: #607086; font: 9px Arial, sans-serif; }
}
* { box-sizing: border-box; } body { margin: 0; color: #172033; font: 10px Arial, sans-serif; }
h1 { margin: 0; font-size: 23px; } h2 { margin: 20px 0 7px; font-size: 14px; color: #243b63; }
.meta { color: #607086; margin: 4px 0 14px; } .cards { display: flex; gap: 8px; margin-bottom: 14px; }
.card { flex: 1; border: 1px solid #d8e0eb; border-radius: 5px; padding: 8px; background: #f7f9fc; }
.card strong { display: block; font-size: 17px; } table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead { display: table-header-group; } th { background: #243b63; color: white; text-align: left; }
th, td { border: 1px solid #d8e0eb; padding: 5px; vertical-align: top; overflow-wrap: anywhere; }
tbody tr:nth-child(even) { background: #f7f9fc; } tr { break-inside: avoid; } small { display: block; color: #607086; margin-top: 2px; }
.outcome-failed, .outcome-dead { background: #fff0f0 !important; } .outcome-blocked { background: #fff8e6 !important; }
.empty { padding: 12px; border: 1px dashed #aab6c6; color: #607086; }
</style></head><body>
<h1>Migration Audit Report</h1>
<div class="meta">Run ${html(report.runId)} · ${html(report.mode)} · ${html(report.status)} · ${htmlNullable(report.startedAt)} to ${htmlNullable(report.finishedAt)}</div>
<div class="cards"><div class="card"><strong>${report.totals.created}</strong>Completed</div><div class="card"><strong>${report.totals.skipped}</strong>Skipped</div><div class="card"><strong>${report.totals.failed}</strong>Failed</div><div class="card"><strong>${report.totals.blocked}</strong>Blocked</div><div class="card"><strong>${bundle.items.length}</strong>Audit rows</div></div>
${unimplemented ? `<h2>Not attempted</h2><ul>${unimplemented}</ul>` : ''}
<h2>Business entity totals</h2><table><thead><tr><th>Entity</th><th>Completed</th><th>Skipped</th><th>Failed</th><th>Blocked</th><th>Mapped in target</th></tr></thead><tbody>${entityRows}</tbody></table>
${failureRows ? `<h2>Grouped failure causes</h2><table><thead><tr><th>Entity</th><th>Class</th><th>Count</th><th>Cause</th><th>Samples</th></tr></thead><tbody>${failureRows}</tbody></table>` : ''}
${reconciliationRows ? `<h2>Source reconciliation</h2><table><thead><tr><th>Entity</th><th>Source</th><th>Target</th><th>Shortfall</th></tr></thead><tbody>${reconciliationRows}</tbody></table>` : ''}
${lossRows ? `<h2>Fidelity warnings</h2><table><thead><tr><th>Stage</th><th>At</th><th>Message</th></tr></thead><tbody>${lossRows}</tbody></table>` : ''}
<h2>Complete audit trail</h2>${emptyAudit}<table><thead><tr><th>Stage / entity</th><th>Source / title</th><th>Parent</th><th>Outcome / match</th><th>Target table / id-key</th><th>Attempts / timing</th><th>Error</th></tr></thead><tbody>${auditRows}</tbody></table>
</body></html>`;
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function html(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlNullable(value: string | null): string {
  return value === null || value === '' ? '—' : html(value);
}

function outcomeClass(outcome: string): string {
  return ['failed', 'dead', 'blocked'].includes(outcome)
    ? ` class="outcome-${outcome}"`
    : '';
}

export function sanitizeAuditText(value: string, maxLength = 1000): string {
  return value
    .replace(/\b(?:https?|ftp):\/\/[^\s<>"']+/gi, '[url]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /\b(password|passwd|token|api[_-]?key|secret|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[redacted]',
    )
    .slice(0, maxLength);
}
