/**
 * @fileoverview DTO for creating a task relationship.
 * @module src/tasks/dto/create-relationship.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateRelationshipDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ description: 'Legacy source entity UUID.' })
  @IsOptional()
  @IsUUID()
  source_id?: string;

  @ApiProperty({ description: 'Target entity UUID' })
  @IsUUID()
  target_id!: string;

  @ApiPropertyOptional({
    enum: ['task', 'process', 'wiki_page'],
    default: 'task',
  })
  @IsOptional()
  @IsString()
  @IsIn(['task', 'process', 'wiki_page'])
  target_type?: string;

  @ApiPropertyOptional({
    enum: ['task', 'process'],
    default: 'task',
  })
  @IsOptional()
  @IsString()
  @IsIn(['task', 'process'])
  source_type?: string;

  @ApiProperty({ description: 'Relation type UUID' })
  @IsUUID()
  relation_type_id!: string;
}
