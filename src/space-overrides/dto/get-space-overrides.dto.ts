import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsUUID } from 'class-validator';

export class GetSpaceOverridesDto {
  @ApiProperty({ description: 'Space ID' })
  @IsUUID()
  spaceId!: string;

  @ApiProperty({ enum: ['priority', 'status', 'custom_field'] })
  @IsIn(['priority', 'status', 'custom_field'])
  type!: 'priority' | 'status' | 'custom_field';
}
