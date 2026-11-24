import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  BUDGET_TIMELINE_PEOPLE_MAX_TASKS,
  BudgetTimelinePeopleQueryDto,
} from './budget-timeline-people-query.dto';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

const errorsFor = async (query: Record<string, unknown>) =>
  (await validate(plainToInstance(BudgetTimelinePeopleQueryDto, query))).map(
    (error) => error.property,
  );

describe('BudgetTimelinePeopleQueryDto', () => {
  it('splits comma-separated task ids and keeps the timeline fields', async () => {
    const dto = plainToInstance(BudgetTimelinePeopleQueryDto, {
      task_ids: ` ${ID_A}, ${ID_B} ,`,
      from: '2027-01',
      to: '2027-12',
      tz: 'Europe/Vienna',
      depth: '2',
      space_id: ID_A,
    });

    expect(dto.task_ids).toEqual([ID_A, ID_B]);
    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('requires at least one valid task id and caps the list', async () => {
    await expect(errorsFor({})).resolves.toContain('task_ids');
    await expect(errorsFor({ task_ids: '' })).resolves.toContain('task_ids');
    await expect(errorsFor({ task_ids: 'nope' })).resolves.toContain(
      'task_ids',
    );
    await expect(
      errorsFor({
        task_ids: Array.from(
          { length: BUDGET_TIMELINE_PEOPLE_MAX_TASKS + 1 },
          () => ID_A,
        ).join(','),
      }),
    ).resolves.toContain('task_ids');
  });

  it('rejects bad months, time zone, depth and space like the timeline', async () => {
    await expect(
      errorsFor({
        task_ids: ID_A,
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
