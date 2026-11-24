/**
 * @fileoverview Unit tests for the public label-backed file list.
 *
 * The whole point of this endpoint is that authorisation comes from the
 * page→element binding: the space id and label ids are read from the STORED
 * element, never from the caller. These tests pin that down — a tampered
 * elementId and a non-label element must both be refused, and the space id used
 * for the node lookup must be the one stored on the page.
 * @module src/site-studio/public/public-site-studio.service.spec
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PublicSiteStudioService } from './public-site-studio.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { IFeNode } from '../../file-explorer/interfaces/fe-node.interface';

const DOMAIN = 'files.example.test';
const PATH = 'downloads';
const ELEMENT_ID = '44444444-4444-4444-4444-444444444444';
const SPACE_ID = '55555555-5555-4555-8555-555555555555';
const LABEL_ID = '66666666-6666-4666-8666-666666666666';
const ORG_ID = 'org-1';

/** A PostgREST double: every builder method chains, and the chain is awaitable. */
function fakeChain(result: unknown) {
  const chain: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: result, error: null }).then(resolve),
    maybeSingle: jest.fn().mockResolvedValue({ data: result, error: null }),
  };

  for (const method of ['select', 'eq', 'in', 'or', 'order', 'limit']) {
    chain[method] = jest.fn(() => chain);
  }

  return chain;
}

function feNode(overrides: Partial<IFeNode> = {}): IFeNode {
  return {
    id: 'node-1',
    organization_id: ORG_ID,
    space_id: SPACE_ID,
    parent_id: null,
    ancestor_ids: [],
    node_type: 'file',
    name: 'Report.pdf',
    description: null,
    mime_type: 'application/pdf',
    file_size: 2048,
    current_version_id: 'version-1',
    delete_op_id: null,
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
    created_by: 'user-1',
    updated_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('PublicSiteStudioService label-backed file widget', () => {
  let from: jest.Mock;
  let listNodes: jest.Mock;
  let resolveVersion: jest.Mock;
  let signedDownloadUrl: jest.Mock;
  let service: PublicSiteStudioService;
  let pageContent: unknown;
  let shareRows: Array<{ node_id: string; token: string | null }>;

  /** A label-bound file widget element as the editor stores it. */
  const labelElement = (overrides: Record<string, unknown> = {}) => ({
    id: ELEMENT_ID,
    type: 'fileList',
    content: {
      sourceMode: 'label',
      spaceId: SPACE_ID,
      labelIds: [LABEL_ID],
      ...overrides,
    },
  });

  beforeEach(() => {
    pageContent = [
      { id: 'root', type: 'container', content: [labelElement()] },
    ];
    shareRows = [{ node_id: 'node-1', token: 'share-token-1' }];
    listNodes = jest.fn().mockResolvedValue([feNode()]);
    resolveVersion = jest.fn().mockResolvedValue({ file_path: 'org/space/1' });
    signedDownloadUrl = jest.fn().mockResolvedValue('https://signed.test/1');

    from = jest.fn((table: string) => {
      switch (table) {
        case 'site_studio_domains':
          return fakeChain({ funnel_id: 'funnel-1' });
        case 'site_studio_funnels':
          return fakeChain({
            id: 'funnel-1',
            published: true,
            organization_id: ORG_ID,
          });
        case 'site_studio_pages':
          return fakeChain({
            id: 'page-1',
            funnel_id: 'funnel-1',
            organization_id: ORG_ID,
            published: true,
            path_name: PATH,
            content: pageContent,
          });
        case 'spaces':
          return fakeChain({
            id: SPACE_ID,
            is_active: true,
            is_archived: false,
          });
        case 'fe_shares':
          return fakeChain(shareRows);
        default:
          return fakeChain(null);
      }
    });

    service = new PublicSiteStudioService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {} as never,
      {} as never,
      {} as never,
      { listNodes, resolveVersion } as never,
      { signedDownloadUrl } as never,

      // PermissionsService, added by the can-edit funnel check. Not exercised here.
      {} as never,
    );
  });

  const call = (elementId = ELEMENT_ID) =>
    service.listFilesForElement(DOMAIN, PATH, elementId);

  const download = (nodeId = 'node-1', elementId = ELEMENT_ID) =>
    service.getElementFileDownloadUrl(DOMAIN, PATH, elementId, nodeId);

  // ── Happy path ────────────────────────────────────────────────────────────

  it('resolves the list using the space and labels stored on the element', async () => {
    const result = await call();

    expect(listNodes).toHaveBeenCalledWith(
      SPACE_ID,
      ORG_ID,
      'all',
      { label_ids: [LABEL_ID] },
      { truncated: false },
    );
    expect(result).toEqual({
      data: [
        {
          nodeId: 'node-1',
          name: 'Report.pdf',
          nodeType: 'file',
          mimeType: 'application/pdf',
          fileSize: 2048,
          token: 'share-token-1',
        },
      ],
      count: 1,
      truncated: false,
    });
  });

  it('returns no internal identifiers beyond the nodeId the download needs', async () => {
    const [item] = (await call()).data;

    expect(Object.keys(item).sort()).toEqual([
      'fileSize',
      'mimeType',
      'name',
      'nodeId',
      'nodeType',
      'token',
    ]);
  });

  // The regression this route exists for: most live files have no link share, and
  // dropping them silently hid ~85% of a widget's matches.
  it('returns a label-matched FILE that has no share token', async () => {
    shareRows = [];

    await expect(call()).resolves.toEqual({
      data: [
        {
          nodeId: 'node-1',
          name: 'Report.pdf',
          nodeType: 'file',
          mimeType: 'application/pdf',
          fileSize: 2048,
        },
      ],
      count: 1,
      truncated: false,
    });
  });

  it('still omits a FOLDER with no share token — nothing to link to', async () => {
    shareRows = [];
    listNodes.mockResolvedValue([feNode({ node_type: 'folder' })]);

    await expect(call()).resolves.toEqual({
      data: [],
      count: 0,
      truncated: false,
    });
  });

  // ── Refusals ──────────────────────────────────────────────────────────────

  it('refuses a tampered elementId that is not on the page', async () => {
    await expect(call('77777777-7777-4777-8777-777777777777')).rejects.toThrow(
      NotFoundException,
    );
    expect(listNodes).not.toHaveBeenCalled();
  });

  it('refuses a non-UUID elementId before any lookup', async () => {
    await expect(call('not-a-uuid')).rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
  });

  it('refuses an element whose sourceMode is not label', async () => {
    pageContent = [labelElement({ sourceMode: 'manual' })];

    await expect(call()).rejects.toThrow(NotFoundException);
    expect(listNodes).not.toHaveBeenCalled();
  });

  it('refuses an element with no sourceMode at all — no permissive fallback', async () => {
    pageContent = [{ id: ELEMENT_ID, type: 'fileList', content: {} }];

    await expect(call()).rejects.toThrow(NotFoundException);
    expect(listNodes).not.toHaveBeenCalled();
  });

  it('refuses an element type that is not a file widget', async () => {
    pageContent = [{ ...labelElement(), type: 'wikiPageList' }];

    await expect(call()).rejects.toThrow(NotFoundException);
    expect(listNodes).not.toHaveBeenCalled();
  });

  it('ignores a space id the caller did not store on the element', async () => {
    pageContent = [labelElement({ spaceId: 'not-a-uuid' })];

    await expect(call()).resolves.toEqual({
      data: [],
      count: 0,
      truncated: false,
    });
    expect(listNodes).not.toHaveBeenCalled();
  });

  // ── Page-bound download ───────────────────────────────────────────────────
  //
  // `nodeId` is NEVER trusted on its own: the element is re-resolved and the id
  // must appear in the label set that resolution produced.

  describe('getElementFileDownloadUrl', () => {
    it('signs a download for a file in the element label set, share or not', async () => {
      shareRows = [];

      await expect(download()).resolves.toBe('https://signed.test/1');
      expect(signedDownloadUrl).toHaveBeenCalledWith(
        'org/space/1',
        'Report.pdf',
      );
    });

    it('refuses a nodeId that is not in the element label set', async () => {
      await expect(
        download('99999999-9999-4999-8999-999999999999'),
      ).rejects.toThrow(NotFoundException);
      expect(signedDownloadUrl).not.toHaveBeenCalled();
    });

    it('refuses an element whose sourceMode is not label', async () => {
      pageContent = [labelElement({ sourceMode: 'manual' })];

      await expect(download()).rejects.toThrow(NotFoundException);
      expect(listNodes).not.toHaveBeenCalled();
      expect(signedDownloadUrl).not.toHaveBeenCalled();
    });

    it('refuses a tampered elementId that is not on the page', async () => {
      await expect(
        download('node-1', '77777777-7777-4777-8777-777777777777'),
      ).rejects.toThrow(NotFoundException);
      expect(listNodes).not.toHaveBeenCalled();
      expect(signedDownloadUrl).not.toHaveBeenCalled();
    });

    it('refuses a folder — zipping stays on the token flow', async () => {
      listNodes.mockResolvedValue([feNode({ node_type: 'folder' })]);

      await expect(download()).rejects.toThrow(NotFoundException);
      expect(signedDownloadUrl).not.toHaveBeenCalled();
    });
  });
});

/**
 * The public macro endpoint has no caller-controlled target or filter parameters:
 * the ordinal selects a node from the already-authorised stored TipTap document.
 */
describe('PublicSiteStudioService public wiki macro resolver', () => {
  const PAGE_ID = '11111111-1111-4111-8111-111111111111';
  const ORDINAL = 1;
  let service: PublicSiteStudioService;
  let getWikiPage: jest.SpyInstance;
  let getPages: jest.Mock;
  let from: jest.Mock;

  beforeEach(() => {
    getPages = jest.fn().mockResolvedValue({ data: [] });
    from = jest.fn((table: string) =>
      fakeChain(
        table === 'spaces'
          ? {
              id: SPACE_ID,
              organization_id: ORG_ID,
              is_active: true,
              is_archived: false,
            }
          : [],
      ),
    );
    service = new PublicSiteStudioService(
      {
        getClient: () => ({ from }),
      } as unknown as SupabaseAdminService,
      {} as never,
      {} as never,
      { getPages } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    getWikiPage = jest.spyOn(service, 'getWikiPage');
  });

  const resolve = (ordinal = ORDINAL) =>
    (
      service as unknown as {
        resolvePublicWikiMacro: (
          user: undefined,
          spaceId: string,
          pageId: string,
          ordinal: number,
        ) => Promise<unknown>;
      }
    ).resolvePublicWikiMacro(undefined, SPACE_ID, PAGE_ID, ordinal);

  it('uses the existing public page access path, then selects the stored macro by document order', async () => {
    getWikiPage.mockResolvedValue({
      id: PAGE_ID,
      content_format: 'tiptap',
      content: JSON.stringify({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
          { type: 'pageTree', attrs: { depth: 2 } },
          { type: 'recentlyUpdated', attrs: { limit: 3 } },
        ],
      }),
    });

    await expect(resolve()).resolves.toMatchObject({
      kind: 'recentlyUpdated',
      ordinal: ORDINAL,
      attrs: { limit: 3 },
    });
    expect(getWikiPage).toHaveBeenCalledWith(undefined, SPACE_ID, PAGE_ID);
  });

  it('rejects a negative or non-integer ordinal before loading any page', async () => {
    await expect(resolve(-1)).rejects.toBeInstanceOf(BadRequestException);
    expect(getWikiPage).not.toHaveBeenCalled();

    await expect(resolve(1.5)).rejects.toBeInstanceOf(BadRequestException);
    expect(getWikiPage).not.toHaveBeenCalled();
  });

  it('refuses a page without a supported macro at the requested ordinal', async () => {
    getWikiPage.mockResolvedValue({
      id: PAGE_ID,
      content_format: 'tiptap',
      content: JSON.stringify({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'only text' }] },
        ],
      }),
    });

    await expect(resolve(0)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses malformed or non-TipTap stored content without treating it as a macro', async () => {
    getWikiPage.mockResolvedValue({
      id: PAGE_ID,
      content_format: 'tiptap',
      content: '{not-json',
    });

    await expect(resolve(0)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns only separately published, unarchived, publicly accessible recent pages', async () => {
    getWikiPage.mockResolvedValue({
      id: PAGE_ID,
      content_format: 'tiptap',
      content: JSON.stringify({
        type: 'doc',
        content: [{ type: 'recentlyUpdated', attrs: { limit: 10 } }],
      }),
    });
    getPages.mockResolvedValue({
      data: [
        {
          id: 'public-page',
          title: 'Public',
          slug: 'public',
          is_published: true,
          is_archived: false,
          updated_at: '2026-08-23T10:00:00Z',
        },
        {
          id: 'restricted-page',
          title: 'Restricted',
          is_published: true,
          is_archived: false,
          has_custom_permissions: true,
          updated_at: '2026-08-23T12:00:00Z',
        },
        {
          id: 'draft-page',
          title: 'Draft',
          is_published: false,
          is_archived: false,
          updated_at: '2026-08-23T13:00:00Z',
        },
        {
          id: 'archived-page',
          title: 'Archived',
          is_published: true,
          is_archived: true,
          updated_at: '2026-08-23T14:00:00Z',
        },
      ],
    });

    await expect(resolve(0)).resolves.toMatchObject({
      kind: 'recentlyUpdated',
      data: [{ id: 'public-page' }],
    });
  });

  it('does not broaden a stored recent-content type filter XISUITE cannot serve', async () => {
    getWikiPage.mockResolvedValue({
      id: PAGE_ID,
      content_format: 'tiptap',
      content: JSON.stringify({
        type: 'doc',
        content: [{ type: 'recentlyUpdated', attrs: { types: ['blogpost'] } }],
      }),
    });

    await expect(resolve(0)).resolves.toMatchObject({
      kind: 'recentlyUpdated',
      attrs: { types: ['blogpost'] },
      data: [],
    });
    expect(getPages).not.toHaveBeenCalled();
  });

  it('fails closed when a recent-content filter mixes pages with an unsupported type', async () => {
    getWikiPage.mockResolvedValue({
      id: PAGE_ID,
      content_format: 'tiptap',
      content: JSON.stringify({
        type: 'doc',
        content: [
          { type: 'recentlyUpdated', attrs: { types: ['page', 'blogpost'] } },
        ],
      }),
    });

    await expect(resolve(0)).resolves.toMatchObject({
      kind: 'recentlyUpdated',
      attrs: { types: ['page', 'blogpost'] },
      data: [],
    });
    expect(getPages).not.toHaveBeenCalled();
  });

  it.each([
    ['recentlyUsedLabels', { scope: 'space', count: 10 }, 'recentlyUsedLabels'],
    ['relatedLabels', { labels: ['security'] }, 'relatedLabels'],
    [
      'recentlyUpdatedDashboard',
      { labels: ['security'], types: ['page'] },
      'recentlyUpdatedDashboard',
    ],
    [
      'contentReportTable',
      { labels: ['security'], limit: 20 },
      'contentReportTable',
    ],
    ['navigationMap', { label: 'security', wrapAfter: 5 }, 'navigationMap'],
  ])(
    'resolves stored public-safe %s data only from independently public pages',
    async (type, attrs, kind) => {
      getWikiPage.mockResolvedValue({
        id: PAGE_ID,
        content_format: 'tiptap',
        content: JSON.stringify({ type: 'doc', content: [{ type, attrs }] }),
      });
      getPages.mockResolvedValue({
        data: [
          {
            id: 'public-page',
            title: 'Public security',
            slug: 'public-security',
            is_published: true,
            is_archived: false,
            updated_at: '2026-08-24T10:00:00Z',
          },
          {
            id: 'restricted-page',
            title: 'Restricted security',
            is_published: true,
            is_archived: false,
            has_custom_permissions: true,
            updated_at: '2026-08-24T11:00:00Z',
          },
          {
            id: 'draft-page',
            title: 'Draft security',
            is_published: false,
            is_archived: false,
          },
        ],
      });
      from.mockImplementation((table: string) =>
        fakeChain(
          table === 'spaces'
            ? {
                id: SPACE_ID,
                organization_id: ORG_ID,
                is_active: true,
                is_archived: false,
              }
            : table === 'wiki_page_labels'
              ? [
                  {
                    page_id: 'public-page',
                    assigned_at: '2026-08-24T09:00:00Z',
                    label: {
                      id: 'label-1',
                      name: 'security',
                      color: '#123456',
                    },
                  },
                  {
                    page_id: 'public-page',
                    assigned_at: '2026-08-24T09:00:00Z',
                    label: { id: 'label-2', name: 'review', color: '#654321' },
                  },
                  {
                    page_id: 'restricted-page',
                    assigned_at: '2026-08-24T10:00:00Z',
                    label: {
                      id: 'label-1',
                      name: 'security',
                      color: '#123456',
                    },
                  },
                ]
              : [],
        ),
      );

      const result = (await resolve(0)) as {
        kind: string;
        data: Array<Record<string, unknown>>;
      };

      expect(result.kind).toBe(kind);
      expect(JSON.stringify(result.data)).toContain(
        type === 'recentlyUsedLabels'
          ? 'security'
          : type === 'relatedLabels'
            ? 'review'
            : 'public-page',
      );
      expect(JSON.stringify(result.data)).not.toContain('restricted-page');
      expect(JSON.stringify(result.data)).not.toContain('draft-page');
    },
  );

  it('fails closed for malformed labels, unsupported dashboard types, and user filters', async () => {
    getWikiPage.mockResolvedValue({
      id: PAGE_ID,
      content_format: 'tiptap',
      content: JSON.stringify({
        type: 'doc',
        content: [
          { type: 'contentReportTable', attrs: { labels: ['bad\u0000label'] } },
          { type: 'recentlyUpdatedDashboard', attrs: { types: ['blogpost'] } },
          {
            type: 'recentlyUpdatedDashboard',
            attrs: { users: ['internal-user'] },
          },
        ],
      }),
    });

    await expect(resolve(0)).resolves.toMatchObject({
      kind: 'contentReportTable',
      data: [],
    });
    await expect(resolve(1)).resolves.toMatchObject({
      kind: 'recentlyUpdatedDashboard',
      data: [],
    });
    await expect(resolve(2)).resolves.toMatchObject({
      kind: 'recentlyUpdatedDashboard',
      data: [],
    });
    expect(getPages).not.toHaveBeenCalled();
  });

  it('ignores an attachments macro pageId and exposes only safe URLs for its owning page', async () => {
    const originalStorageUrl = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = 'https://storage.example.test';
    getWikiPage.mockResolvedValue({
      id: PAGE_ID,
      content_format: 'tiptap',
      content: JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'attachmentsList',
            attrs: { pageId: '99999999-9999-4999-8999-999999999999' },
          },
        ],
      }),
    });
    from.mockImplementation((table: string) =>
      fakeChain(
        table === 'wiki_page_attachments'
          ? [
              {
                id: 'attachment-1',
                file_name: 'safe.pdf',
                file_path:
                  'https://storage.example.test/storage/v1/object/public/wiki-attachments/wiki/safe.pdf',
                file_size: 1,
                file_type: 'application/pdf',
                created_at: '2026-08-23T10:00:00Z',
              },
              {
                id: 'attachment-2',
                file_name: 'unsafe.html',
                file_path: 'javascript:alert(1)',
              },
            ]
          : [],
      ),
    );

    try {
      await expect(resolve(0)).resolves.toMatchObject({
        kind: 'attachmentsList',
        attrs: { pageId: PAGE_ID },
        data: [{ id: 'attachment-1', name: 'safe.pdf' }],
      });
      expect(from).toHaveBeenCalledWith('wiki_page_attachments');
    } finally {
      if (originalStorageUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = originalStorageUrl;
    }
  });

  it('resolves a gallery only from its owning page attachments and keeps stored presentation attrs', async () => {
    const originalStorageUrl = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = 'https://storage.example.test';
    getWikiPage.mockResolvedValue({
      id: PAGE_ID,
      content_format: 'tiptap',
      content: JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'gallery',
            attrs: {
              pageId: '99999999-9999-4999-8999-999999999999',
              columns: 3,
              captions: false,
              title: 'Screenshots',
            },
          },
        ],
      }),
    });
    from.mockImplementation((table: string) =>
      fakeChain(
        table === 'wiki_page_attachments'
          ? [
              {
                id: 'attachment-1',
                file_name: 'diagram.png',
                file_path:
                  'https://storage.example.test/storage/v1/object/public/wiki-attachments/wiki/diagram.png',
                file_size: 1,
                file_type: 'image/png',
                created_at: '2026-08-23T10:00:00Z',
              },
              {
                id: 'attachment-2',
                file_name: 'notes.pdf',
                file_path:
                  'https://storage.example.test/storage/v1/object/public/wiki-attachments/wiki/notes.pdf',
                file_size: 2,
                file_type: 'application/pdf',
                created_at: '2026-08-23T10:01:00Z',
              },
              {
                id: 'attachment-3',
                file_name: 'unsafe.html',
                file_path: 'javascript:alert(1)',
                file_size: 3,
                file_type: 'text/html',
                created_at: '2026-08-23T10:02:00Z',
              },
            ]
          : [],
      ),
    );

    try {
      await expect(resolve(0)).resolves.toMatchObject({
        kind: 'gallery',
        attrs: {
          pageId: PAGE_ID,
          columns: 3,
          captions: false,
          title: 'Screenshots',
        },
        data: [
          {
            id: 'attachment-1',
            name: 'diagram.png',
            mimeType: 'image/png',
          },
          {
            id: 'attachment-2',
            name: 'notes.pdf',
            mimeType: 'application/pdf',
          },
        ],
      });
      expect(from).toHaveBeenCalledWith('wiki_page_attachments');
    } finally {
      if (originalStorageUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = originalStorageUrl;
    }
  });

  it('resolves an include only from its stored target and independently loads that public page', async () => {
    const TARGET_ID = '22222222-2222-4222-8222-222222222222';
    getWikiPage.mockImplementation(
      (_user: unknown, _spaceId: string, pageId: string) =>
        pageId === PAGE_ID
          ? {
              id: PAGE_ID,
              content_format: 'tiptap',
              content: JSON.stringify({
                type: 'doc',
                content: [
                  {
                    type: 'includePage',
                    attrs: { pageId: TARGET_ID, title: 'Shared page' },
                  },
                ],
              }),
            }
          : {
              id: TARGET_ID,
              title: 'Shared page',
              content_format: 'tiptap',
              content: JSON.stringify({
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Live target body' }],
                  },
                ],
              }),
            },
    );

    await expect(resolve(0)).resolves.toMatchObject({
      kind: 'includePage',
      attrs: { pageId: TARGET_ID, title: 'Shared page' },
      data: {
        pageId: TARGET_ID,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Live target body' }],
            },
          ],
        },
        resolutions: {},
      },
    });
    expect(getWikiPage).toHaveBeenNthCalledWith(
      2,
      undefined,
      SPACE_ID,
      TARGET_ID,
    );
  });

  it('derives a cross-space target space from the stored page id within the source organization', async () => {
    const TARGET_ID = '22222222-2222-4222-8222-222222222222';
    const TARGET_SPACE_ID = '33333333-3333-4333-8333-333333333333';
    from.mockImplementation((table: string) =>
      fakeChain(
        table === 'spaces'
          ? {
              id: SPACE_ID,
              organization_id: ORG_ID,
              is_active: true,
              is_archived: false,
            }
          : table === 'wiki_pages'
            ? { space_id: TARGET_SPACE_ID }
            : [],
      ),
    );
    getWikiPage.mockImplementation(
      (_user: unknown, requestSpaceId: string, pageId: string) => {
        if (pageId === PAGE_ID) {
          return {
            id: PAGE_ID,
            content_format: 'tiptap',
            content: JSON.stringify({
              type: 'doc',
              content: [
                {
                  type: 'includePage',
                  attrs: {
                    pageId: TARGET_ID,
                    title: 'Other space',
                    targetSpaceKey: 'OPS',
                  },
                },
              ],
            }),
          };
        }
        if (requestSpaceId !== TARGET_SPACE_ID) {
          throw new NotFoundException('not in source space');
        }

        return {
          id: TARGET_ID,
          title: 'Other space',
          content_format: 'tiptap',
          content: JSON.stringify({ type: 'doc', content: [] }),
        };
      },
    );

    await expect(resolve(0)).resolves.toMatchObject({
      kind: 'includePage',
      attrs: {
        targetSpaceId: TARGET_SPACE_ID,
        targetSpaceKey: 'OPS',
      },
      data: {
        pageId: TARGET_ID,
        targetSpaceId: TARGET_SPACE_ID,
        targetSpaceKey: 'OPS',
      },
    });
    expect(getWikiPage).toHaveBeenLastCalledWith(
      undefined,
      TARGET_SPACE_ID,
      TARGET_ID,
    );
  });

  it('selects a named excerpt and reports a nested include cycle without recursing forever', async () => {
    const TARGET_ID = '22222222-2222-4222-8222-222222222222';
    const sourceDoc = {
      type: 'doc',
      content: [
        {
          type: 'excerptInclude',
          attrs: {
            pageId: TARGET_ID,
            title: 'Shared excerpts',
            excerptName: 'second',
            nopanel: true,
          },
        },
      ],
    };
    const targetDoc = {
      type: 'doc',
      content: [
        {
          type: 'excerpt',
          attrs: { name: 'first' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'wrong' }] },
          ],
        },
        {
          type: 'excerpt',
          attrs: { name: 'second', hidden: true },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'chosen' }] },
            {
              type: 'includePage',
              attrs: { pageId: PAGE_ID, title: 'Source page' },
            },
          ],
        },
      ],
    };
    getWikiPage.mockImplementation(
      (_user: unknown, _spaceId: string, pageId: string) => ({
        id: pageId,
        title: pageId === TARGET_ID ? 'Shared excerpts' : 'Source page',
        content_format: 'tiptap',
        content: JSON.stringify(pageId === TARGET_ID ? targetDoc : sourceDoc),
      }),
    );

    await expect(resolve(0)).resolves.toMatchObject({
      kind: 'excerptInclude',
      attrs: { excerptName: 'second', nopanel: true },
      data: {
        content: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'chosen' }] },
            { type: 'includePage' },
          ],
        },
        resolutions: {
          '0': { diagnostic: { code: 'cycle' } },
        },
      },
    });
    expect(getWikiPage).toHaveBeenCalledTimes(2);
  });

  it('leaves an honest diagnostic when a stored include target is inaccessible', async () => {
    const TARGET_ID = '22222222-2222-4222-8222-222222222222';
    getWikiPage
      .mockResolvedValueOnce({
        id: PAGE_ID,
        content_format: 'tiptap',
        content: JSON.stringify({
          type: 'doc',
          content: [
            {
              type: 'includePage',
              attrs: { pageId: TARGET_ID, title: 'Private page' },
            },
          ],
        }),
      })
      .mockRejectedValueOnce(new NotFoundException('Page not found'));

    await expect(resolve(0)).resolves.toMatchObject({
      kind: 'includePage',
      attrs: { pageId: TARGET_ID, title: 'Private page' },
      diagnostic: { code: 'inaccessible' },
    });
  });

  it('stops nested includes after five resolved levels', async () => {
    const ids = [
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '66666666-6666-4666-8666-666666666666',
      '77777777-7777-4777-8777-777777777777',
      '88888888-8888-4888-8888-888888888888',
    ];
    const docs = new Map<string, unknown>();
    docs.set(PAGE_ID, {
      type: 'doc',
      content: [
        {
          type: 'includePage',
          attrs: { pageId: ids[0], title: 'Level 1' },
        },
      ],
    });
    ids.forEach((id, index) => {
      docs.set(id, {
        type: 'doc',
        content:
          index < ids.length - 1
            ? [
                {
                  type: 'includePage',
                  attrs: {
                    pageId: ids[index + 1],
                    title: `Level ${index + 2}`,
                  },
                },
              ]
            : [{ type: 'paragraph' }],
      });
    });
    getWikiPage.mockImplementation(
      (_user: unknown, _spaceId: string, pageId: string) => ({
        id: pageId,
        title: `Page ${pageId}`,
        content_format: 'tiptap',
        content: JSON.stringify(docs.get(pageId)),
      }),
    );

    let nested = (await resolve(0)) as Record<string, unknown>;
    for (let level = 1; level < 6; level += 1) {
      const data = nested.data as Record<string, unknown>;
      const resolutions = data.resolutions as Record<string, unknown>;

      nested = resolutions['0'] as Record<string, unknown>;
    }

    expect(nested).toMatchObject({
      diagnostic: { code: 'max_depth' },
    });
    expect(getWikiPage).toHaveBeenCalledTimes(6);
  });

  it('resolves stored public label reports without accepting caller filters', async () => {
    getWikiPage.mockResolvedValue({
      id: PAGE_ID,
      content_format: 'tiptap',
      content: JSON.stringify({
        type: 'doc',
        content: [
          { type: 'contentByLabel', attrs: { labels: ['release'] } },
          { type: 'popularLabels', attrs: { count: 10 } },
        ],
      }),
    });
    getPages.mockResolvedValue({
      data: [
        {
          id: PAGE_ID,
          title: 'Release notes',
          slug: 'release-notes',
          updated_at: '2026-08-24T00:00:00Z',
          is_published: true,
          is_archived: false,
        },
      ],
    });
    from.mockImplementation((table: string) =>
      fakeChain(
        table === 'spaces'
          ? {
              id: SPACE_ID,
              key: 'DOCS',
              organization_id: ORG_ID,
              is_active: true,
              is_archived: false,
            }
          : table === 'wiki_page_labels'
            ? [
                {
                  page_id: PAGE_ID,
                  assigned_at: '2026-08-24T00:00:00Z',
                  label: { name: 'release', color: '#0052cc' },
                },
              ]
            : [],
      ),
    );

    await expect(resolve(0)).resolves.toMatchObject({
      kind: 'contentByLabel',
      ordinal: 0,
      data: [{ id: PAGE_ID, labels: ['release'] }],
    });
    await expect(resolve(1)).resolves.toMatchObject({
      kind: 'popularLabels',
      ordinal: 1,
      data: [{ name: 'release', count: 1, color: '#0052cc' }],
    });
  });

  it('extracts public content properties only from matching published pages', async () => {
    getWikiPage.mockResolvedValue({
      id: PAGE_ID,
      content_format: 'tiptap',
      content: JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'contentPropertiesReport',
            attrs: {
              label: 'release',
              propertyId: 'delivery',
              columns: ['Status'],
              titleColumn: 'Document',
            },
          },
        ],
      }),
    });
    getPages.mockResolvedValue({
      data: [
        {
          id: PAGE_ID,
          title: 'Release notes',
          slug: 'release-notes',
          is_published: true,
          is_archived: false,
          content_format: 'tiptap',
          content: JSON.stringify({
            type: 'doc',
            content: [
              {
                type: 'contentProperties',
                attrs: {
                  propertyId: 'delivery',
                  rows: [{ key: 'Status', value: 'Ready' }],
                },
              },
              {
                type: 'contentProperties',
                attrs: {
                  propertyId: 'delivery',
                  hidden: true,
                  rows: [{ key: 'Status', value: 'Internal hold' }],
                },
              },
            ],
          }),
        },
      ],
    });
    from.mockImplementation((table: string) =>
      fakeChain(
        table === 'spaces'
          ? {
              id: SPACE_ID,
              key: 'DOCS',
              organization_id: ORG_ID,
              is_active: true,
              is_archived: false,
            }
          : table === 'wiki_page_labels'
            ? [
                {
                  page_id: PAGE_ID,
                  assigned_at: null,
                  label: { name: 'release', color: null },
                },
              ]
            : [],
      ),
    );

    await expect(resolve(0)).resolves.toMatchObject({
      kind: 'contentPropertiesReport',
      attrs: { columns: ['Status'], titleColumn: 'Document' },
      data: [
        {
          id: PAGE_ID,
          title: 'Release notes',
          properties: { Status: 'Ready' },
        },
      ],
    });
  });

  it('redacts public change-history identities, comments, and private version payloads', async () => {
    getWikiPage.mockResolvedValue({
      id: PAGE_ID,
      content_format: 'tiptap',
      content: JSON.stringify({
        type: 'doc',
        content: [{ type: 'changeHistory', attrs: { limit: 5 } }],
      }),
    });
    from.mockImplementation((table: string) =>
      fakeChain(
        table === 'wiki_page_versions'
          ? [
              {
                version: 3,
                created_at: '2026-08-24T00:00:00Z',
                changes: { comment: 'Clarified rollout' },
                content: 'must not be returned',
                changed_by: 'private-user-id',
              },
            ]
          : table === 'spaces'
            ? {
                id: SPACE_ID,
                organization_id: ORG_ID,
                is_active: true,
                is_archived: false,
              }
            : [],
      ),
    );

    const result = (await resolve(0)) as Record<string, unknown>;

    expect(result).toMatchObject({
      kind: 'changeHistory',
      data: [
        {
          version: 3,
          author: null,
          createdAt: '2026-08-24T00:00:00Z',
          comment: null,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('Clarified rollout');
    expect(JSON.stringify(result)).not.toContain('must not be returned');
    expect(JSON.stringify(result)).not.toContain('private-user-id');
  });

  it('returns only public-safe stored space metadata', async () => {
    getWikiPage.mockResolvedValue({
      id: PAGE_ID,
      content_format: 'tiptap',
      content: JSON.stringify({
        type: 'doc',
        content: [{ type: 'spaceDetails', attrs: { width: '320px' } }],
      }),
    });
    from.mockImplementation((table: string) =>
      fakeChain(
        table === 'spaces'
          ? {
              id: SPACE_ID,
              key: 'DOCS',
              name: 'Documentation',
              description: 'Published product documentation',
              icon_url: '/icons/docs.svg',
              organization_id: ORG_ID,
              is_active: true,
              is_archived: false,
              administrators: ['must not leak'],
            }
          : [],
      ),
    );

    const result = (await resolve(0)) as Record<string, unknown>;

    expect(result).toMatchObject({
      kind: 'spaceDetails',
      data: {
        id: SPACE_ID,
        key: 'DOCS',
        name: 'Documentation',
        description: 'Published product documentation',
        icon: '/icons/docs.svg',
      },
    });
    expect(JSON.stringify(result)).not.toContain('must not leak');
  });
});

describe('PublicSiteStudioService.listWikiPages search', () => {
  let getPages: jest.Mock;
  let from: jest.Mock;
  let service: PublicSiteStudioService;

  beforeEach(() => {
    getPages = jest.fn().mockResolvedValue({ data: [], count: 0 });
    from = jest.fn((table: string) =>
      fakeChain(
        table === 'spaces'
          ? {
              id: SPACE_ID,
              organization_id: ORG_ID,
              is_active: true,
              is_archived: false,
            }
          : [],
      ),
    );
    service = new PublicSiteStudioService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {} as never,
      {} as never,
      { getPages } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  it('forwards search to the wiki list query', async () => {
    await service.listWikiPages(
      undefined,
      SPACE_ID,
      '50',
      undefined,
      undefined,
      undefined,
      'restart',
    );

    expect(getPages).toHaveBeenCalledWith(
      SPACE_ID,
      expect.objectContaining({
        search: 'restart',
        is_published: true,
        is_archived: false,
      }),
    );
  });

  it('omits search when it is blank so the unfiltered list is unchanged', async () => {
    await service.listWikiPages(undefined, SPACE_ID, '50');

    const filters = getPages.mock.calls[0][1] as Record<string, unknown>;

    expect(filters.search).toBeUndefined();
  });
});
