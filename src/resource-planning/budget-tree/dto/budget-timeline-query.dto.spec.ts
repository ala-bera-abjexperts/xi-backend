import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BudgetTimelineQueryDto } from './budget-timeline-query.dto';

const errorsFor = async (query: Record<string, unknown>) =>
  (await validate(plainToInstance(BudgetTimelineQueryDto, query))).map(
    (error) => error.property,
  );

describe('BudgetTimelineQueryDto', () => {
  it('accepts months, a time zone, depth and a space', async () => {
    await expect(
      errorsFor({
        from: '2027-01',
        to: '2028-12',
        tz: 'Europe/Vienna',
        depth: '2',
        space_id: '11111111-1111-4111-8111-111111111111',
      }),
    ).resolves.toEqual([]);
  });

  it('rejects bad months, an unknown time zone and the tree limits', async () => {
    await expect(
      errorsFor({
        from: '2027-13',
        to: '2027-1',
        tz: 'Mars/Olympus',
        depth: '9',
        space_id: 'nope',
      }),
    ).resolves.toEqual(
      expect.arrayContaining(['from', 'to', 'tz', 'depth', 'space_id']),
    );
  });
});
