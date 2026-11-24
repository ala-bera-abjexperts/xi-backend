import { ContentTransformService } from './content-transform.service';
import { pageReferenceKey } from './canonical-ir';

describe('ContentTransformService.inlineExcerptIncludes legacy carrier upgrade', () => {
  const service = new ContentTransformService({} as never);

  it('replaces excerpt-include carriers with a live stable-id node', () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'externalMacro',
          attrs: {
            name: 'excerpt-include',
            params: {
              page: 'ADDITIONAL MACROS',
              pageId: 'page-1',
              excerpt: 'summary',
              nopanel: 'true',
            },
          },
        },
      ],
    });
    const excerpt = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'excerpt body' }],
        },
      ],
    });

    const out = JSON.parse(
      service.inlineExcerptIncludes(
        content,
        { 'ADDITIONAL MACROS': excerpt },
        {
          'ADDITIONAL MACROS': {
            pageId: 'page-1',
            title: 'ADDITIONAL MACROS',
            url: '/spaces/APMIS3/wiki/page-1',
          },
        },
      ),
    ) as {
      content: Array<{ type: string; content?: Array<{ text?: string }> }>;
    };

    expect(out.content).toEqual([
      {
        type: 'excerptInclude',
        attrs: {
          pageId: 'page-1',
          title: 'ADDITIONAL MACROS',
          excerptName: 'summary',
          nopanel: true,
          sourceParams: {
            page: 'ADDITIONAL MACROS',
            pageId: 'page-1',
            excerpt: 'summary',
            nopanel: 'true',
          },
        },
      },
    ]);
  });

  it('does not freeze or link content when the stable target is unresolved', () => {
    const content = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'externalMacro',
          attrs: {
            name: 'excerpt-include',
            params: { page: 'ADDITIONAL MACROS' },
          },
        },
      ],
    });

    const out = JSON.parse(service.inlineExcerptIncludes(content, {}, {})) as {
      content: Array<{
        type: string;
        content?: Array<{
          type: string;
          text?: string;
          marks?: Array<{ type: string; attrs?: { href?: string } }>;
        }>;
      }>;
    };

    expect(out.content).toEqual([
      {
        type: 'externalMacro',
        attrs: {
          name: 'excerpt-include',
          params: { page: 'ADDITIONAL MACROS' },
        },
      },
    ]);
  });
});

describe('ContentTransformService Confluence user attribution', () => {
  it('carries the crosswalk placeholder signal into the stored mention', async () => {
    const userId = '99999999-8888-4777-8666-555555555555';
    const entityMap = {
      getTargets: jest.fn().mockResolvedValue(
        new Map([
          [
            'legacy-user',
            {
              target_id: userId,
              metadata: {
                display_name: 'Christian Kienzl',
                is_placeholder: true,
              },
            },
          ],
        ]),
      ),
      resolveWikiPageTargets: jest.fn().mockResolvedValue(new Map()),
      resolveIssueTargets: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new ContentTransformService(entityMap as never);
    const result = await service.renderBodyAsTipTap(
      {
        format: 'adf',
        value: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'mention',
                  attrs: { id: 'legacy-user', text: 'Christian Kienzl' },
                },
              ],
            },
          ],
        },
      },
      { orgId: 'org-1', connectionId: 'connection-1' },
    );

    expect(JSON.parse(result.content)).toMatchObject({
      content: [
        {
          content: [
            {
              type: 'userMention',
              attrs: {
                userId,
                userName: 'Christian Kienzl',
                isPlaceholder: true,
              },
            },
          ],
        },
      ],
    });
  });
});

describe('ContentTransformService source URL relink reporting', () => {
  it('returns unresolved attachment source references structurally for retry decisions', async () => {
    const service = new ContentTransformService({
      getTargets: jest.fn().mockResolvedValue(new Map()),
      resolveWikiPageTargets: jest.fn().mockResolvedValue(new Map()),
      listPageAttachments: jest.fn().mockResolvedValue([]),
      resolveIssueTargets: jest.fn().mockResolvedValue(new Map()),
    } as never);

    const result = await service.renderBodyAsTipTap(
      {
        format: 'storage',
        value:
          '<p><ac:link><ri:attachment ri:filename="legacy.doc" /></ac:link></p>',
      },
      { orgId: 'org-1', connectionId: 'connection-1', pageSourceId: 'page-1' },
    );

    expect(result.unresolvedAttachmentRefs).toEqual(['legacy.doc']);
  });

  it('flags and reports unresolved internal source links for the guarded second pass', async () => {
    const log = jest.fn();
    const service = new ContentTransformService({
      getTargets: jest.fn().mockResolvedValue(new Map()),
      resolveWikiPageTargets: jest.fn().mockResolvedValue(new Map()),
      listPageAttachments: jest.fn().mockResolvedValue([]),
      resolveIssueTargets: jest.fn().mockResolvedValue(new Map()),
      resolveAttachmentTargets: jest.fn().mockResolvedValue(new Map()),
    } as never);

    const result = await service.renderBodyAsTipTap(
      {
        format: 'storage',
        value:
          '<p><a href="https://wiki.example.test/confluence/display/EDV/Missing">Missing</a></p>',
      },
      {
        orgId: 'org-1',
        connectionId: 'connection-1',
        sourceBaseUrl: 'https://wiki.example.test/confluence',
        log,
      },
    );

    expect(result.needsRelink).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('left 1 internal link'),
      expect.objectContaining({
        unresolvedLinks: [
          expect.objectContaining({ kind: 'page', sourceRef: 'Missing' }),
        ],
      }),
    );
  });

  it('flags an unresolved <ri:page> pageLink and converges once its target is mapped', async () => {
    const pageTargets = new Map();
    const service = new ContentTransformService({
      getTargets: jest.fn().mockResolvedValue(new Map()),
      resolveWikiPageTargets: jest
        .fn()
        .mockImplementation(() => Promise.resolve(pageTargets)),
      listPageAttachments: jest.fn().mockResolvedValue([]),
      resolveIssueTargets: jest.fn().mockResolvedValue(new Map()),
      resolveAttachmentTargets: jest.fn().mockResolvedValue(new Map()),
    } as never);
    const body = {
      format: 'storage' as const,
      value:
        '<p><ac:link ac:anchor="release-notes"><ri:page ri:content-title="AM Topics" ri:space-key="APMIS"/><ac:link-body>Read more</ac:link-body></ac:link></p>',
    };
    const context = { orgId: 'org-1', connectionId: 'connection-1' };

    // Pass 1: the target page is not in the crosswalk yet → the link degrades to text, and the
    // page MUST be flagged so `page_relink` re-renders it. Before XE-T471 this was false and the
    // link was lost forever.
    const first = await service.renderBodyAsTipTap(body, context);

    expect(first.needsRelink).toBe(true);
    expect(first.content).not.toContain('wikiLink');

    pageTargets.set(pageReferenceKey('AM Topics', 'APMIS'), {
      pageId: '11111111-1111-4111-8111-111111111111',
      pageSlug: 'am-topics',
      spaceKey: 'APMIS',
      title: 'AM Topics',
    });

    // Pass 2 (the `page_relink` re-render): a real link, fragment preserved, flag cleared.
    const second = await service.renderBodyAsTipTap(body, context);

    expect(second.needsRelink).toBe(false);
    expect(JSON.parse(second.content)).toMatchObject({
      content: [
        {
          content: [
            {
              type: 'wikiLink',
              attrs: {
                pageId: '11111111-1111-4111-8111-111111111111',
                pageSlug: 'am-topics',
                spaceKey: 'APMIS',
                fragment: 'release-notes',
              },
            },
          ],
        },
      ],
    });

    // Pass 3: still resolved → no flag, byte-identical output (idempotent no-op).
    const third = await service.renderBodyAsTipTap(body, context);

    expect(third.needsRelink).toBe(false);
    expect(third.content).toBe(second.content);
  });

  it('does not flag a pageLink whose target is mapped on the first pass', async () => {
    const pageTargets = new Map([
      [
        pageReferenceKey('AM Topics', 'APMIS'),
        {
          pageId: '11111111-1111-4111-8111-111111111111',
          pageSlug: 'am-topics',
          spaceKey: 'APMIS',
          title: 'AM Topics',
        },
      ],
    ]);
    const service = new ContentTransformService({
      getTargets: jest.fn().mockResolvedValue(new Map()),
      resolveWikiPageTargets: jest
        .fn()
        .mockImplementation(() => Promise.resolve(pageTargets)),
      listPageAttachments: jest.fn().mockResolvedValue([]),
      resolveIssueTargets: jest.fn().mockResolvedValue(new Map()),
      resolveAttachmentTargets: jest.fn().mockResolvedValue(new Map()),
    } as never);

    const result = await service.renderBodyAsTipTap(
      {
        format: 'storage',
        value:
          '<p><ac:link><ri:page ri:content-title="AM Topics" ri:space-key="APMIS"/><ac:link-body>Read more</ac:link-body></ac:link></p>',
      },
      { orgId: 'org-1', connectionId: 'connection-1' },
    );

    expect(result.needsRelink).toBe(false);
    expect(result.content).toContain('wikiLink');
  });

  it('converges when the guarded relink pass finds the page crosswalk later', async () => {
    const pageTargets = new Map();
    const service = new ContentTransformService({
      getTargets: jest.fn().mockResolvedValue(new Map()),
      resolveWikiPageTargets: jest
        .fn()
        .mockImplementation(() => Promise.resolve(pageTargets)),
      listPageAttachments: jest.fn().mockResolvedValue([]),
      resolveIssueTargets: jest.fn().mockResolvedValue(new Map()),
      resolveAttachmentTargets: jest.fn().mockResolvedValue(new Map()),
    } as never);
    const body = {
      format: 'storage' as const,
      value:
        '<p><a href="https://wiki.example.test/confluence/display/EDV/Target">Target</a></p>',
    };
    const context = {
      orgId: 'org-1',
      connectionId: 'connection-1',
      sourceBaseUrl: 'https://wiki.example.test/confluence',
    };

    expect((await service.renderBodyAsTipTap(body, context)).needsRelink).toBe(
      true,
    );

    pageTargets.set(pageReferenceKey('Target', 'EDV'), {
      pageId: '11111111-1111-4111-8111-111111111111',
      pageSlug: 'target',
      spaceKey: 'EDV',
      title: 'Target',
    });

    const rerendered = await service.renderBodyAsTipTap(body, context);

    expect(rerendered.needsRelink).toBe(false);
    expect(JSON.parse(rerendered.content)).toMatchObject({
      content: [
        {
          content: [
            {
              type: 'wikiLink',
              attrs: {
                pageId: '11111111-1111-4111-8111-111111111111',
                pageSlug: 'target',
                spaceKey: 'EDV',
              },
            },
          ],
        },
      ],
    });
  });
});
