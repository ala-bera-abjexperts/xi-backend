import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Query for `GET /migration/runs/:id/report`. */
export class ReportQueryDto {
  @ApiPropertyOptional({
    enum: ['json', 'csv', 'pdf'],
    description: 'Response format. Defaults to json.',
  })
  @IsOptional()
  @IsIn(['json', 'csv', 'pdf'])
  format?: 'json' | 'csv' | 'pdf';
}

/** Query for the sanitized audit trail behind a migration report. */
export class ReportItemsQueryDto {
  @ApiPropertyOptional({
    enum: [
      'pending',
      'running',
      'sleeping',
      'succeeded',
      'failed',
      'skipped',
      'paused',
      'blocked',
      'dead',
    ],
  })
  @IsOptional()
  @IsIn([
    'pending',
    'running',
    'sleeping',
    'succeeded',
    'failed',
    'skipped',
    'paused',
    'blocked',
    'dead',
  ])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  stage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entity_type?: string;

  @ApiPropertyOptional({ enum: ['collection', 'entity'] })
  @IsOptional()
  @IsIn(['collection', 'entity'])
  item_kind?: 'collection' | 'entity';

  @ApiPropertyOptional({ minimum: 1, maximum: 500, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
