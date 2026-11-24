/**
 * @fileoverview DTO for PATCH actions on a task.
 * @module src/tasks/dto/patch-task.dto
 * @author Prince Jadiya
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { UpdateTaskDto } from './update-task.dto';

export class PatchTaskDto extends UpdateTaskDto {
  @ApiPropertyOptional({
    enum: ['update_status', 'assign', 'partial_update'],
    description: 'Legacy action name. Omit to perform a normal partial update.',
  })
  @IsOptional()
  @IsString()
  @IsIn(['update_status', 'assign', 'partial_update'])
  action?: string;
}
