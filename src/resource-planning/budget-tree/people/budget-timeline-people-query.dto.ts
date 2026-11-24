import { ApiProperty, PickType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';
import { BudgetTimelineQueryDto } from '../dto/budget-timeline-query.dto';

/** Roots one Ressource Tree selection can hold in a single people request. */
export const BUDGET_TIMELINE_PEOPLE_MAX_TASKS = 50;

/** Comma-separated ids, like ScheduleQueryDto's user_ids. */
function toIdArray({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** The timeline query (depth, fixed space, month range, time zone) for several roots. */
export class BudgetTimelinePeopleQueryDto extends PickType(
  BudgetTimelineQueryDto,
  ['depth', 'space_id', 'from', 'to', 'tz'] as const,
) {
  @ApiProperty({
    type: [String],
    description:
      'Comma-separated root task ids of the Ressource Tree selection',
  })
  @Transform(toIdArray)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BUDGET_TIMELINE_PEOPLE_MAX_TASKS)
  @IsUUID(undefined, { each: true })
  task_ids!: string[];
}
