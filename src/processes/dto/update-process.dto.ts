/**
 * @fileoverview DTO for updating a process.
 * @module src/processes/dto/update-process.dto
 * @author Prince Jadiya
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PROCESS_STATUSES, REQUEST_TYPES } from './create-process.dto';

export class UpdateProcessDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: REQUEST_TYPES })
  @IsOptional()
  @IsString()
  @IsIn(REQUEST_TYPES as unknown as string[])
  request_type?: (typeof REQUEST_TYPES)[number];

  @ApiPropertyOptional({ enum: PROCESS_STATUSES })
  @IsOptional()
  @IsString()
  @IsIn(PROCESS_STATUSES as unknown as string[])
  status?: (typeof PROCESS_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  hierarchy_level_id?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  parent_ids?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parent_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigned_to?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  vuln_c_p?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  vuln_c_i?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  vuln_i_p?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  vuln_i_i?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  vuln_a_p?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  vuln_a_i?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  action_c_p?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  action_c_i?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  action_i_p?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  action_i_i?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  action_a_p?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  action_a_i?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  custom_field_values?: Record<string, unknown>;
}
