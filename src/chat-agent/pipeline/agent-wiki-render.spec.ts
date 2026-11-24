import { validateTipTapDoc } from '../../common/utils/tiptap-sanitizer';
import {
  fillItemCards,
  numberCandidates,
  numbersIn,
  plainText,
  renderWikiDoc,
  type WikiBlock,
  type WikiRenderRefs,
  type TipTapNode,
} from './agent-wiki-render';

const PAGE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const INCLUDED = '33333333-3333-4333-8333-333333333333';

const block = (b: Partial<WikiBlock> & Pick<WikiBlock, 'type'>): WikiBlock => ({
  level: null,
  text: null,
  title: null,
  items: [],
  rows: [],
  variant: null,
  language: null,
  refs: [],
  labels: [],
  ...b,
});

const refs = (over: Partial<WikiRenderRefs> = {}): WikiRenderRefs => ({
  language: 'en',
  pageId: PAGE,
  spaceKey: 'AMBER',
  person: (h) => (h === 'P2' ? { userId: USER, name: 'Rajbha Manek' } : null),
  message: (h) => (h === 'm3' ? '/chat/c1?m=msg-3' : null),
  task: (r) =>
    r === 'T1' || r === 'AMBER-T25'
      ? { key: 'AMBER-T25', spaceId: 'space-1' }
      : r === 'i1'
        ? { item: 1 }
        : null,
  page: (r) => (r === 'W1' ? { id: INCLUDED } : null),
  labelled: () => [{ key: 'AMBER-T30', spaceId: 'space-1' }],
  ...over,
});

const types = (nodes: TipTapNode[]): string[] =>
  nodes.flatMap((n) => [n.type, ...types(n.content ?? [])]);

const ALL_BLOCKS: WikiBlock[] = [
  block({ type: 'properties', rows: [['Owner', 'Rajbha'], ['Status', 'Draft']] }),
  block({ type: 'toc' }),
  block({ type: 'excerpt', text: 'Android release plan for 2.4.' }),
  block({ type: 'heading', level: 2, text: 'Overview' }),
  block({ type: 'paragraph', text: 'We ship **2.4** on _Friday_ with `build 812` [m3], owner @P2.' }),
  block({ type: 'bullets', items: ['Fix push crash', 'Update store listing'] }),
  block({ type: 'numbered', items: ['Freeze', 'QA', 'Release'] }),
  block({ type: 'checklist', items: ['[x] Signing keys', '[ ] Release notes'] }),
  block({ type: 'quote', text: 'No release without QA sign-off.' }),
  block({ type: 'code', text: './gradlew bundleRelease', language: 'bash' }),
  block({ type: 'divider' }),
  block({ type: 'table', rows: [['Task', 'Owner'], ['Push crash', 'Rajbha']] }),
  block({ type: 'callout', variant: 'warning', title: 'Open questions', items: ['Who signs the build?'] }),
  block({ type: 'toggle', title: 'Details', text: 'Background', items: ['One', 'Two'] }),
  block({ type: 'columns', items: ['Left', 'Right'] }),
  block({ type: 'status', text: 'State:', items: ['In progress'], variant: 'blue' }),
  block({ type: 'decisions', items: ['Ship on Friday'] }),
  block({ type: 'task_cards', refs: ['T1', 'i1'], labels: ['android'] }),
  block({ type: 'child_pages' }),
  block({ type: 'include_page', refs: ['W1'] }),
  block({ type: 'pages_by_label', labels: ['release'] }),
];

describe('renderWikiDoc', () => {
  it('turns every block into a document the wiki server accepts unchanged', () => {
    const { doc, unknown, empty, items } = renderWikiDoc(ALL_BLOCKS, refs());
    const validated = validateTipTapDoc(JSON.stringify(doc));

    expect(validated.doc).toEqual(doc);
    expect(unknown).toEqual([]);
    expect(empty).toBe(false);
    expect(items).toEqual([1]);
    expect(new Set(types(doc.content))).toEqual(
      new Set([
        'contentProperties', 'confluenceToc', 'excerpt', 'paragraph', 'heading', 'text',
        'userMention', 'bulletList', 'listItem', 'orderedList', 'taskList', 'taskItem',
        'blockquote', 'codeBlock', 'horizontalRule', 'table', 'tableRow', 'tableHeader',
        'tableCell', 'callout', 'details', 'detailsSummary', 'detailsContent', 'columnList',
        'column', 'status', 'decisionList', 'decisionItem', 'taskCard', 'pageTree', 'includePage',
        'contentByLabel',
      ]),
    );
  });

  it('cites sources as in-app links and ends with a Sources list', () => {
    const { doc } = renderWikiDoc(
      [block({ type: 'paragraph', text: 'Agreed [m3] and again [m3].' })],
      refs({ language: 'de' }),
    );
    const json = JSON.stringify(doc);
    expect(json).toContain('"href":"/chat/c1?m=msg-3"');
    expect(json).toContain('Quellen');
    expect(json.match(/\[1\]/g)).toHaveLength(2);
  });

  it('never turns model text into markup, links or other nodes', () => {
    const { doc } = renderWikiDoc(
      [
        block({
          type: 'paragraph',
          text: '<script>alert(1)</script><iframe src="x"></iframe> [click](javascript:alert(1)) https://evil.example [m99] @P9',
        }),
        block({ type: 'code', text: '<img src=x onerror=alert(1)>', language: 'html"><script>' }),
      ],
      refs(),
    );
    const json = JSON.stringify(doc);
    expect(types(doc.content)).not.toEqual(expect.arrayContaining(['link', 'rawHtml', 'embed']));
    expect(json).not.toContain('<script>');
    expect(json).not.toContain('"href":"javascript');
    expect(json).not.toContain('evil.example"');
    expect(json).toContain('"language":"plaintext"');
    expect(() => validateTipTapDoc(JSON.stringify(doc))).not.toThrow();
  });

  it('drops refs that did not resolve and names them', () => {
    const { doc, unknown } = renderWikiDoc(
      [
        block({ type: 'task_cards', refs: ['AMBER-T999', 'T1'] }),
        block({ type: 'include_page', refs: ['W7'] }),
      ],
      refs({ labelled: () => null }),
    );
    expect(unknown).toEqual(['AMBER-T999', 'W7']);
    expect(types(doc.content).filter((t) => t === 'taskCard')).toHaveLength(1);
  });

  it('caps task cards at 20 with an "and N more" line', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ key: `AMBER-T${i}`, spaceId: 's' }));
    const { doc } = renderWikiDoc(
      [block({ type: 'task_cards', labels: ['android'] })],
      refs({ labelled: () => many }),
    );
    expect(types(doc.content).filter((t) => t === 'taskCard')).toHaveLength(20);
    expect(JSON.stringify(doc)).toContain('and 5 more');
  });

  it('trims long pages and flags them, and reports an empty body', () => {
    const long = Array.from({ length: 200 }, () =>
      block({ type: 'paragraph', text: 'x'.repeat(4_000) }),
    );
    const big = renderWikiDoc(long, refs());
    expect(big.trimmed).toBe(true);
    expect(() => validateTipTapDoc(JSON.stringify(big.doc))).not.toThrow();

    const nothing = renderWikiDoc([block({ type: 'heading', text: 'Notes' }), block({ type: 'toc' })], refs());
    expect(nothing.empty).toBe(true);
  });

  it('fills the cards of tasks created in the same request', () => {
    const { doc } = renderWikiDoc([block({ type: 'task_cards', refs: ['i1', 'i2'] })], refs({
      task: (r) => (r === 'i1' ? { item: 1 } : r === 'i2' ? { item: 2 } : null),
    }));
    const filled = fillItemCards(
      doc,
      (item) => (item === 1 ? { key: 'AMBER-T40', spaceId: 'space-1' } : null),
      '(not created)',
    );
    const json = JSON.stringify(filled);
    expect(json).toContain('"taskKey":"AMBER-T40"');
    expect(json).toContain('(not created)');
    expect(json).not.toContain('robertItem');
    expect(() => validateTipTapDoc(json)).not.toThrow();
  });

  it('turns bullets under a decisions or action items heading into the fitting macro', () => {
    const { doc } = renderWikiDoc(
      [
        block({ type: 'heading', text: 'Entscheidungen' }),
        block({ type: 'bullets', items: ['Release am Freitag'] }),
        block({ type: 'heading', text: 'Action items' }),
        block({ type: 'bullets', items: ['@P2 fixes the crash'] }),
        block({ type: 'heading', text: 'Notes' }),
        block({ type: 'bullets', items: ['plain'] }),
        block({ type: 'properties', items: ['Owner: Rajbha', 'Date: 28 Oct'] }),
      ],
      refs(),
    );
    const t = types(doc.content);
    expect(t).toContain('decisionList');
    expect(t).toContain('taskList');
    expect(t).toContain('bulletList');
    expect(JSON.stringify(doc)).toContain('"rows":[{"key":"Owner","value":"Rajbha"},{"key":"Date","value":"28 Oct"}]');
    expect(() => validateTipTapDoc(JSON.stringify(doc))).not.toThrow();
  });

  it('keeps entries the model put on a heading, as the list its section calls for', () => {
    const { doc } = renderWikiDoc(
      [
        block({ type: 'heading', text: 'Decisions', items: ['Ship Friday'] }),
        block({ type: 'heading', text: 'Open questions', items: ['Who signs?'] }),
        block({ type: 'heading', text: 'Risks', items: ['Certificate expiry'] }),
      ],
      refs(),
    );
    const t = types(doc.content);
    expect(t.filter((x) => x === 'heading')).toHaveLength(3);
    expect(t).toEqual(expect.arrayContaining(['decisionList', 'callout', 'bulletList']));
    expect(JSON.stringify(doc)).toContain('Who signs?');
    expect(() => validateTipTapDoc(JSON.stringify(doc))).not.toThrow();
  });

  it('reads refs on a heading as its task cards and "- " lines as a list', () => {
    const { doc } = renderWikiDoc(
      [
        block({ type: 'heading', text: 'Tasks', refs: ['T1'] }),
        block({ type: 'heading', text: 'Known issues' }),
        block({ type: 'paragraph', text: '- Crash on Android 12\n- Push missing on Samsung' }),
      ],
      refs(),
    );
    const t = types(doc.content);
    expect(t).toContain('taskCard');
    expect(t).toContain('bulletList');
    expect(() => validateTipTapDoc(JSON.stringify(doc))).not.toThrow();
  });

  it('turns message handles put in refs into citations', () => {
    const { doc } = renderWikiDoc(
      [block({ type: 'paragraph', text: 'We agreed on Friday.', refs: ['m3'] }), block({ type: 'bullets', items: ['One', 'Two'], refs: ['m3'] })],
      refs(),
    );
    const json = JSON.stringify(doc);
    expect(json.match(/"href":"\/chat\/c1\?m=msg-3"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(json).toContain('Sources');
  });
});


describe('renderWikiDoc fixes from the evaluation (1.15.1)', () => {
  const t = (doc: { content: TipTapNode[] }) => types(doc.content);

  it('moves commands out of steps into code blocks', () => {
    const { doc } = renderWikiDoc(
      [
        block({ type: 'heading', text: 'Steps' }),
        block({
          type: 'numbered',
          items: [
            'Update the secret in Vault: vault kv put secret/payments stripe_webhook_secret=NEW_VALUE',
            'Roll back: kubectl rollout undo deployment/payment-service -n prod, then check the logs with kubectl logs -l app=payment-service -n prod --since=10m',
          ],
        }),
      ],
      refs(),
    );
    const json = JSON.stringify(doc);
    expect(t(doc).filter((x) => x === 'codeBlock')).toHaveLength(2);
    expect(json).toContain('"text":"Update the secret in Vault"');
    expect(json).toContain('kubectl rollout undo deployment/payment-service -n prod\\nkubectl logs -l app=payment-service -n prod --since=10m');
    expect(() => validateTipTapDoc(json)).not.toThrow();
  });

  it('cleans the properties: swapped, empty, Robert and the page state go', () => {
    const { doc } = renderWikiDoc(
      [
        block({ type: 'paragraph', text: 'x' }),
        block({
          type: 'properties',
          rows: [['2026-10-29', 'Decision date'], ['owner', 'Robert'], ['status', 'draft'], ['space', 'AMBER'], [':[', ']'], ['Auditor', 'Markus Feld']],
        }),
      ],
      refs(),
    );
    expect(JSON.stringify(doc)).toContain('"rows":[{"key":"Decision date","value":"29 Oct 2026"},{"key":"Auditor","value":"Markus Feld"}]');
  });

  it('drops empty sections and filler, and reads a decision or open question paragraph as such', () => {
    const { doc } = renderWikiDoc(
      [
        block({ type: 'heading', text: 'Responsibilities' }),
        block({ type: 'heading', text: 'Decision' }),
        block({ type: 'paragraph', text: 'Access reviews are quarterly from now on.' }),
        block({ type: 'heading', text: 'Open questions' }),
        block({ type: 'paragraph', text: 'Do we need a separate AI risk assessment?' }),
        block({ type: 'heading', text: 'Notes' }),
        block({ type: 'paragraph', text: 'No additional notes are available at this time.' }),
      ],
      refs(),
    );
    const json = JSON.stringify(doc);
    expect(json).not.toContain('Responsibilities');
    expect(json).not.toContain('"Notes"');
    expect(json).not.toContain('No additional notes');
    expect(t(doc)).toEqual(expect.arrayContaining(['decisionList', 'callout']));
  });

  it('lists the sources the model named, shows the tasks of the same request, and needs no general-knowledge note then', () => {
    const { doc, items } = renderWikiDoc([block({ type: 'paragraph', text: 'About the renewal.' })], refs({ sources: ['m3', 'm99'], runItems: [1] }));
    const json = JSON.stringify(doc);
    expect(json).toContain('"href":"/chat/c1?m=msg-3"');
    expect(json).toContain('"robertItem":1');
    expect(items).toEqual([1]);
    expect(json).not.toContain('general knowledge');
  });

  it('says so on a page written from general knowledge', () => {
    const { doc } = renderWikiDoc([block({ type: 'heading', text: 'What are passkeys?' }), block({ type: 'paragraph', text: 'A passkey replaces a password.' })], refs());
    expect(doc.content[0]).toMatchObject({ type: 'callout', attrs: { variant: 'info' } });
    expect(JSON.stringify(doc.content[0])).toContain('general knowledge');
  });
});

describe('renderWikiDoc sources and duplicates (1.15.2)', () => {
  it('names who wrote each source and when, lists at most 10, and shows a task once', () => {
    const many = Array.from({ length: 14 }, (_, i) => `m${i + 1}`);
    const { doc } = renderWikiDoc(
      [block({ type: 'heading', text: 'Tasks', refs: ['T1'] }), block({ type: 'task_cards', refs: ['T1', 'AMBER-T25'] })],
      refs({ sources: many, message: (h) => `/chat/c1?m=${h}`, messageLabel: (h) => `Ala Bera, ${h}` }),
    );
    const json = JSON.stringify(doc);
    expect(json.match(/"taskCard"/g)).toHaveLength(1);
    expect(json).toContain('"text":"Ala Bera, m1"');
    expect(json.match(/"href":"\/chat\/c1\?m=m\d+"/g)).toHaveLength(10);
    expect(json).toContain('and 4 more');
  });

  it('shows the general-knowledge note when the model says so, even with sources', () => {
    const { doc } = renderWikiDoc([block({ type: 'paragraph', text: 'Passkeys replace passwords.' })], refs({ sources: ['m3'], generalKnowledge: true }));
    expect(JSON.stringify(doc.content[0])).toContain('general knowledge');
  });
});

describe('renderWikiDoc advanced macros (1.16)', () => {
  const SPACE = '44444444-4444-4444-8444-444444444444';
  const STATUS = '55555555-5555-4555-8555-555555555555';
  const macroRefs = (over: Partial<WikiRenderRefs> = {}) =>
    refs({
      spaceId: SPACE,
      status: (n) => (/^(open|offen)$/i.test(n) ? STATUS : null),
      label: (l) => ['decision', 'project'].includes(l.toLowerCase()),
      numbers: new Set(numbersIn('Budget: design 12.500 EUR, dev 30k, hosting 4,200 and 15%')),
      ...over,
    });
  const valid = (doc: { type: 'doc'; content: TipTapNode[] }) =>
    expect(() => validateTipTapDoc(JSON.stringify(doc))).not.toThrow();
  const budget = block({
    type: 'chart',
    variant: 'pie',
    title: 'Budget',
    rows: [['Item', 'EUR'], ['Design', '12,500'], ['Dev', '30k'], ['Hosting', '4,200 €']],
  });

  it('builds every new macro as a node the wiki accepts', () => {
    const r = renderWikiDoc(
      [
        block({ type: 'paragraph', text: 'Go-live on [d:2026-11-28], not [d:2026-02-30].' }),
        budget,
        block({ type: 'task_table', items: ['open'], refs: ['P2'], text: 'android' }),
        block({ type: 'decision_report', labels: ['Decision'] }),
        block({ type: 'properties_report', labels: ['project'] }),
        block({ type: 'recent_updates' }),
        block({ type: 'contributors' }),
        block({ type: 'labels_list' }),
        block({ type: 'space_attachments' }),
      ],
      macroRefs(),
    );
    valid(r.doc);
    expect(r.notes).toEqual([]);
    const t = types(r.doc.content);
    for (const n of ['date', 'chart', 'ticketTable', 'decisionReport', 'contentPropertiesReport', 'recentlyUpdated', 'contributors', 'labelsList', 'spaceAttachments'])
      expect(t).toContain(n);
    const json = JSON.stringify(r.doc);
    // 28 Nov 2026, 12:00 UTC; the impossible day stays text.
    expect(json).toContain(`"timestamp":"${Date.UTC(2026, 10, 28, 12)}"`);
    expect(json).toContain('2026-02-30');
    // Numbers as the editor's chart parser reads them, never "12,500" as 12.5.
    expect(json).toContain('"text":"12500"');
    expect(json).toContain('"text":"30000"');
    expect(json).toContain('"text":"4200"');
    expect(json).toContain(`"quick":{"statusIds":["${STATUS}"],"assigneeIds":["${USER}"],"search":"android"}`);
    expect(json).toContain('"spaceKeys":["AMBER"]');
  });

  it('never draws a number the sources do not state: the rows stay a table, and it says so', () => {
    const r = renderWikiDoc(
      [block({ type: 'chart', variant: 'bar', rows: [['Item', 'EUR'], ['Design', '12500'], ['Ads', '99999']] })],
      macroRefs(),
    );
    valid(r.doc);
    expect(types(r.doc.content)).not.toContain('chart');
    expect(types(r.doc.content)).toContain('table');
    expect(JSON.stringify(r.doc)).toContain('99999');
    expect(r.notes).toEqual(['chart_unverified']);
  });

  it('draws no chart without verified numbers, from one point, or from words', () => {
    for (const rows of [
      [['Item', 'EUR'], ['Design', '12500'], ['Dev', '30000']],
      [['Item', 'EUR'], ['Design', '12500']],
      [['Item', 'EUR'], ['Design', 'a lot'], ['Dev', '30000']],
    ]) {
      const r = renderWikiDoc([block({ type: 'chart', rows })], macroRefs(rows.length === 3 && rows[1][1] === '12500' ? { numbers: undefined } : {}));
      valid(r.doc);
      expect(types(r.doc.content)).not.toContain('chart');
    }
  });

  it('reads "1.500" the way the page language writes it', () => {
    expect(numberCandidates('1.500', 'de')).toEqual(['1500', '1.5']);
    expect(numberCandidates('1.500', 'en')).toEqual(['1.5', '1500']);
    expect(numberCandidates('12k')).toEqual(['12000']);
    expect(numberCandidates('12,5', 'de')).toEqual(['12.5']);
  });

  it('a pie with two series becomes bars; a second chart stays a table', () => {
    const two = block({ type: 'chart', variant: 'pie', rows: [['Item', 'Plan', 'Actual'], ['Design', '12500', '12500'], ['Dev', '30000', '30000']] });
    const r = renderWikiDoc([two, budget], macroRefs());
    valid(r.doc);
    const charts = r.doc.content.filter((n) => n.type === 'chart');
    expect(charts).toHaveLength(1);
    expect(charts[0].attrs?.type).toBe('bar');
    // The second one is a table because a page has one chart, not because of its numbers.
    expect(r.notes).toEqual([]);
  });

  it('drops a report on a label the space does not have, and names no other space', () => {
    const r = renderWikiDoc(
      [
        block({ type: 'paragraph', text: 'Decision log [m3].' }),
        block({ type: 'decision_report', labels: ['FINANCE-secret'] }),
        block({ type: 'properties_report', labels: [] }),
      ],
      macroRefs(),
    );
    valid(r.doc);
    expect(types(r.doc.content)).not.toContain('decisionReport');
    expect(types(r.doc.content)).not.toContain('contentPropertiesReport');
    expect(JSON.stringify(r.doc)).not.toContain('FINANCE');
    expect(r.notes).toEqual(['unknown_label']);
  });

  it('a live table needs a space it may read, and drops filters it cannot resolve', () => {
    expect(types(renderWikiDoc([block({ type: 'task_table' })], macroRefs({ spaceId: null })).doc.content)).not.toContain('ticketTable');
    const r = renderWikiDoc([block({ type: 'task_table', items: ['Nonsense'], refs: ['P9', 'T1'] }), block({ type: 'task_table' })], macroRefs());
    valid(r.doc);
    const tables = r.doc.content.filter((n) => n.type === 'ticketTable');
    expect(tables).toHaveLength(1);
    expect((tables[0].attrs?.config as Record<string, unknown>).quick).toBeUndefined();
    expect(r.notes).toEqual(['unknown_status']);
  });

  it('writes dates as text where only text can go', () => {
    const r = renderWikiDoc(
      [block({ type: 'properties', rows: [['Deadline', '[d:2026-11-28]']] }), block({ type: 'callout', title: 'Due [d:2026-11-28]', text: 'Ship it.' })],
      macroRefs({ language: 'de' }),
    );
    valid(r.doc);
    expect(JSON.stringify(r.doc)).toContain('28.11.2026');
    expect(JSON.stringify(r.doc)).not.toContain('[d:');
  });

  it('shows the macro the model meant: a budget table as a chart, people cards as their live tasks', () => {
    const r = renderWikiDoc(
      [
        block({ type: 'heading', level: 2, text: 'Budget Allocation' }),
        // The model wrote the header into items, as gpt-4.1-mini does.
        block({ type: 'table', items: ['Category', 'Amount (EUR)'], rows: [['Design', '12,500'], ['Dev', '30,000']] }),
        block({ type: 'heading', level: 2, text: 'Owners' }),
        block({ type: 'table', rows: [['Area', 'Owner'], ['Theme', 'Rajbha'], ['Import', 'Ala']] }),
        block({ type: 'heading', level: 2, text: 'Open Tasks' }),
        block({ type: 'task_cards', refs: ['P2'], items: ['P2'] }),
      ],
      macroRefs(),
    );
    valid(r.doc);
    const chart = r.doc.content.find((n) => n.type === 'chart');
    expect(chart?.attrs).toMatchObject({ type: 'pie', title: 'Budget Allocation' });
    expect(JSON.stringify(chart)).toContain('"text":"Amount (EUR)"');
    expect(types(r.doc.content).filter((t) => t === 'table')).toHaveLength(2); // the chart's source and the owners
    expect(JSON.stringify(r.doc)).toContain(`"assigneeIds":["${USER}"]`);
    expect(r.notes).toEqual([]);
  });

  it('reads a wide budget row with the header in items as one row per item', () => {
    const r = renderWikiDoc(
      [block({ type: 'chart', variant: 'bar', items: ['Design', 'Development', 'Hosting'], rows: [['Cost', '12500', '30000', '4200']] })],
      macroRefs(),
    );
    valid(r.doc);
    const chart = r.doc.content.find((n) => n.type === 'chart');
    expect(chart).toBeDefined();
    const cells = [...JSON.stringify(chart).matchAll(/"text":"([^"]*)"/g)].map((m) => m[1]);
    expect(cells).toEqual(['Cost', 'Design', '12500', 'Development', '30000', 'Hosting', '4200']);
  });

  it('leaves a one-row table that is no chart as written', () => {
    const r = renderWikiDoc([block({ type: 'table', rows: [['Name', 'Owner', 'Due'], ['Push fix', 'Rajbha', 'Friday']] })], macroRefs());
    const rows = r.doc.content[r.doc.content.length - 1].content ?? [];
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows[0])).toContain('"Owner"');
  });

  it('keeps a table of amounts it cannot verify a table, quietly', () => {
    const r = renderWikiDoc([block({ type: 'heading', level: 2, text: 'Budget' }), block({ type: 'table', rows: [['Item', 'EUR'], ['Ads', '1,000,000'], ['Dev', '30000']] })], macroRefs());
    expect(types(r.doc.content)).not.toContain('chart');
    expect(r.notes).toEqual([]);
  });

  it('shows full dates as dates and leaves partial ones alone', () => {
    const r = renderWikiDoc(
      [block({ type: 'paragraph', text: 'Go-live 15 December 2026, freeze 1.12.2026, review December 3, 2026, cut 2026-11-20; sometime 15 Dec; Germany 15, 2026; version 2.4.1.' })],
      macroRefs(),
    );
    const stamps = [...JSON.stringify(r.doc).matchAll(/"timestamp":"(\d+)"/g)].map((m) => new Date(Number(m[1])).toISOString().slice(0, 10));
    expect(stamps).toEqual(['2026-12-15', '2026-12-01', '2026-12-03', '2026-11-20']);
    expect(JSON.stringify(r.doc)).toContain('sometime 15 Dec; Germany 15, 2026; version 2.4.1.');
  });

  it('does not name people or a repeated label as unknown tasks', () => {
    const r = renderWikiDoc([block({ type: 'task_cards', refs: ['P2'], items: ['high priority'], labels: ['high priority'] })], macroRefs());
    expect(r.unknown).toEqual([]);
    expect(JSON.stringify(r.doc)).toContain('"taskKey":"AMBER-T30"');
  });

  it('keeps the page valid whatever a new block carries', () => {
    const junk = { text: '<script>x</script>', title: '"><img>', items: ['', '\u0000'], rows: [[], ['', '']], variant: 'evil', refs: ['../', 'P2'], labels: ['', 'x'.repeat(500)] };
    for (const type of ['chart', 'task_table', 'decision_report', 'properties_report', 'recent_updates', 'contributors', 'labels_list', 'space_attachments'] as const) {
      for (const r of [refs(), macroRefs()]) valid(renderWikiDoc([block({ type, ...junk })], r).doc);
    }
  });
});

describe('renderWikiDoc file citations (1.18)', () => {
  it('cites a shared file like a message: a link to the message that carries it, named by the file', () => {
    const r = renderWikiDoc(
      [block({ type: 'paragraph', text: 'Budget from the sheet [F1].' })],
      refs({
        message: (h) => (h === 'F1' ? '/chat/c1?m=msg-9' : null),
        messageLabel: (h) => (h === 'F1' ? 'budget.xlsx' : null),
      }),
    );
    const json = JSON.stringify(r.doc);
    expect(json).toContain('"href":"/chat/c1?m=msg-9"');
    expect(json).toContain('"text":"budget.xlsx"');
    expect(() => validateTipTapDoc(json)).not.toThrow();
  });
});

describe('renderWikiDoc amounts given as properties (1.18)', () => {
  it('reads a header row over a column of amounts as a table, and charts it when the numbers are stated', () => {
    const r = renderWikiDoc(
      [
        block({ type: 'heading', level: 2, text: 'Budget' }),
        block({ type: 'properties', rows: [['Item', 'EUR'], ['Licences', '4800'], ['Training', '2200'], ['Migration', '6500']] }),
        block({ type: 'properties', rows: [['Owner', 'Ala'], ['Date', '[d:2026-11-20]']] }),
      ],
      refs({ numbers: new Set(['4800', '2200', '6500']) }),
    );
    const types = r.doc.content.map((n) => n.type);
    expect(types).toContain('chart');
    expect(types).toContain('contentProperties');
    expect(() => validateTipTapDoc(JSON.stringify(r.doc))).not.toThrow();
  });
});

describe('numbersIn (1.19)', () => {
  it('reads the columns of a sheet row as separate values, and a written number as one', () => {
    expect(numbersIn('Licences,120000,98000')).toEqual(expect.arrayContaining(['120000', '98000']));
    expect(numbersIn('Hardware,64000,71000,5')).toEqual(expect.arrayContaining(['64000', '71000', '5']));
    expect(numbersIn('a budget of 12,500 EUR')).toContain('12500');
    expect(numbersIn('a budget of 12,500 EUR')).not.toContain('500');
    expect(numbersIn('1,234,567')).toContain('1234567');
    expect(numbersIn('12,5 Prozent')).toContain('12.5');
  });
});

describe('one chart per page (1.19)', () => {
  const block = (over: Record<string, unknown>) =>
    ({ type: 'table', rows: [], items: [], text: '', title: null, level: null, variant: null, language: null, refs: [], labels: [], ...over }) as unknown as WikiBlock;
  const refs = { language: 'en', person: () => null, message: () => null, task: () => null, page: () => null, pageId: 'p', numbers: new Set(['40', '53', '120000', '64000']) } as unknown as WikiRenderRefs;

  it('keeps the pie the model asked for when an earlier table of amounts could also be a chart', () => {
    const out = renderWikiDoc(
      [
        block({ rows: [['Site', 'Headcount'], ['Graz', '40'], ['Linz', '53']] }),
        block({ type: 'chart', variant: 'pie', title: 'Budget', rows: [['Item', 'Plan'], ['Licences', '120000'], ['Hardware', '64000']] }),
      ],
      refs,
    );
    expect(JSON.stringify(out.doc)).toContain('"type":"pie"');
    expect(JSON.stringify(out.doc)).not.toContain('"type":"bar"');
    expect(out.notes).not.toContain('chart_unverified');
  });

  it('shows a second chart as a table without claiming its numbers are unverified', () => {
    const chart = block({ type: 'chart', variant: 'bar', rows: [['Item', 'Plan'], ['Licences', '120000'], ['Hardware', '64000']] });
    const out = renderWikiDoc([chart, { ...chart, rows: [['Site', 'People'], ['Graz', '40'], ['Linz', '53']] }], refs);
    expect(out.notes).not.toContain('chart_unverified');
    expect(JSON.stringify(out.doc)).toContain('Graz');
  });
});

describe('properties (1.19)', () => {
  it('shows the name of a person, and leaves a priority called P1 alone', () => {
    const doc = renderWikiDoc(
      [{ type: 'properties', rows: [['Owner', '@P1'], ['Lead', 'P2, P1'], ['Priority', 'P1'], ['Note', 'Ask @P9']], items: [], text: '', title: null, level: null, variant: null, language: null, refs: [], labels: [] } as unknown as WikiBlock],
      {
        language: 'en',
        person: (h: string) => ({ P1: { userId: 'u1', name: 'Prince Jadiya' }, P2: { userId: 'u2', name: 'Ala Bera' } })[h] ?? null,
        message: () => null,
        task: () => null,
        page: () => null,
        pageId: 'p',
      } as unknown as WikiRenderRefs,
    );
    const out = JSON.stringify(doc);
    expect(out).toMatch(/Owner.{1,20}Prince Jadiya/);
    expect(out).toMatch(/Lead.{1,20}Ala Bera, Prince Jadiya/);
    expect(out).toMatch(/Priority.{1,20}P1/);
    expect(out).toContain('Ask @P9');
    expect(out).not.toContain('@P1');
  });

  it('shows no citation handle in a property value', () => {
    const doc = renderWikiDoc(
      [{ type: 'properties', rows: [['Source', 'Attached PDF, pages 1-9 [F1]'], ['Owner', 'Ala [m3]']], items: [], text: '', title: null, level: null, variant: null, language: null, refs: [], labels: [] } as unknown as WikiBlock],
      { language: 'en', person: () => null, message: () => null, task: () => null, page: () => null, pageId: 'p' } as unknown as WikiRenderRefs,
    );
    expect(JSON.stringify(doc)).toContain('Attached PDF, pages 1-9');
    expect(JSON.stringify(doc)).not.toMatch(/\[(F1|m3)\]/);
  });
});

describe('plainText keeps comparisons (audit 2026-11-10)', () => {
  it('takes only real tags, never the text between a < and a >', () => {
    expect(plainText('latency < 200 ms and errors > 1%')).toBe('latency < 200 ms and errors > 1%');
    expect(plainText('<strong>Go</strong> <-> live')).toBe('Go <-> live');
  });
});

describe('a date inside bold, italic or code (audit 2026-11-10)', () => {
  it('reads as a date, never as a raw token', () => {
    const r = renderWikiDoc([block({ type: 'paragraph', text: '**Deadline 15.12.2026** and _from 1 Dec 2026_' })], refs());
    const json = JSON.stringify(r.doc);
    expect(json).not.toContain('[d:');
    expect(json).toContain('Deadline 15 Dec 2026');
  });
});
