import type { BoardsService } from '../../../boards/boards.service';
import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { BoardsStage } from './boards.stage';
import type { StageContext, MigrationRunItemRow } from './stage.interface';

describe('inaccessible board configuration', () => {
  it('fails only the unavailable board without creating fabricated columns', async () => {
    const board = {
      sourceId: '17',
      name: 'Denied',
      columns: [],
      configurationError: 'Board 17 configuration HTTP 403',
    };
    const ctx = {
      job: { source_ref: 'DEMO' },
      entityMap: { getTarget: jest.fn().mockResolvedValue(null) },
      getAdapter: async () => ({
        product: 'jira',
        listProjects: jest.fn(),
        getBoards: async () => [board],
      }),
    } as unknown as StageContext;
    const create = jest.fn();
    const stage = new BoardsStage(
      { create } as unknown as BoardsService,
      {} as SupabaseAdminService,
    );
    await expect(
      stage.processItem(ctx, {
        payload: board,
      } as unknown as MigrationRunItemRow),
    ).rejects.toThrow(
      'Board 17 configuration HTTP 403. After restoring source access, run full Jira repair to rediscover board status prerequisites; retrying this board alone cannot discover missing statuses.',
    );
    expect(create).not.toHaveBeenCalled();
  });
});
