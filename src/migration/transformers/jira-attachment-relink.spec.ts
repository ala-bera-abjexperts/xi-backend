import {
  collectJiraAttachmentLinks,
  relinkJiraAttachmentHtml,
  relinkJiraAttachmentHtmlWithReport,
} from './jira-attachment-relink';

const targets = new Map([['79837', '5d04a16a-249e-4a74-baf7-30510c89fb27']]);
const source = 'https://jira.muenzent.austrian-mint.at/jira';
const target =
  '/api/v1/attachments/5d04a16a-249e-4a74-baf7-30510c89fb27/download';

describe('relinkJiraAttachmentHtml', () => {
  it('removes only empty decorative attachment icons belonging to the source', () => {
    const icon = `<img class="rendericon" src="${source}/images/icons/link_attachment_7.gif" alt="">`;
    const meaningful = icon.replace('alt=""', 'alt="Attachment guide"');
    const foreign = icon.replace(source, 'https://elsewhere.test');
    expect(
      relinkJiraAttachmentHtml(
        icon + meaningful + foreign + '<p>Document</p>',
        new Map(),
        { sourceBaseUrl: source },
      ),
    ).toBe(meaningful + foreign + '<p>Document</p>');
  });

  it('relinks Jira Server attachment images and thumbnails to the migrated file', () => {
    const html =
      '<a href="https://jira.muenzent.austrian-mint.at/secure/attachment/79837/image.png">' +
      '<img src="https://jira.muenzent.austrian-mint.at/secure/thumbnail/79837/_thumb_79837.png"></a>';

    const out = relinkJiraAttachmentHtml(html, targets, {
      sourceBaseUrl: source,
    });

    expect(out).toBe(`<a href="${target}"><img src="${target}"></a>`);
  });

  it('relinks relative attachment URLs and encoded attachment ids', () => {
    const out = relinkJiraAttachmentHtml(
      '<a href="/jira/secure/attachment/79837/report.pdf?download=1">report</a>',
      targets,
      { sourceBaseUrl: source },
    );

    expect(out).toContain(`href="${target}"`);
  });

  it('relinks an inline image src that points directly at the migrated file', () => {
    const out = relinkJiraAttachmentHtml(
      '<p><img src="/secure/attachment/79837/report.png?download=1" alt="report"></p>',
      targets,
      { sourceBaseUrl: source },
    );

    expect(out).toBe(`<p><img src="${target}" alt="report"></p>`);
  });

  it('relinks every repeated href, attachment image, and thumbnail reference', () => {
    const html =
      `<a href="${source}/secure/attachment/79837/report.png">download</a>` +
      `<img src="${source}/secure/attachment/79837/report.png">` +
      `<img src="${source}/secure/thumbnail/79837/_thumb_79837.png">`;

    const report = relinkJiraAttachmentHtmlWithReport(html, targets, {
      sourceBaseUrl: source,
    });

    expect(report).toEqual({
      html:
        `<a href="${target}">download</a>` +
        `<img src="${target}">` +
        `<img src="${target}">`,
      rewritten: 3,
      unresolved: [],
    });
  });

  it('leaves unknown, foreign-origin, and non-Jira links unchanged', () => {
    const html =
      '<a href="https://files.example.test/secure/attachment/79837/a.pdf">foreign</a>' +
      '<img src="https://jira.muenzent.austrian-mint.at/secure/attachment/999/a.png">' +
      '<a href="https://example.test/report.pdf">external</a>';

    expect(
      relinkJiraAttachmentHtml(html, targets, { sourceBaseUrl: source }),
    ).toBe(html);
  });

  it('relinks links on the advertised origin when it differs from the connection origin', () => {
    // On-premise the connection URL (internal host) and Jira's configured base URL routinely
    // differ; hrefs carry the advertised host, passed here via `allowedOrigins`. An origin outside
    // the set stays foreign and untouched.
    const html =
      '<a href="https://jira.muenzent.austrian-mint.at/secure/attachment/79837/image.png">file</a>' +
      '<a href="https://files.example.test/secure/attachment/79837/a.pdf">foreign</a>';

    const out = relinkJiraAttachmentHtml(html, targets, {
      sourceBaseUrl: 'https://10.20.30.40:8080',
      allowedOrigins: ['https://jira.muenzent.austrian-mint.at'],
    });

    expect(out).toContain(`href="${target}"`);
    expect(out).toContain(
      'href="https://files.example.test/secure/attachment/79837/a.pdf"',
    );
  });

  it('is idempotent', () => {
    const once = relinkJiraAttachmentHtml(
      '<a href="/secure/attachment/79837/a.pdf">download</a>',
      targets,
      { sourceBaseUrl: source },
    );

    expect(
      relinkJiraAttachmentHtml(once, targets, { sourceBaseUrl: source }),
    ).toBe(once);
  });

  it('relinks Jira Cloud attachment content and thumbnail URLs to the migrated file', () => {
    const cloud = 'https://acme.atlassian.net';
    const html =
      `<a href="${cloud}/rest/api/3/attachment/content/79837">file</a>` +
      `<img src="${cloud}/rest/api/3/attachment/thumbnail/79837">`;

    const out = relinkJiraAttachmentHtml(html, targets, {
      sourceBaseUrl: cloud,
    });

    expect(out).toBe(`<a href="${target}">file</a><img src="${target}">`);
  });

  it('relinks a Cloud content URL whose id carries a trailing filename segment', () => {
    const cloud = 'https://acme.atlassian.net';
    const out = relinkJiraAttachmentHtml(
      `<a href="${cloud}/rest/api/3/attachment/content/79837/report.pdf?download=1">doc</a>`,
      targets,
      { sourceBaseUrl: cloud },
    );

    expect(out).toContain(`href="${target}"`);
  });

  it('leaves a foreign-origin Cloud attachment URL untouched and unreported', () => {
    const html =
      '<a href="https://files.example.test/rest/api/3/attachment/content/79837">foreign</a>';

    expect(
      relinkJiraAttachmentHtmlWithReport(html, targets, {
        sourceBaseUrl: 'https://acme.atlassian.net',
      }),
    ).toEqual({ html, rewritten: 0, unresolved: [] });
  });

  it('is idempotent for a Cloud link already rewritten to the XiSuite route', () => {
    const html = `<a href="${target}">file</a>`;

    expect(
      relinkJiraAttachmentHtml(html, targets, {
        sourceBaseUrl: 'https://acme.atlassian.net',
      }),
    ).toBe(html);
  });
});

describe('collectJiraAttachmentLinks', () => {
  it('collects deduped attachment and thumbnail candidates across relative and absolute hrefs', () => {
    const html =
      '<a href="https://jira.example.test/secure/attachment/79837/report%20v2.pdf">a</a>' +
      '<img src="https://jira.example.test/secure/thumbnail/79837/_thumb_79837.png">' +
      '<a href="/jira/secure/attachment/8012/other.docx">b</a>' +
      '<a href="https://jira.example.test/secure/attachment/79837/report%20v2.pdf">dup</a>' +
      '<a href="https://example.test/report.pdf">external</a>';

    expect(collectJiraAttachmentLinks(html)).toEqual([
      {
        sourceId: '79837',
        url: 'https://jira.example.test/secure/attachment/79837/report%20v2.pdf',
        filename: 'report v2.pdf',
      },
      {
        sourceId: '8012',
        url: '/jira/secure/attachment/8012/other.docx',
        filename: 'other.docx',
      },
    ]);
  });

  it('returns nothing for plain content', () => {
    expect(
      collectJiraAttachmentLinks('<a href="https://example.test/x">y</a>'),
    ).toEqual([]);
    expect(collectJiraAttachmentLinks('')).toEqual([]);
  });
});

describe('relinkJiraAttachmentHtmlWithReport', () => {
  it('reports origin-permitted links that have no migrated target, even with an empty map', () => {
    const html =
      '<a href="https://jira.example.test/secure/attachment/9001/missing.pdf">doc</a>';

    const report = relinkJiraAttachmentHtmlWithReport(html, new Map(), {
      sourceBaseUrl: 'https://jira.example.test',
    });

    expect(report.html).toBe(html);
    expect(report.rewritten).toBe(0);
    expect(report.unresolved).toEqual([
      {
        sourceId: '9001',
        url: 'https://jira.example.test/secure/attachment/9001/missing.pdf',
        filename: 'missing.pdf',
      },
    ]);
  });

  it('never reports foreign-origin or third-party links', () => {
    const html =
      '<a href="https://files.example.test/secure/attachment/9001/a.pdf">foreign</a>' +
      '<a href="https://example.test/report.pdf">external</a>';

    expect(
      relinkJiraAttachmentHtmlWithReport(html, new Map(), {
        sourceBaseUrl: 'https://jira.example.test',
      }),
    ).toEqual({ html, rewritten: 0, unresolved: [] });
  });

  it('counts rewrites and reports only the unmapped links', () => {
    const html =
      '<a href="https://jira.example.test/secure/attachment/79837/a.pdf">mapped</a>' +
      '<a href="https://jira.example.test/secure/attachment/9001/b.pdf">unmapped</a>';

    const report = relinkJiraAttachmentHtmlWithReport(html, targets, {
      sourceBaseUrl: 'https://jira.example.test',
    });

    expect(report.rewritten).toBe(1);
    expect(report.html).toContain(target);
    expect(report.unresolved.map((link) => link.sourceId)).toEqual(['9001']);
  });

  it('stays idempotent through the report path', () => {
    const once = relinkJiraAttachmentHtmlWithReport(
      '<a href="/secure/attachment/79837/a.pdf">download</a>',
      targets,
      { sourceBaseUrl: source },
    );
    const twice = relinkJiraAttachmentHtmlWithReport(once.html, targets, {
      sourceBaseUrl: source,
    });

    expect(twice.html).toBe(once.html);
    expect(twice.rewritten).toBe(0);
    expect(twice.unresolved).toEqual([]);
  });
});
