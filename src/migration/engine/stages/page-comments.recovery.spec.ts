jest.mock('../../mappers/page.mapper', () => ({ PAGE_ENTITY: 'page' }));
jest.mock('../../../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import type { WikiCommentsService } from '../../../wiki/wiki-comments.service';
import { PageCommentsStage } from './page-comments.stage';
import type { StageContext } from './stage.interface';

describe('PageCommentsStage stale target recovery', () => {
  it('removes a stale comment mapping before recreating the missing comment', async () => {
    const comments = {
      createComment: jest.fn().mockResolvedValue({ id: 'comment-new' }),
    };
    const entityMap = {
      getTarget: jest.fn(
        (_org: string, _connection: string, entityType: string) =>
          Promise.resolve(
            entityType === 'space'
              ? { status: 'mapped', target_id: 'space-live' }
              : {
                  status: 'mapped',
                  target_id: 'comment-deleted',
                },
          ),
      ),
      getExistingWikiPageTarget: jest.fn().mockResolvedValue({
        status: 'mapped',
        target_id: 'page-live',
      }),
      getExistingWikiChildTarget: jest.fn().mockResolvedValue(null),
      deleteExactStaleMapping: jest.fn().mockResolvedValue(true),
      recordMapping: jest.fn().mockResolvedValue(undefined),
    };
    const ctx = {
      orgId: 'org-1',
      dryRun: false,
      job: {
        id: 'job-1',
        connection_id: 'conn-1',
        source_ref: 'DOCS',
      },
      run: { id: 'run-1', created_by: 'user-1', config_snapshot: {} },
      entityMap,
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as StageContext;
    const stage = new PageCommentsStage(
      comments as WikiCommentsService,
      {
        getClient: () => ({}),
      } as never,
    );

    await expect(
      stage.processItem(ctx, {
        payload: {
          pageSourceId: 'source-page-1',
          comment: {
            sourceId: 'source-comment-1',
            body: {
              value: {
                type: 'doc',
                version: 1,
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Recovered comment' }],
                  },
                ],
              },
            },
          },
        },
      } as never),
    ).resolves.toEqual({
      kind: 'created',
      targetId: 'comment-new',
      targetTable: 'wiki_page_comments',
    });
    expect(entityMap.deleteExactStaleMapping).toHaveBeenCalledWith(
      'org-1',
      'conn-1',
      'page_comment',
      'source-comment-1',
      'comment-deleted',
    );
    expect(comments.createComment).toHaveBeenCalledTimes(1);
  });
});
