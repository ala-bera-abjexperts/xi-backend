import { StatusCategoryStage } from './status-category.stage';
import type { StatusCategoriesService } from '../../../status-categories/status-categories.service';
import type { StageContext } from './stage.interface';

describe('board status category prerequisites', () => {
  it('seeds all canonical Jira categories for board-only status buckets', async () => {
    const ctx = {
      getAdapter: async () => ({
        product: 'jira',
        listProjects: jest.fn(),
        getStatuses: async () => [{ statusCategory: 'new' }],
      }),
      job: { source_ref: 'DEMO' },
      run: { config_snapshot: { scope: { include_boards: true } } },
    } as unknown as StageContext;
    const stage = new StatusCategoryStage({} as StatusCategoriesService);
    expect(
      (await stage.produce(ctx)).items.map((item) => item.sourceRef),
    ).toEqual(['new', 'indeterminate', 'done']);
    ctx.run.config_snapshot = { scope: { include_boards: false } };
    expect(
      (await stage.produce(ctx)).items.map((item) => item.sourceRef),
    ).toEqual(['new']);
  });
});
