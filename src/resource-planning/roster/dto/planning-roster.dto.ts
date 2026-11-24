/**
 * @fileoverview DTOs for the org-level Planning roster
 * (`/resource-planning/roster`).
 * @module src/resource-planning/roster/dto/planning-roster.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const PLANNING_ROSTER_DEFAULT_LIMIT = 25;
export const PLANNING_ROSTER_MAX_LIMIT = 100;
export const PLANNING_ROSTER_MAX_ADD_USERS = 500;

export class ListPlanningRosterQueryDto {
  @ApiPropertyOptional({
    description: 'Matches name or email',
    maxLength: 200,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    default: PLANNING_ROSTER_DEFAULT_LIMIT,
    minimum: 1,
    maximum: PLANNING_ROSTER_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PLANNING_ROSTER_MAX_LIMIT)
  limit?: number;
}

export class AddPlanningRosterUsersDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: PLANNING_ROSTER_MAX_ADD_USERS,
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(PLANNING_ROSTER_MAX_ADD_USERS)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  user_ids!: string[];
}

export class AddPlanningRosterGroupDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  group_id!: string;
}
