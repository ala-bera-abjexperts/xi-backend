import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, Max, Min } from 'class-validator';

export class UpdateLetterScheduleDto {
  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ enum: ['weekly', 'biweekly', 'monthly', 'quarterly'] })
  @IsIn(['weekly', 'biweekly', 'monthly', 'quarterly'])
  cadence!: 'weekly' | 'biweekly' | 'monthly' | 'quarterly';

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(31)
  day_of_period!: number;

  @ApiProperty({ enum: ['period_start', 'period_end'] })
  @IsIn(['period_start', 'period_end'])
  reporting_period_anchor!: 'period_start' | 'period_end';
}
