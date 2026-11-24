import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export const BUDGET_TREE_MAX_DEPTH = 5;
export const BUDGET_TREE_MAX_NODES = 300;

export class BudgetTreeQueryDto {
  @ApiPropertyOptional({
    default: 3,
    minimum: 0,
    maximum: BUDGET_TREE_MAX_DEPTH,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(BUDGET_TREE_MAX_DEPTH)
  depth?: number;

  /** The walk itself is parent/child only; dependency links ride on include_dependencies. */
  @ApiPropertyOptional({ enum: ['children'], default: 'children' })
  @IsOptional()
  @IsIn(['children'])
  direction?: 'children';

  /** Fixed-space view: 403 if the space isn't enabled/accessible, 404 if the root lives elsewhere. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  space_id?: string;

  /** Attach one hop of dependency-linked tickets (never rolled up). */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  include_dependencies?: boolean;
}
