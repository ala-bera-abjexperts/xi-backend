import { ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { IsOptional, IsTimeZone, Matches } from 'class-validator';
import { BudgetTreeQueryDto } from './budget-tree-query.dto';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Same tree walk as the budget tree (depth, fixed space) plus the month range. */
export class BudgetTimelineQueryDto extends PickType(BudgetTreeQueryDto, [
  'depth',
  'space_id',
] as const) {
  /** First month (YYYY-MM). Default: the current UTC month. */
  @ApiPropertyOptional({ example: '2027-01' })
  @IsOptional()
  @Matches(MONTH_PATTERN, { message: 'from must be a month (YYYY-MM)' })
  from?: string;

  /** Last month (YYYY-MM), at most 24 months after from. Default: from + 11. */
  @ApiPropertyOptional({ example: '2027-12' })
  @IsOptional()
  @Matches(MONTH_PATTERN, { message: 'to must be a month (YYYY-MM)' })
  to?: string;

  /** IANA time zone task dates are read in, so month boundaries match the viewer. */
  @ApiPropertyOptional({ default: 'UTC', example: 'Europe/Vienna' })
  @IsOptional()
  @IsTimeZone()
  tz?: string;
}
