import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID, ArrayMinSize, IsOptional } from 'class-validator';

export class ReorderBacklogDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID('4')
  organizationId?: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  task_ids!: string[];
}
