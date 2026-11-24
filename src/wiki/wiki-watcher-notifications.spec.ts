import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WikiCommentsService } from './wiki-comments.service';
import { WikiService } from './wiki.service';

type Result = { data: unknown; error: { message: string } | null };

function chain(result: Result) {
  const value: Record<string, unknown> = {};
  const self = () => value;
  for (const method of [
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'neq',
    'in',
    'is',
    'order',
    'limit',
  ]) {
    value[method] = jest.fn(self);
  }
  value['single'] = jest.fn().mockResolvedValue(result);
  value['maybeSingle'] = jest.fn().mockResolvedValue(result);
  value['then'] = (fn: (resolved: Result) => unknown) =>
    Promise.resolve(result).then(fn);
  return value;
}

const ORG = 'org-1';
const SPACE = 'space-1';
const PAGE = 'page-1';
const USER = 'user-1';
const page = {
  id: PAGE,
  organization_id: ORG,
  space_id: SPACE,
  title: 'Runbook',
  slug: 'runbook',
  content: '',
  content_format: 'editorjs',
  custom_field_values: {},
  metadata: {},
  is_published: false,
  is_archived: false,
};

function makeWikiService(
  responses: Record<string, ReturnType<typeof chain>[]>,
  watchers: { notifyWikiWatchers: jest.Mock },
) {
  const storageApi = {
    upload: jest.fn().mockResolvedValue({ error: null }),
    remove: jest.fn().mockResolvedValue({ error: null }),
    getPublicUrl: jest.fn().mockReturnValue({
      data: {
        publicUrl: 'https://storage.test/object/public/wiki-attachments/file',
      },
    }),
  };
  const from = jest.fn((table: string) => {
    const next = responses[table]?.shift();
    if (!next) throw new Error(`No response configured for ${table}`);
    return next;
  });
  const service = new WikiService(
    {
      getClient: () => ({
        from,
        storage: { from: jest.fn().mockReturnValue(storageApi) },
      }),
    } as unknown as SupabaseAdminService,
    {} as never,
    { assertKeysAllowed: jest.fn().mockResolvedValue(undefined) } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    watchers as never,
  );
  jest.spyOn(service, 'getPageById').mockResolvedValue(page);
  jest
    .spyOn(service as never, 'logAudit' as never)
    .mockResolvedValue(undefined as never);
  jest.spyOn(service, 'notifyMentionedUsers').mockResolvedValue(undefined);
  return { service, storageApi };
}

describe('wiki watcher mutation seams', () => {
  it('notifies once after a page edit and never after a failed write', async () => {
    const watchers = { notifyWikiWatchers: jest.fn() };
    const responses = {
      wiki_page_collab_snapshots: [
        chain({ data: null, error: null }),
        chain({ data: null, error: null }),
      ],
      wiki_pages: [
        chain({ data: { ...page, title: 'Edited' }, error: null }),
        chain({ data: null, error: { message: 'write failed' } }),
      ],
    };
    const { service } = makeWikiService(responses, watchers);

    await service.updatePage(PAGE, SPACE, { title: 'Edited' }, USER);
    expect(watchers.notifyWikiWatchers).toHaveBeenCalledTimes(1);
    expect(watchers.notifyWikiWatchers).toHaveBeenCalledWith(
      expect.objectContaining({ changeKind: 'page_updated' }),
    );

    await expect(
      service.updatePage(PAGE, SPACE, { title: 'Fail' }, USER),
    ).rejects.toThrow('write failed');
    expect(watchers.notifyWikiWatchers).toHaveBeenCalledTimes(1);
  });

  it('notifies once for custom fields, publish, and restore', async () => {
    const watchers = { notifyWikiWatchers: jest.fn() };
    const responses = {
      wiki_pages: [
        chain({ data: page, error: null }),
        chain({ data: { ...page, is_published: true }, error: null }),
        chain({ data: { ...page, title: 'Restored' }, error: null }),
      ],
      wiki_page_versions: [
        chain({
          data: { title: 'Restored', content: '', content_format: 'editorjs' },
          error: null,
        }),
      ],
      wiki_page_collab_snapshots: [chain({ data: null, error: null })],
    };
    const { service } = makeWikiService(responses, watchers);

    await service.patchCustomFieldValues(PAGE, SPACE, { owner: USER }, USER);
    await service.publishPage(PAGE, SPACE, true, USER);
    await service.restoreVersion(PAGE, SPACE, 2, USER);

    expect(watchers.notifyWikiWatchers).toHaveBeenCalledTimes(3);
    const calls = watchers.notifyWikiWatchers.mock.calls as unknown as Array<
      [{ changeKind: string }]
    >;
    expect(calls.map(([input]) => input.changeKind)).toEqual([
      'custom_fields_updated',
      'page_published',
      'page_restored',
    ]);
  });

  it('notifies once after wiki comment creation and not after a failed insert', async () => {
    const watchers = { notifyWikiWatchers: jest.fn() };
    const writes = [
      chain({ data: { id: 'comment-1', content: 'Hello' }, error: null }),
      chain({ data: null, error: { message: 'comment failed' } }),
    ];
    const from = jest.fn(() => writes.shift());
    const wikiService = {
      getPageById: jest.fn().mockResolvedValue(page),
      notifyMentionedUsers: jest.fn(),
    };
    const service = new WikiCommentsService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      wikiService as never,
      {} as never,
      watchers as never,
    );

    await service.createComment(PAGE, SPACE, { content: 'Hello' }, USER);
    expect(watchers.notifyWikiWatchers).toHaveBeenCalledTimes(1);
    expect(watchers.notifyWikiWatchers).toHaveBeenCalledWith(
      expect.objectContaining({ changeKind: 'comment_added' }),
    );
    await expect(
      service.createComment(PAGE, SPACE, { content: 'Fail' }, USER),
    ).rejects.toThrow('comment failed');
    expect(watchers.notifyWikiWatchers).toHaveBeenCalledTimes(1);
  });

  it('notifies once after wiki attachment add and remove', async () => {
    const watchers = { notifyWikiWatchers: jest.fn() };
    const attachment = {
      id: 'attachment-1',
      file_path:
        'https://storage.test/object/public/wiki-attachments/wiki/page/file',
      preview_file_path: null,
    };
    const responses = {
      wiki_page_attachments: [
        chain({ data: null, error: null }),
        chain({ data: attachment, error: null }),
        chain({ data: attachment, error: null }),
        chain({ data: null, error: null }),
      ],
    };
    const { service } = makeWikiService(responses, watchers);
    const file = {
      originalname: 'note.txt',
      mimetype: 'text/plain',
      size: 3,
      buffer: Buffer.from('abc'),
    } as Express.Multer.File;

    await service.createAttachment(PAGE, SPACE, file, USER);
    expect(watchers.notifyWikiWatchers).toHaveBeenCalledTimes(1);
    expect(watchers.notifyWikiWatchers).toHaveBeenLastCalledWith(
      expect.objectContaining({ changeKind: 'attachment_added' }),
    );

    await service.deleteAttachment(attachment.id, PAGE, SPACE, USER);
    expect(watchers.notifyWikiWatchers).toHaveBeenCalledTimes(2);
    expect(watchers.notifyWikiWatchers).toHaveBeenLastCalledWith(
      expect.objectContaining({ changeKind: 'attachment_removed' }),
    );
  });
});
