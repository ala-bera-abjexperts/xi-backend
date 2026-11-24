/** Source-URL relink: plain anchors pointing at the source server become crosswalk refs. */

import { pageReferenceKey } from './canonical-ir';
import { parseSourceUrl, relinkSourceUrls } from './source-url-relink';
import type { CirDoc, CirNode } from './canonical-ir';

function linkNode(href: string, text: string): CirNode {
  return { type: 'link', href, children: [{ type: 'text', text }] };
}

const resolved = () => ({
  users: new Map(),
  pages: new Map(),
  attachments: new Map(),
  nativeTables: true,
});

describe('parseSourceUrl', () => {
  it('parses Confluence URLs, fragments, and configured context paths', () => {
    expect(
      parseSourceUrl(
        'https://wiki.example.test/confluence/display/APMIS/AM+Topics#release%20notes',
        'https://wiki.example.test/confluence',
      ),
    ).toEqual({
      kind: 'page',
      spaceKey: 'APMIS',
      pageSourceId: 'AM Topics',
      fragment: 'release notes',
    });
    expect(parseSourceUrl('/pages/viewpage.action?pageId=12812295')).toEqual({
      kind: 'page',
      pageSourceId: '12812295',
    });
    expect(parseSourceUrl('#release-notes')).toBeNull();
  });

  it('parses Confluence attachments and supported Jira URLs', () => {
    expect(
      parseSourceUrl('/download/attachments/123/Pre%20KI%20Assesment.pdf'),
    ).toMatchObject({
      kind: 'attachment',
      image: false,
      pageSourceId: '123',
      filename: 'Pre KI Assesment.pdf',
    });
    expect(parseSourceUrl('/jira/browse/XE-488')).toEqual({
      kind: 'jiraIssue',
      issueKey: 'XE-488',
    });
    expect(parseSourceUrl('/jira/secure/thumbnail/42/thumb.png')).toMatchObject(
      {
        kind: 'jiraAttachment',
        attachmentId: '42',
      },
    );
  });

  it('does not parse malformed or unrelated URL shapes', () => {
    expect(parseSourceUrl('https://google.com')).toBeNull();
    expect(parseSourceUrl('/random/path')).toBeNull();
    expect(parseSourceUrl('mailto:x@y.z')).toBeNull();
  });
});

describe('relinkSourceUrls', () => {
  const ctx = {
    orgId: 'org-1',
    connectionId: 'conn-1',
    sourceBaseUrl: 'https://wiki.example.test/confluence',
    findJiraConnectionsByOrigin: jest.fn(async () => []),
  };

  function entityMapStub(overrides?: {
    pages?: Map<string, unknown>;
    attachments?: Map<string, Map<string, string>>;
  }) {
    return {
      resolveWikiPageTargets: jest.fn(
        async () => overrides?.pages ?? new Map(),
      ),
      listPageAttachments: jest.fn(
        async (_orgId: string, _connectionId: string, pageId: string) =>
          [...(overrides?.attachments?.get(pageId) ?? new Map())].map(
            ([filename, url]) => ({ metadata: { filename, url } }),
          ),
      ),
      resolveIssueTargets: jest.fn(async () => new Map()),
      resolveAttachmentTargets: jest.fn(async () => new Map()),
    };
  }

  it('rewrites an eligible Confluence page link and retains its fragment', async () => {
    const doc: CirDoc = {
      type: 'doc',
      children: [
        {
          type: 'paragraph',
          children: [
            linkNode(
              'https://wiki.example.test/confluence/display/EDV/SNMP#release-notes',
              'SNMP',
            ),
          ],
        },
      ],
    };
    const em = entityMapStub({
      pages: new Map([
        [
          pageReferenceKey('SNMP', 'EDV'),
          {
            pageId: 'uuid-snmp',
            pageSlug: 'snmp',
            spaceKey: 'EDV',
            title: 'SNMP',
          },
        ],
      ]),
    });

    const result = await relinkSourceUrls(doc, em as never, ctx, resolved());

    expect(result).toEqual({ rewritten: 1, unresolved: [] });
    expect(doc.children[0]).toMatchObject({
      children: [
        {
          type: 'pageLink',
          pageSourceId: 'SNMP',
          sourceSpaceKey: 'EDV',
          fragment: 'release-notes',
        },
      ],
    });
  });

  it('rewrites a resolvable Confluence attachment into media', async () => {
    const doc: CirDoc = {
      type: 'doc',
      children: [
        linkNode('/download/attachments/42/assessment.pdf', 'Assessment PDF'),
      ],
    };
    const em = entityMapStub({
      attachments: new Map([
        ['42', new Map([['assessment.pdf', 'https://storage/x.pdf']])],
      ]),
    });

    const result = await relinkSourceUrls(doc, em as never, ctx, resolved());

    expect(result).toEqual({ rewritten: 1, unresolved: [] });
    expect(doc.children[0]).toMatchObject({
      type: 'media',
      kind: 'file',
      src: 'https://storage/x.pdf',
    });
  });

  it('rewrites Jira issue and attachment anchors through one matched source', async () => {
    const doc: CirDoc = {
      type: 'doc',
      children: [
        linkNode('https://jira.example.test/jira/browse/XE-488', 'Issue'),
        linkNode(
          'https://jira.example.test/jira/secure/attachment/42/report.pdf',
          'File',
        ),
      ],
    };
    const em = entityMapStub();
    em.resolveIssueTargets.mockResolvedValue(
      new Map([['XE-488', { taskKey: 'TARGET-9' }]]),
    );
    em.resolveAttachmentTargets.mockResolvedValue(
      new Map([['42', { attachmentId: 'file-42' }]]),
    );

    const result = await relinkSourceUrls(
      doc,
      em as never,
      {
        ...ctx,
        findJiraConnectionsByOrigin: jest.fn(async () => [
          { id: 'jira-1', origin: 'https://jira.example.test' },
        ]),
      },
      resolved(),
    );

    expect(result).toEqual({ rewritten: 2, unresolved: [] });
    expect(doc.children).toEqual([
      expect.objectContaining({ href: '/tasks/TARGET-9' }),
      expect.objectContaining({ href: '/api/v1/attachments/file-42/download' }),
    ]);
  });

  it('reports unresolved internal references but leaves links untouched', async () => {
    const missing = linkNode(
      'https://wiki.example.test/confluence/display/EDV/Missing',
      'Missing',
    );
    const stale = linkNode('https://jira.example.test/browse/XE-488', 'Issue');
    const doc: CirDoc = { type: 'doc', children: [missing, stale] };
    const em = entityMapStub();

    const result = await relinkSourceUrls(
      doc,
      em as never,
      {
        ...ctx,
        findJiraConnectionsByOrigin: jest.fn(async () => [
          { id: 'jira-1', origin: 'https://jira.example.test' },
        ]),
      },
      resolved(),
    );

    expect(result).toMatchObject({
      rewritten: 0,
      unresolved: [
        { kind: 'page', sourceRef: 'Missing' },
        { kind: 'jiraIssue', sourceRef: 'XE-488' },
      ],
    });
    expect(doc.children).toEqual([missing, stale]);
  });

  it('does not rewrite third-party, XiSuite, or ambiguous Jira links', async () => {
    const external = linkNode('https://google.com/display/EDV/SNMP', 'Google');
    const xiSuite = linkNode('/tasks/TARGET-9', 'XiSuite');
    const ambiguous = linkNode(
      'https://jira.example.test/browse/XE-488',
      'Ambiguous',
    );
    const doc: CirDoc = {
      type: 'doc',
      children: [external, xiSuite, ambiguous],
    };
    const em = entityMapStub();

    const result = await relinkSourceUrls(
      doc,
      em as never,
      {
        ...ctx,
        findJiraConnectionsByOrigin: jest.fn(async (url: string) =>
          url.includes('jira.example.test')
            ? [
                { id: 'jira-1', origin: 'https://jira.example.test' },
                { id: 'jira-2', origin: 'https://jira.example.test' },
              ]
            : [],
        ),
      },
      resolved(),
    );

    expect(result).toMatchObject({
      rewritten: 0,
      unresolved: [{ kind: 'jiraIssue' }],
    });
    expect(em.resolveWikiPageTargets).not.toHaveBeenCalled();
    expect(doc.children).toEqual([external, xiSuite, ambiguous]);
  });
});
