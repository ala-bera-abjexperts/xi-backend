import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class PatchSpaceTypeDto {
  @ApiProperty({ enum: ['restore', 'toggle_active'] })
  @IsIn(['restore', 'toggle_active'])
  action!: 'restore' | 'toggle_active';
}
