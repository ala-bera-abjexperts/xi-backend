/**
 * @fileoverview DTO for POST /workflows/:id/canvas.
 * @module src/workflows/dto/save-canvas.dto
 * @author Rajbha Manek
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
  Min,
  IsIn,
} from 'class-validator';

// Soft caps on payload size. A canvas with more than these counts is almost
// certainly client misuse or a malicious payload; the RPC's URL-length /
// indexing characteristics also degrade past these bounds.
const MAX_NODES = 500;
const MAX_TRANSITIONS = 1000;
const MAX_SOURCES = 2000;
const MAX_BRANCHES = 1000;

class CanvasNodeDto {
  @IsUUID() id!: string;
  @IsString() @IsIn(['status', 'decision', 'start']) kind!:
    | 'status'
    | 'decision'
    | 'start';
  @IsOptional() @IsUUID() status_id?: string | null;
  @IsOptional() @IsString() label?: string | null;
  @IsNumber({ allowNaN: false, allowInfinity: false }) position_x!: number;
  @IsNumber({ allowNaN: false, allowInfinity: false }) position_y!: number;
  @IsOptional() @IsObject() properties?: Record<string, unknown>;
}

class CanvasTransitionDto {
  @IsUUID() id!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string | null;
  @IsIn(['regular', 'common', 'global', 'self_loop', 'global_loop', 'initial'])
  kind!: string;
  @IsUUID() to_node_id!: string;
  @IsOptional() @IsUUID() screen_field_group_id?: string | null;
  @IsOptional() @IsUUID() screen_form_id?: string | null;
  @IsOptional() @IsArray() conditions?: unknown[];
  @IsOptional() @IsArray() validators?: unknown[];
  @IsOptional() @IsArray() post_functions?: unknown[];
  @IsOptional() @IsArray() triggers?: unknown[];
  @IsOptional() @IsObject() properties?: Record<string, unknown>;
  @IsOptional() @IsInt() sort_order?: number;
}

class CanvasTransitionSourceDto {
  @IsUUID() transition_id!: string;
  @IsUUID() from_node_id!: string;
}

class CanvasDecisionBranchDto {
  @IsUUID() id!: string;
  @IsUUID() decision_node_id!: string;
  @IsUUID() to_node_id!: string;
  @IsObject() expression!: Record<string, unknown>;
  @IsOptional() @IsString() label?: string | null;
  @IsOptional() @IsInt() sort_order?: number;
}

export class SaveCanvasDto {
  @ApiProperty({
    description: 'Expected workflow version for optimistic concurrency',
  })
  @IsInt()
  @Min(1)
  version!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  initial_status_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  layout?: Record<string, unknown>;

  @ApiProperty({ type: [CanvasNodeDto] })
  @IsArray()
  @ArrayMaxSize(MAX_NODES)
  @ValidateNested({ each: true })
  @Type(() => CanvasNodeDto)
  nodes!: CanvasNodeDto[];

  @ApiProperty({ type: [CanvasTransitionDto] })
  @IsArray()
  @ArrayMaxSize(MAX_TRANSITIONS)
  @ValidateNested({ each: true })
  @Type(() => CanvasTransitionDto)
  transitions!: CanvasTransitionDto[];

  @ApiProperty({ type: [CanvasTransitionSourceDto] })
  @IsArray()
  @ArrayMaxSize(MAX_SOURCES)
  @ValidateNested({ each: true })
  @Type(() => CanvasTransitionSourceDto)
  transition_sources!: CanvasTransitionSourceDto[];

  @ApiProperty({ type: [CanvasDecisionBranchDto] })
  @IsArray()
  @ArrayMaxSize(MAX_BRANCHES)
  @ValidateNested({ each: true })
  @Type(() => CanvasDecisionBranchDto)
  decision_branches!: CanvasDecisionBranchDto[];
}
