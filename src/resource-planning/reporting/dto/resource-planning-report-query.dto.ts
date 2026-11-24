import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import type {
  ResourcePlanningReportBucket,
  ResourcePlanningReportGroup,
} from '../resource-planning-report.types';

const REPORT_BUCKETS = ['day', 'week', 'month'] as const;
const REPORT_GROUPS = ['user', 'unit', 'plan', 'portfolio'] as const;

export class ResourcePlanningReportQueryDto {
  @ApiPropertyOptional({
    format: 'date',
    description: 'Inclusive UTC start date',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    format: 'date',
    description: 'Inclusive UTC end date',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;

  @ApiPropertyOptional({ enum: REPORT_BUCKETS, default: 'week' })
  @IsOptional()
  @IsIn(REPORT_BUCKETS)
  bucket?: ResourcePlanningReportBucket;

  @ApiPropertyOptional({ enum: REPORT_GROUPS, default: 'user' })
  @IsOptional()
  @IsIn(REPORT_GROUPS)
  group_by?: ResourcePlanningReportGroup;

  @ApiPropertyOptional({ format: 'uuid', description: 'Selected group filter' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  )
  @IsUUID()
  group_id?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Restrict the report to the plans of this portfolio',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  )
  @IsUUID()
  portfolio_id?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Restrict the report to one space (403 when Resource Planning is not available there)',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  )
  @IsUUID()
  space_id?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(
    ({ value }: { value: unknown }) => value === true || value === 'true',
  )
  @IsBoolean()
  include_archived?: boolean;
}

export class ResourcePlanningReportExportQueryDto extends ResourcePlanningReportQueryDto {
  @ApiPropertyOptional({ enum: ['csv', 'pdf'], default: 'csv' })
  @IsOptional()
  @IsIn(['csv', 'pdf'])
  format?: 'csv' | 'pdf';
}
