// jsdom's ESM dependency chain is not transformable under jest — mock the
// sanitizer with a faithful double (repo precedent: sanitize-rich-text mocks).
jest.mock('./html-sanitizer', () => ({
  sanitizeHtml: (html: string) =>
    html
      .replace(/<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<(script|style|iframe|object|embed|form)\b[^>]*\/?>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ''),
  stripHtmlToText: (html: string) => html.replace(/<[^>]*>/g, '').trim(),
}));

import type { IDocumentDataContext } from './document-data-resolver.service';
import {
  escapeHtml,
  formatFieldValue,
  resolveTokenText,
  type IDocumentMetaContext,
} from './field-formatter';

function buildDataCtx(): IDocumentDataContext {
  return {
    items: [],
    subtasksByItemId: {},
    linkedByItemId: {},
    dynamicQueryByRegionId: {},
    lookups: {
      usersById: {
        'user-1': {
          id: 'user-1',
          first_name: 'Ada',
          last_name: 'Lovelace',
          email: 'ada@example.com',
        },
      },
      statusesById: {
        'status-1': { id: 'status-1', name: 'In Progress' },
      },
      prioritiesById: {
        'prio-1': { id: 'prio-1', name: 'High' },
      },
      spacesById: {
        'space-1': { id: 'space-1', name: 'Security', key: 'SEC' },
      },
      assetsById: {},
      tasksById: {},
      wikiPagesById: {},
      organizationName: 'Acme GmbH',
    },
    fieldDefsBySpace: {},
    orgFieldDefs: {
      severity: {
        field_key: 'severity',
        field_type: 'select',
        name: 'Severity',
        options: [
          { value: 'high', label: 'High severity' },
          { value: 'low', label: 'Low severity' },
        ],
      },
      is_urgent: {
        field_key: 'is_urgent',
        field_type: 'checkbox',
        name: 'Urgent',
        options: [],
      },
      tags: {
        field_key: 'tags',
        field_type: 'multiselect',
        name: 'Tags',
        options: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ],
      },
      notes: {
        field_key: 'notes',
        field_type: 'editor',
        name: 'Notes',
        options: [],
      },
      reviewer: {
        field_key: 'reviewer',
        field_type: 'user_select',
        name: 'Reviewer',
        options: [],
      },
      budget: {
        field_key: 'budget',
        field_type: 'number',
        name: 'Budget',
        options: [],
      },
    },
    warnings: [],
  };
}

const meta: IDocumentMetaContext = {
  exportDate: new Date('2026-07-19T12:00:00Z'),
  exportedByUserId: 'user-1',
  itemIndex: 2,
  itemCount: 5,
  sourceEntity: 'tasks',
};

describe('escapeHtml', () => {
  it('escapes HTML-special characters', () => {
    expect(escapeHtml('<b>"x" & \'y\'</b>')).toBe(
      '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;',
    );
  });

  it('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('formatFieldValue — system fields', () => {
  const dataCtx = buildDataCtx();

  it('formats dates with the default dd.MM.yyyy pattern', () => {
    const warnings: string[] = [];
    const value = formatFieldValue(
      { source: 'system', fieldKey: 'due_date' },
      { due_date: '2026-03-05T12:00:00Z' },
      dataCtx,
      meta,
      warnings,
    );
    expect(value).toBe('05.03.2026');
  });

  it('honors a custom date format', () => {
    const value = formatFieldValue(
      {
        source: 'system',
        fieldKey: 'due_date',
        format: { dateFormat: 'yyyy-MM-dd' },
      },
      { due_date: '2026-03-05T12:00:00Z' },
      dataCtx,
      meta,
      [],
    );
    expect(value).toBe('2026-03-05');
  });

  it('keeps DATE-ONLY values on the stored calendar day in any server timezone', () => {
    // Postgres `date` columns arrive as '2026-07-19'. Parsed as UTC midnight
    // (the old behavior) this renders '18.07.2026' on any server west of UTC;
    // local parsing pins the calendar day regardless of process TZ.
    const value = formatFieldValue(
      { source: 'system', fieldKey: 'due_date' },
      { due_date: '2026-07-19' },
      dataCtx,
      meta,
      [],
    );
    expect(value).toBe('19.07.2026');
  });

  it('formats users as "First Last" by default and email on request', () => {
    const raw = { assigned_to: 'user-1' };
    expect(
      formatFieldValue(
        { source: 'system', fieldKey: 'assigned_to' },
        raw,
        dataCtx,
        meta,
        [],
      ),
    ).toBe('Ada Lovelace');
    expect(
      formatFieldValue(
        {
          source: 'system',
          fieldKey: 'assigned_to',
          format: { userDisplay: 'email' },
        },
        raw,
        dataCtx,
        meta,
        [],
      ),
    ).toBe('ada@example.com');
  });

  it('resolves status via the lookup and falls back to a humanized key', () => {
    expect(
      formatFieldValue(
        { source: 'system', fieldKey: 'status' },
        { status: 'open', status_id: 'status-1' },
        dataCtx,
        meta,
        [],
      ),
    ).toBe('In Progress');
    expect(
      formatFieldValue(
        { source: 'system', fieldKey: 'status' },
        { status: 'in_review', status_id: null },
        dataCtx,
        meta,
        [],
      ),
    ).toBe('In review');
  });

  it('formats numbers in percent and currency modes', () => {
    expect(
      formatFieldValue(
        {
          source: 'system',
          fieldKey: 'progress',
          format: { numberFormat: 'percent' },
        },
        { progress: 42 },
        dataCtx,
        meta,
        [],
      ),
    ).toBe('42%');
    expect(
      formatFieldValue(
        {
          source: 'system',
          fieldKey: 'estimated_cost',
          format: { numberFormat: 'currency', currency: 'EUR' },
        },
        { estimated_cost: 1234.5 },
        dataCtx,
        meta,
        [],
      ),
    ).toContain('1,234.50');
  });

  it('joins label arrays with commas', () => {
    expect(
      formatFieldValue(
        { source: 'system', fieldKey: 'labels' },
        { labels: ['backend', 'urgent'] },
        dataCtx,
        meta,
        [],
      ),
    ).toBe('backend, urgent');
  });

  it('resolves space_name through the spaces lookup', () => {
    expect(
      formatFieldValue(
        { source: 'system', fieldKey: 'space_name' },
        { space_id: 'space-1' },
        dataCtx,
        meta,
        [],
      ),
    ).toBe('Security');
  });

  it('escapes plain string values', () => {
    expect(
      formatFieldValue(
        { source: 'system', fieldKey: 'summary' },
        { summary: '<b>evil</b>' },
        dataCtx,
        meta,
        [],
      ),
    ).toBe('&lt;b&gt;evil&lt;/b&gt;');
  });

  it('returns empty string and warns for an unknown system field', () => {
    const warnings: string[] = [];
    expect(
      formatFieldValue(
        { source: 'system', fieldKey: 'nonsense_column' },
        { summary: 'x' },
        dataCtx,
        meta,
        warnings,
      ),
    ).toBe('');
    expect(warnings.some((w) => w.includes('nonsense_column'))).toBe(true);
  });
});

describe('formatFieldValue — custom fields', () => {
  const dataCtx = buildDataCtx();

  function customValue(key: string, value: unknown) {
    return { space_id: 'space-1', custom_field_values: { [key]: value } };
  }

  it('renders checkbox as Yes/No', () => {
    expect(
      formatFieldValue(
        { source: 'custom_field', fieldKey: 'is_urgent' },
        customValue('is_urgent', true),
        dataCtx,
        meta,
        [],
      ),
    ).toBe('Yes');
    expect(
      formatFieldValue(
        { source: 'custom_field', fieldKey: 'is_urgent' },
        customValue('is_urgent', false),
        dataCtx,
        meta,
        [],
      ),
    ).toBe('No');
  });

  it('maps select values to option labels', () => {
    expect(
      formatFieldValue(
        { source: 'custom_field', fieldKey: 'severity' },
        customValue('severity', 'high'),
        dataCtx,
        meta,
        [],
      ),
    ).toBe('High severity');
  });

  it('maps multiselect arrays to joined option labels', () => {
    expect(
      formatFieldValue(
        { source: 'custom_field', fieldKey: 'tags' },
        customValue('tags', ['a', 'b']),
        dataCtx,
        meta,
        [],
      ),
    ).toBe('Alpha, Beta');
  });

  it('sanitizes editor HTML when renderHtml is set, strips otherwise', () => {
    const html = '<p>hello</p><script>alert(1)</script>';
    const rendered = formatFieldValue(
      {
        source: 'custom_field',
        fieldKey: 'notes',
        format: { renderHtml: true },
      },
      customValue('notes', html),
      dataCtx,
      meta,
      [],
    );
    expect(rendered).toContain('<p>hello</p>');
    expect(rendered).not.toContain('<script>');

    const stripped = formatFieldValue(
      { source: 'custom_field', fieldKey: 'notes' },
      customValue('notes', html),
      dataCtx,
      meta,
      [],
    );
    expect(stripped).not.toContain('<p>');
    expect(stripped).toContain('hello');
  });

  it('resolves user_select through the user lookup', () => {
    expect(
      formatFieldValue(
        { source: 'custom_field', fieldKey: 'reviewer' },
        customValue('reviewer', 'user-1'),
        dataCtx,
        meta,
        [],
      ),
    ).toBe('Ada Lovelace');
  });

  it('formats number custom fields', () => {
    expect(
      formatFieldValue(
        { source: 'custom_field', fieldKey: 'budget' },
        customValue('budget', 1500),
        dataCtx,
        meta,
        [],
      ),
    ).toBe('1,500');
  });

  it('returns a dash for a missing value without warning', () => {
    const warnings: string[] = [];
    expect(
      formatFieldValue(
        { source: 'custom_field', fieldKey: 'severity' },
        { space_id: 'space-1', custom_field_values: {} },
        dataCtx,
        meta,
        warnings,
      ),
    ).toBe('-');
    expect(warnings).toHaveLength(0);
  });

  it('returns empty string and warns for an unknown custom field', () => {
    const warnings: string[] = [];
    expect(
      formatFieldValue(
        { source: 'custom_field', fieldKey: 'ghost_field' },
        customValue('ghost_field', 'x'),
        dataCtx,
        meta,
        warnings,
      ),
    ).toBe('');
    expect(warnings.some((w) => w.includes('ghost_field'))).toBe(true);
  });
});

describe('formatFieldValue — meta fields', () => {
  const dataCtx = buildDataCtx();

  it('formats exportDate with the date format', () => {
    expect(
      formatFieldValue(
        { source: 'meta', fieldKey: 'exportDate' },
        null,
        dataCtx,
        meta,
        [],
      ),
    ).toBe('19.07.2026');
  });

  it('resolves exportedBy through the user lookup', () => {
    expect(
      formatFieldValue(
        { source: 'meta', fieldKey: 'exportedBy' },
        null,
        dataCtx,
        meta,
        [],
      ),
    ).toBe('Ada Lovelace');
  });

  it('renders organizationName and item counters', () => {
    expect(
      formatFieldValue(
        { source: 'meta', fieldKey: 'organizationName' },
        null,
        dataCtx,
        meta,
        [],
      ),
    ).toBe('Acme GmbH');
    expect(
      formatFieldValue(
        { source: 'meta', fieldKey: 'itemIndex' },
        null,
        dataCtx,
        meta,
        [],
      ),
    ).toBe('2');
    expect(
      formatFieldValue(
        { source: 'meta', fieldKey: 'itemCount' },
        null,
        dataCtx,
        meta,
        [],
      ),
    ).toBe('5');
  });
});

describe('resolveTokenText', () => {
  const dataCtx = buildDataCtx();

  it('returns raw (unescaped) text for system fields', () => {
    expect(
      resolveTokenText(
        'summary',
        { summary: '<b>evil</b>' },
        dataCtx,
        meta,
        [],
      ),
    ).toBe('<b>evil</b>');
  });

  it('resolves meta keys', () => {
    expect(resolveTokenText('organizationName', null, dataCtx, meta, [])).toBe(
      'Acme GmbH',
    );
  });

  it('falls back to custom fields for unknown keys', () => {
    expect(
      resolveTokenText(
        'severity',
        { space_id: 'space-1', custom_field_values: { severity: 'high' } },
        dataCtx,
        meta,
        [],
      ),
    ).toBe('High severity');
  });
});
