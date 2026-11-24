import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';

import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { OrganizationModulesService } from '../organization-modules/organization-modules.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { WikiPermissionsService } from '../wiki/wiki-permissions.service';
import {
  WhiteboardsService,
  assertImageContent,
  buildRestoredScene,
  pickAppState,
  sanitizeElements,
} from './whiteboards.service';
import {
  WHITEBOARD_MAX_SCENE_BYTES,
  WHITEBOARD_TOMBSTONE_TTL_MS,
} from './whiteboards.constants';

const SPACE = '11111111-1111-4111-8111-111111111111';
const WB = '22222222-2222-4222-8222-222222222222';
const user = { userId: 'u-1', organizationId: 'org-1' } as RequestUser;
const el = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'rectangle',
  version: 1,
  ...extra,
});

const byIdOf = (els: Record<string, unknown>[]) =>
  Object.fromEntries(els.map((e) => [e.id as string, e])) as Record<
    string,
    Record<string, unknown>
  >;

// Chainable Supabase query-builder mock (same shape as form-builder.service.spec.ts).
function buildChain(resolved: { data: unknown; error: unknown }) {
  const chain: Record<
    string,
    jest.Mock | ((f: (v: unknown) => unknown) => unknown)
  > = {};
  const self = () => chain;

  for (const m of [
    'select',
    'eq',
    'order',
    'limit',
    'insert',
    'update',
    'delete',
    'upsert',
  ]) {
    chain[m] = jest.fn().mockImplementation(self);
  }
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled);

  return chain as Record<string, jest.Mock>;
}

describe('WhiteboardsService', () => {
  let service: WhiteboardsService;
  let queues: Record<string, Record<string, jest.Mock>[]>;
  let orgModules: { isEnabled: jest.Mock; isSpaceModuleEnabled: jest.Mock };
  let audit: { logActionForRequest: jest.Mock };
  let rpc: jest.Mock;
  let wikiPermissions: { resolveBoardAccess: jest.Mock };
  let storage: {
    upload: jest.Mock;
    download: jest.Mock;
    list: jest.Mock;
    remove: jest.Mock;
  };

  const chain = (table: string, data: unknown, error: unknown = null) => {
    const c = buildChain({ data, error });

    (queues[table] ??= []).push(c);

    return c;
  };

  beforeEach(() => {
    queues = {};
    orgModules = {
      isEnabled: jest.fn().mockResolvedValue(true),
      isSpaceModuleEnabled: jest.fn().mockResolvedValue(true),
    };
    audit = { logActionForRequest: jest.fn().mockResolvedValue(undefined) };
    rpc = jest.fn();
    // Default: no board is restricted by a Share setting
    wikiPermissions = {
      resolveBoardAccess: jest.fn().mockResolvedValue(new Map()),
    };
    storage = {
      upload: jest.fn().mockResolvedValue({ data: {}, error: null }),
      download: jest.fn(),
      list: jest.fn().mockResolvedValue({ data: [], error: null }),
      remove: jest.fn().mockResolvedValue({ data: [], error: null }),
    };

    const supabase = {
      getClient: () => ({
        from: (table: string) => {
          const next = queues[table]?.shift();

          // getOne's link-row lookup: an unlinked board unless a test queues one
          if (!next && table === 'wiki_pages') {
            return buildChain({ data: null, error: null });
          }
          if (!next) throw new Error(`unexpected query on ${table}`);

          return next;
        },
        storage: { from: () => storage },
        rpc: (...args: unknown[]) => rpc(...args) as unknown,
      }),
    } as unknown as SupabaseAdminService;

    service = new WhiteboardsService(
      supabase,
      orgModules as unknown as OrganizationModulesService,
      audit as unknown as AuditLogsService,
      wikiPermissions as unknown as WikiPermissionsService,
    );
  });

  describe('availability gate', () => {
    it('refuses when the tenant module is off, before touching the table', async () => {
      orgModules.isEnabled.mockResolvedValue(false);

      await expect(service.list(SPACE, 'org-1', 'u-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(orgModules.isEnabled).toHaveBeenCalledWith('org-1', 'whiteboards');
    });

    it('refuses when the space module is off (also the foreign-space case)', async () => {
      orgModules.isSpaceModuleEnabled.mockResolvedValue(false);

      await expect(service.getOne(SPACE, 'org-1', WB)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(orgModules.isSpaceModuleEnabled).toHaveBeenCalledWith(
        'org-1',
        SPACE,
        'whiteboards',
      );
    });
  });

  describe('tenant scoping', () => {
    it('lists only the caller org and space', async () => {
      const c = chain('whiteboards', [{ id: WB }]);

      await expect(service.list(SPACE, 'org-1', 'u-1')).resolves.toEqual([
        { id: WB },
      ]);
      expect(c.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(c.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    });

    it('creates in the caller org and audits it', async () => {
      const c = chain('whiteboards', { id: WB, name: 'Retro' });

      await service.create(SPACE, user, 'Retro');
      expect(c.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: 'org-1',
          space_id: SPACE,
          name: 'Retro',
          created_by: 'u-1',
        }),
      );
      expect(audit.logActionForRequest).toHaveBeenCalledWith(
        user,
        'whiteboard',
        WB,
        'create',
        { name: 'Retro', space_id: SPACE },
      );
    });

    it('404s a whiteboard outside the space/org', async () => {
      chain('whiteboards', null);

      await expect(service.getOne(SPACE, 'org-1', WB)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the scene with its image ids', async () => {
      chain('whiteboards', { id: WB, elements: [], app_state: {} });
      chain('whiteboard_files', [{ file_id: 'abc', mime_type: 'image/png' }]);

      await expect(service.getOne(SPACE, 'org-1', WB)).resolves.toMatchObject({
        id: WB,
        files: [{ file_id: 'abc', mime_type: 'image/png' }],
        updated_by_user: null,
        wiki_page_id: null,
      });
    });

    it('returns the last editor and the wiki link row, scoped to the space/org', async () => {
      chain('whiteboards', {
        id: WB,
        elements: [],
        app_state: {},
        updated_by_user: { id: 'u-2', first_name: 'Kim', last_name: 'Chen' },
      });
      chain('whiteboard_files', []);
      const link = chain('wiki_pages', { id: 'page-1' });

      await expect(service.getOne(SPACE, 'org-1', WB)).resolves.toMatchObject({
        updated_by_user: { id: 'u-2', full_name: 'Kim Chen' },
        wiki_page_id: 'page-1',
      });
      expect(link.eq).toHaveBeenCalledWith('whiteboard_id', WB);
      expect(link.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(link.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    });
  });

  describe('share setting (board ACL via the wiki link row)', () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    const restrictedTo = (access: Record<string, boolean>) =>
      new Map([
        [
          WB,
          { can_view: false, can_edit: false, can_delete: false, ...access },
        ],
      ]);

    it('hides boards shared away from the caller, keeps the rest', async () => {
      chain('whiteboards', [{ id: WB }, { id: OTHER }]);
      wikiPermissions.resolveBoardAccess.mockResolvedValue(restrictedTo({}));

      await expect(service.list(SPACE, 'org-1', 'u-1')).resolves.toEqual([
        { id: OTHER },
      ]);
      expect(wikiPermissions.resolveBoardAccess).toHaveBeenCalledWith(
        'u-1',
        SPACE,
        [WB, OTHER],
      );
    });

    it('lists a restricted board the caller was invited to', async () => {
      chain('whiteboards', [{ id: WB }]);
      wikiPermissions.resolveBoardAccess.mockResolvedValue(
        restrictedTo({ can_view: true }),
      );

      await expect(service.list(SPACE, 'org-1', 'u-1')).resolves.toEqual([
        { id: WB },
      ]);
    });

    it('passes an unrestricted board at every level (unchanged behaviour)', async () => {
      for (const level of ['can_view', 'can_edit', 'can_delete'] as const) {
        await expect(
          service.assertBoardAccess(SPACE, 'u-1', WB, level),
        ).resolves.toBeUndefined();
      }
    });

    it('lets a view-only invitee read but not edit or delete', async () => {
      wikiPermissions.resolveBoardAccess.mockResolvedValue(
        restrictedTo({ can_view: true }),
      );

      await expect(
        service.assertBoardAccess(SPACE, 'u-1', WB, 'can_view'),
      ).resolves.toBeTruthy();
      await expect(
        service.assertBoardAccess(SPACE, 'u-1', WB, 'can_edit'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.assertBoardAccess(SPACE, 'u-1', WB, 'can_delete'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets an edit invitee edit but not delete', async () => {
      wikiPermissions.resolveBoardAccess.mockResolvedValue(
        restrictedTo({ can_view: true, can_edit: true }),
      );

      await expect(
        service.assertBoardAccess(SPACE, 'u-1', WB, 'can_edit'),
      ).resolves.toBeTruthy();
      await expect(
        service.assertBoardAccess(SPACE, 'u-1', WB, 'can_delete'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('reports an unshared, unlinked board as open and editable', async () => {
      chain('whiteboards', { id: WB });

      await expect(
        service.getShareState(SPACE, 'org-1', 'u-1', WB),
      ).resolves.toEqual({
        wiki_page_id: null,
        restricted: false,
        can_edit: true,
        can_delete: true,
      });
    });

    it('reports a restricted board and the caller caps, rules read on the row and its folders', async () => {
      chain('whiteboards', { id: WB });
      chain('wiki_pages', { id: 'page-1', path: ['folder-1', 'page-1'] });
      const rules = chain('wiki_page_permissions', [
        { wiki_page_id: 'page-1' },
      ]);
      rules.in = jest.fn().mockReturnValue(rules);
      wikiPermissions.resolveBoardAccess.mockResolvedValue(
        restrictedTo({ can_view: true }),
      );

      await expect(
        service.getShareState(SPACE, 'org-1', 'u-1', WB),
      ).resolves.toEqual({
        wiki_page_id: 'page-1',
        restricted: true,
        can_edit: false,
        can_delete: false,
      });
      expect(rules.in).toHaveBeenCalledWith('wiki_page_id', [
        'page-1',
        'folder-1',
        'page-1',
      ]);
    });

    it('404s share state for a board outside the space/org', async () => {
      chain('whiteboards', null);

      await expect(
        service.getShareState(SPACE, 'org-1', 'u-1', WB),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403s share state when the board is shared away from the caller', async () => {
      chain('whiteboards', { id: WB });
      wikiPermissions.resolveBoardAccess.mockResolvedValue(restrictedTo({}));

      await expect(
        service.getShareState(SPACE, 'org-1', 'u-1', WB),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses everything to a user left out of a restricted board', async () => {
      wikiPermissions.resolveBoardAccess.mockResolvedValue(restrictedTo({}));

      await expect(
        service.assertBoardAccess(SPACE, 'u-1', WB, 'can_view'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('saveScene', () => {
    const dto = (over: Record<string, unknown> = {}) => ({
      elements: [el('a')],
      app_state: { viewBackgroundColor: '#fff', zoom: { value: 2 } },
      base_revision: 4,
      ...over,
    });

    it('compare-and-sets on the base revision and bumps it', async () => {
      const c = chain('whiteboards', { revision: 5, updated_at: 't' });

      await expect(service.saveScene(SPACE, user, WB, dto())).resolves.toEqual({
        revision: 5,
        updated_at: 't',
      });
      expect(c.update).toHaveBeenCalledWith({
        elements: [el('a')],
        app_state: { viewBackgroundColor: '#fff' },
        revision: 5,
        updated_by: 'u-1',
      });
      expect(c.eq).toHaveBeenCalledWith('revision', 4);
      expect(c.eq).toHaveBeenCalledWith('is_archived', false);
      expect(c.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    });

    it('409s a stale revision with a machine-readable code', async () => {
      chain('whiteboards', null);
      chain('whiteboards', { is_archived: false });

      const saving = service.saveScene(SPACE, user, WB, dto());

      await expect(saving).rejects.toBeInstanceOf(ConflictException);
      await expect(saving).rejects.toHaveProperty(
        'response.code',
        'WHITEBOARD_REVISION_CONFLICT',
      );
    });

    it('409s an archived whiteboard as archived, not stale', async () => {
      chain('whiteboards', null);
      chain('whiteboards', { is_archived: true });

      await expect(
        service.saveScene(SPACE, user, WB, dto()),
      ).rejects.toHaveProperty('response.code', 'WHITEBOARD_ARCHIVED');
    });

    it('500s (retryable), not 404s, when the miss check itself fails', async () => {
      chain('whiteboards', null);
      chain('whiteboards', null, { message: 'connection reset' });

      await expect(
        service.saveScene(SPACE, user, WB, dto()),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('404s a whiteboard deleted meanwhile', async () => {
      chain('whiteboards', null);
      chain('whiteboards', null);

      await expect(
        service.saveScene(SPACE, user, WB, dto()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('413s an oversized scene without writing', async () => {
      const big = 'x'.repeat(WHITEBOARD_MAX_SCENE_BYTES);

      await expect(
        service.saveScene(
          SPACE,
          user,
          WB,
          dto({ elements: [el('a', { text: big })] }),
        ),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(queues.whiteboards).toBeUndefined();
    });

    it('400s a malformed element', async () => {
      await expect(
        service.saveScene(SPACE, user, WB, dto({ elements: [{ id: 'a' }] })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('scene sanitising', () => {
    it('drops only tombstones older than the TTL', () => {
      const now = 10 * WHITEBOARD_TOMBSTONE_TTL_MS;
      const kept = sanitizeElements(
        [
          el('live'),
          el('fresh-tombstone', { isDeleted: true, updated: now - 1000 }),
          el('old-tombstone', {
            isDeleted: true,
            updated: now - WHITEBOARD_TOMBSTONE_TTL_MS - 1,
          }),
        ],
        now,
      );

      expect(kept.map((e) => e.id)).toEqual(['live', 'fresh-tombstone']);
    });

    it('nulls scriptable element links and keeps the rest untouched', () => {
      const links = [
        'javascript:alert(1)',
        '  JavaScript:alert(1)',
        'java\tscript:alert(1)',
        '\u0001javascript:alert(1)',
        'vbscript:msgbox(1)',
        'data:text/html,<script>alert(1)</script>',
      ];
      const safe = [
        'https://example.com',
        'http://example.com',
        'mailto:a@b.c',
        '/relative/path',
        '?element=abc',
        'https://example.com/?q=javascript:x',
      ];
      const kept = sanitizeElements(
        [...links, ...safe].map((link, i) =>
          el(`e${i}`, { link, strokeColor: '#000' }),
        ),
        Date.now(),
      );

      expect(kept.slice(0, links.length).map((e) => e.link)).toEqual(
        links.map(() => null),
      );
      expect(kept.slice(links.length).map((e) => e.link)).toEqual(safe);
      expect(kept.every((e) => e.strokeColor === '#000')).toBe(true);
    });

    it('leaves elements without a string link as the same object', () => {
      const input = [el('a'), el('b', { link: null })];

      expect(sanitizeElements(input, Date.now())).toEqual(input);
      expect(sanitizeElements(input, Date.now())[0]).toBe(input[0]);
    });

    it('keeps only whitelisted app_state keys of the right type', () => {
      expect(
        pickAppState({
          gridSize: 20,
          gridStep: 'five',
          gridModeEnabled: true,
          viewBackgroundColor: '#ffffff',
          collaborators: {},
          scrollX: 100,
        }),
      ).toEqual({
        gridSize: 20,
        gridModeEnabled: true,
        viewBackgroundColor: '#ffffff',
      });
    });
  });

  describe('files', () => {
    const PNG_BYTES = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const png = { buffer: PNG_BYTES, mimetype: 'image/png', size: 9 };

    it('rejects a path-unsafe file id before any query', async () => {
      await expect(
        service.uploadFile(SPACE, user, WB, '../x', png),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-image type', async () => {
      await expect(
        service.uploadFile(SPACE, user, WB, 'abc', {
          ...png,
          mimetype: 'text/html',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses uploads to an archived whiteboard', async () => {
      chain('whiteboards', { is_archived: true });

      await expect(
        service.uploadFile(SPACE, user, WB, 'abc', png),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('skips an image that is already stored (content-addressed)', async () => {
      chain('whiteboards', { is_archived: false });
      const lookup = chain('whiteboard_files', { file_id: 'abc' });

      await expect(
        service.uploadFile(SPACE, user, WB, 'abc', png),
      ).resolves.toEqual({ file_id: 'abc' });
      expect(storage.upload).not.toHaveBeenCalled();
      expect(lookup.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(lookup.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    });

    it('rejects content that does not match the declared type, before any query', async () => {
      await expect(
        service.uploadFile(SPACE, user, WB, 'abc', {
          ...png,
          mimetype: 'image/jpeg',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('stores a new image under space/whiteboard/fileId and records it', async () => {
      chain('whiteboards', { is_archived: false });
      chain('whiteboard_files', null);
      const record = chain('whiteboard_files', null);

      await service.uploadFile(SPACE, user, WB, 'abc', png);
      expect(storage.upload).toHaveBeenCalledWith(
        `${SPACE}/${WB}/abc`,
        png.buffer,
        {
          contentType: 'image/png',
          upsert: true,
        },
      );
      expect(record.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: 'org-1',
          storage_path: `${SPACE}/${WB}/abc`,
          size_bytes: 9,
        }),
        { onConflict: 'whiteboard_id,file_id', ignoreDuplicates: true },
      );
    });

    it('serves a stored image with its recorded type', async () => {
      chain('whiteboard_files', { storage_path: 'p', mime_type: 'image/png' });
      storage.download.mockResolvedValue({
        data: new Blob([Buffer.from('png')]),
        error: null,
      });

      const file = await service.getFile(SPACE, 'org-1', WB, 'abc');

      expect(file.mimeType).toBe('image/png');
      expect(file.buffer.toString()).toBe('png');
    });

    it('404s an image of another whiteboard/org', async () => {
      const c = chain('whiteboard_files', null);

      await expect(
        service.getFile(SPACE, 'org-1', WB, 'abc'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(c.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    });
  });

  describe('assertImageContent', () => {
    const bytes = (...b: number[]) => Buffer.from(b);
    const withAscii = (head: Buffer | string, tail = '') =>
      Buffer.concat([Buffer.from(head as string, 'latin1'), Buffer.from(tail)]);
    const svg = (body: string) =>
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`);

    it.each([
      ['image/png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)],
      ['image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0)],
      ['image/gif', withAscii('GIF87a', 'x')],
      ['image/gif', withAscii('GIF89a', 'x')],
      ['image/webp', withAscii('RIFF\x00\x00\x00\x00WEBPVP8 ')],
      ['image/bmp', withAscii('BM', '....')],
      ['image/x-icon', bytes(0, 0, 1, 0, 1, 0)],
      ['image/avif', withAscii('\x00\x00\x00\x1cftypavif')],
      ['image/avif', withAscii('\x00\x00\x00\x1cftypavis')],
      ['image/svg+xml', svg('<rect width="1" height="1"/>')],
    ])('accepts %s with matching content', (mime, buf) => {
      expect(() => assertImageContent(buf, mime)).not.toThrow();
    });

    it.each([
      ['image/png', bytes(0xff, 0xd8, 0xff, 0xe0)],
      ['image/jpeg', withAscii('GIF89a')],
      ['image/webp', withAscii('RIFF\x00\x00\x00\x00WAVE')],
      ['image/avif', withAscii('\x00\x00\x00\x1cftypheic')],
      ['image/png', Buffer.from('<svg></svg>')],
      ['image/svg+xml', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
      ['image/svg+xml', Buffer.from('<html><svg></svg></html>')],
      ['image/gif', Buffer.alloc(0)],
    ])('rejects %s whose content does not match', (mime, buf) => {
      expect(() => assertImageContent(buf, mime)).toThrow(BadRequestException);
    });

    it('accepts an svg behind a BOM, xml declaration, comment and DOCTYPE', () => {
      const text =
        '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by x -->\n' +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
        '<svg version="1.1"><path d="M0 0"/></svg>';

      expect(() =>
        assertImageContent(Buffer.from(text), 'image/svg+xml'),
      ).not.toThrow();
    });

    it('accepts an Excalidraw-style export with an embedded data: font and image', () => {
      const text = `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <!-- svg-source:excalidraw -->
  <metadata></metadata>
  <defs>
    <style class="style-fonts">
      @font-face { font-family: Excalifont; src: url(data:font/woff2;base64,d09GMgABAAAAAAoonABCDEF/onload+xyz==); }
      @font-face { font-family: Nunito; src: url("data:font/woff2;base64,AAAA"); }
    </style>
    <clipPath id="c"><rect width="10" height="10"/></clipPath>
  </defs>
  <rect x="0" y="0" width="100" height="100" fill="#ffffff"></rect>
  <g clip-path="url(#c)" stroke-linecap="round"><path d="M10 10 L 20 20" stroke="#1e1e1e"/></g>
  <use href="#c"/>
  <image href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"/>
  <text font-family="Excalifont, Xiaolai, sans-serif" font-size="20px" fill="#1e1e1e">Hello on stage</text>
</svg>`;

      expect(() =>
        assertImageContent(Buffer.from(text), 'image/svg+xml'),
      ).not.toThrow();
    });

    it.each([
      ['script', '<script>alert(1)</script>'],
      ['SCRIPT upper-case', '<SCRIPT>alert(1)</SCRIPT>'],
      ['onload', '<rect onload="alert(1)"/>'],
      ['onclick spaced', '<rect width="1" ONCLICK = "x()"/>'],
      ['foreignObject', '<foreignObject><div/></foreignObject>'],
      ['javascript: href', '<a href="javascript:alert(1)"><rect/></a>'],
      ['relative href', '<image href="../secret.png"/>'],
      ['data:text href', '<a href="data:text/html,hi"><rect/></a>'],
      ['url(file:)', '<rect style="fill:url(file:///etc/passwd)"/>'],
      ['@import', '<style>@import "https://evil.example/x.css";</style>'],
    ])('rejects an svg with %s', (_label, body) => {
      expect(() => assertImageContent(svg(body), 'image/svg+xml')).toThrow(
        BadRequestException,
      );
    });

    // Shown only as images (<img>/canvas): browsers neither run nor fetch these there, and Excalidraw's
    // own SVG export wraps linked shapes in <a href="https://…">.
    it.each([
      ['a link to https', '<a href="https://example.com"><rect/></a>'],
      ['an http image href', '<image href="http://example.com/x.png"/>'],
      [
        'an https xlink:href',
        "<use xlink:href='https://example.com/s.svg#a'/>",
      ],
      ['url(https)', '<rect style="fill:url(https://example.com/p)"/>'],
      ['text that reads like an attribute', '<text>one = 1, only = 2</text>'],
    ])('accepts an svg with %s', (_label, body) => {
      expect(() =>
        assertImageContent(svg(body), 'image/svg+xml'),
      ).not.toThrow();
    });

    it('rejects an svg whose DOCTYPE declares entities', () => {
      const text =
        '<!DOCTYPE svg [<!ENTITY x "&#60;script&#62;">]><svg>&x;</svg>';

      expect(() =>
        assertImageContent(Buffer.from(text), 'image/svg+xml'),
      ).toThrow(BadRequestException);
    });
  });

  describe('remove', () => {
    it('deletes the row, then its recorded and prefixed objects', async () => {
      chain('whiteboard_files', [{ storage_path: 'old-space/old-wb/abc' }]);
      chain('whiteboards', { id: WB, name: 'Retro' });
      storage.list.mockResolvedValueOnce({
        data: [{ name: 'orphan' }],
        error: null,
      });

      await expect(service.remove(SPACE, user, WB)).resolves.toEqual({
        success: true,
      });
      expect(storage.remove).toHaveBeenCalledWith(['old-space/old-wb/abc']);
      expect(storage.remove).toHaveBeenCalledWith([`${SPACE}/${WB}/orphan`]);
      expect(audit.logActionForRequest).toHaveBeenCalledWith(
        user,
        'whiteboard',
        WB,
        'delete',
        { name: 'Retro' },
      );
    });

    it('still succeeds when storage cleanup fails (row is already gone)', async () => {
      chain('whiteboard_files', []);
      chain('whiteboards', { id: WB, name: 'Retro' });
      storage.list.mockResolvedValueOnce({
        data: null,
        error: new Error('down'),
      });

      await expect(service.remove(SPACE, user, WB)).resolves.toEqual({
        success: true,
      });
    });

    it('404s a whiteboard outside the space/org', async () => {
      chain('whiteboard_files', []);
      chain('whiteboards', null);

      await expect(service.remove(SPACE, user, WB)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(storage.remove).not.toHaveBeenCalled();
    });

    it('removeFromWiki works with the module off, still scoped to the caller org/space', async () => {
      orgModules.isEnabled.mockResolvedValue(false);
      chain('whiteboard_files', []);
      const board = chain('whiteboards', { id: WB, name: 'Retro' });

      await expect(service.removeFromWiki(SPACE, user, WB)).resolves.toEqual({
        success: true,
      });
      expect(board.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(board.eq).toHaveBeenCalledWith('organization_id', 'org-1');
      await expect(service.remove(SPACE, user, WB)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('version history', () => {
    const author = {
      id: 'u-1',
      first_name: 'Jörg',
      last_name: 'Müller',
      email: 'j@example.com',
      avatar_url: null,
    };

    it('lists versions newest first, scoped, with the author name', async () => {
      const versions = chain('whiteboard_versions', [
        { id: 'v2', version: 2, changed_by_user: author },
        { id: 'v1', version: 1, changed_by_user: null },
      ]);

      const list = await service.listVersions(SPACE, 'org-1', WB);

      expect(versions.eq).toHaveBeenCalledWith('whiteboard_id', WB);
      expect(versions.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(versions.eq).toHaveBeenCalledWith('organization_id', 'org-1');
      expect(versions.order).toHaveBeenCalledWith('version', {
        ascending: false,
      });
      // The list never carries scenes.
      expect((versions.select.mock.calls[0] as string[])[0]).not.toMatch(
        /elements/,
      );
      expect(list[0].changed_by_user).toMatchObject({
        full_name: 'Jörg Müller',
      });
      expect(list[1].changed_by_user).toBeNull();
    });

    it('404s a board outside the space/org (no versions visible)', async () => {
      chain('whiteboard_versions', []);

      await expect(
        service.listVersions(SPACE, 'org-1', WB),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns one version with only the images it uses', async () => {
      chain('whiteboard_versions', {
        id: 'v3',
        version: 3,
        elements: [el('a', { type: 'image', fileId: 'f1' }), el('b')],
        app_state: {},
        changed_by_user: author,
      });
      chain('whiteboard_files', [
        { file_id: 'f1', mime_type: 'image/png' },
        { file_id: 'f2', mime_type: 'image/png' },
      ]);

      const v = await service.getVersion(SPACE, 'org-1', WB, 3);

      expect(v.files).toEqual([{ file_id: 'f1', mime_type: 'image/png' }]);
    });

    it('404s an unknown version', async () => {
      chain('whiteboard_versions', null);

      await expect(
        service.getVersion(SPACE, 'org-1', WB, 9),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('restoreVersion', () => {
      const snapshot = {
        name: 'Old name',
        elements: [el('a', { version: 2 })],
        app_state: { viewBackgroundColor: '#fff', junk: 1 },
      };

      it('writes the bumped snapshot through the flagged CAS and returns the board', async () => {
        chain('whiteboard_versions', snapshot);
        chain('whiteboards', {
          elements: [el('a', { version: 7 }), el('b', { version: 3 })],
          revision: 40,
          is_archived: false,
        });
        rpc.mockResolvedValue({ data: [{ id: WB }], error: null });
        chain('whiteboards', {
          id: WB,
          revision: 41,
          elements: [],
          app_state: {},
        });
        chain('whiteboard_files', []);

        const board = await service.restoreVersion(SPACE, user, WB, 2);

        const [fn, args] = rpc.mock.calls[0] as [
          string,
          Record<string, unknown>,
        ];
        expect(fn).toBe('restore_whiteboard_scene');
        expect(args).toMatchObject({
          p_whiteboard_id: WB,
          p_space_id: SPACE,
          p_organization_id: 'org-1',
          p_base_revision: 40,
          p_name: 'Old name',
          p_user_id: 'u-1',
          p_restored_from: 2,
          p_app_state: { viewBackgroundColor: '#fff' },
        });
        const byId = byIdOf(args.p_elements as Record<string, unknown>[]);
        expect(byId.a).toMatchObject({ version: 8 });
        expect(byId.b).toMatchObject({ version: 4, isDeleted: true });
        expect(board.revision).toBe(41);
        expect(audit.logActionForRequest).toHaveBeenCalledWith(
          user,
          'whiteboard',
          WB,
          'restore',
          { restored_version: 2 },
        );
      });

      it('re-reads and retries when an autosave moved the revision', async () => {
        chain('whiteboard_versions', snapshot);
        chain('whiteboards', {
          elements: [],
          revision: 40,
          is_archived: false,
        });
        chain('whiteboards', {
          elements: [],
          revision: 41,
          is_archived: false,
        });
        rpc
          .mockResolvedValueOnce({ data: [], error: null })
          .mockResolvedValueOnce({ data: [{ id: WB }], error: null });
        chain('whiteboards', {
          id: WB,
          revision: 42,
          elements: [],
          app_state: {},
        });
        chain('whiteboard_files', []);

        await service.restoreVersion(SPACE, user, WB, 2);

        expect(rpc).toHaveBeenCalledTimes(2);
        expect(
          (rpc.mock.calls[1] as [string, Record<string, unknown>])[1]
            .p_base_revision,
        ).toBe(41);
      });

      it('gives up with a revision conflict after repeated races', async () => {
        chain('whiteboard_versions', snapshot);
        for (let i = 0; i < 3; i++) {
          chain('whiteboards', {
            elements: [],
            revision: 40 + i,
            is_archived: false,
          });
        }
        rpc.mockResolvedValue({ data: [], error: null });
        chain('whiteboards', { is_archived: false });

        await expect(
          service.restoreVersion(SPACE, user, WB, 2),
        ).rejects.toMatchObject({
          response: { code: 'WHITEBOARD_REVISION_CONFLICT' },
        });
        expect(rpc).toHaveBeenCalledTimes(3);
      });

      it('refuses an archived board without writing', async () => {
        chain('whiteboard_versions', snapshot);
        chain('whiteboards', { elements: [], revision: 40, is_archived: true });

        await expect(
          service.restoreVersion(SPACE, user, WB, 2),
        ).rejects.toMatchObject({ response: { code: 'WHITEBOARD_ARCHIVED' } });
        expect(rpc).not.toHaveBeenCalled();
      });

      it('404s an unknown version without writing', async () => {
        chain('whiteboard_versions', null);

        await expect(
          service.restoreVersion(SPACE, user, WB, 9),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(rpc).not.toHaveBeenCalled();
      });
    });
  });
});

describe('buildRestoredScene', () => {
  const nonce = () => 7;

  it('outranks the current scene for every element it touches', () => {
    const current = [
      el('kept', { version: 9 }),
      el('newer', { version: 4 }),
      el('gone', { version: 2, isDeleted: true }),
    ];
    const snapshot = [
      el('kept', { version: 3 }),
      el('old', { version: 5 }),
      el('wasDeleted', { version: 6, isDeleted: true }),
    ];

    const byId = byIdOf(buildRestoredScene(current, snapshot, 1000, nonce));

    // Snapshot elements: above both sides, fresh nonce/updated.
    expect(byId.kept).toMatchObject({
      version: 10,
      versionNonce: 7,
      updated: 1000,
    });
    expect(byId.old).toMatchObject({ version: 6 });
    expect(byId.wasDeleted).toMatchObject({ version: 7, isDeleted: true });
    // Present now, absent from the snapshot: tombstoned one version up.
    expect(byId.newer).toMatchObject({
      version: 5,
      isDeleted: true,
      updated: 1000,
    });
    // Already a tombstone: untouched.
    expect(byId.gone).toEqual(el('gone', { version: 2, isDeleted: true }));
  });

  it('restoring an empty version tombstones everything live', () => {
    const out = buildRestoredScene([el('a', { version: 1 })], [], 5, nonce);

    expect(out).toEqual([
      expect.objectContaining({ id: 'a', isDeleted: true, version: 2 }),
    ]);
  });
});
