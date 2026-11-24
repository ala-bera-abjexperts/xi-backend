/**
 * @fileoverview DTO for creating a process-to-process relationship.
 * @module src/processes/dto/create-process-relationship.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateProcessRelationshipDto {
  @ApiProperty({ description: 'Parent process UUID' })
  @IsUUID()
  parent_process_id!: string;

  @ApiPropertyOptional({
    description: 'Relation type UUID (from relation_types)',
  })
  @IsOptional()
  @IsUUID()
  relation_type_id?: string;

  @ApiPropertyOptional({ description: 'Relationship kind (text label)' })
  @IsOptional()
  @IsString()
  relationship_type?: string;
}
