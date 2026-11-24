import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsUUID } from 'class-validator';

export class SetSpaceOverrideDto {
  @ApiProperty({ description: 'Space ID' })
  @IsUUID()
  spaceId!: string;

  @ApiProperty({ enum: ['priority', 'status', 'custom_field'] })
  @IsIn(['priority', 'status', 'custom_field'])
  type!: 'priority' | 'status' | 'custom_field';

  @ApiProperty({
    description: 'Entity ID (priority, status, or custom_field ID)',
  })
  @IsUUID()
  entityId!: string;

  @ApiProperty({ description: 'Whether the entity is enabled in this space' })
  @IsBoolean()
  isEnabled!: boolean;

  @ApiProperty({
    description:
      'Organization ID (accepted from frontend; JWT org is always used)',
  })
  @IsUUID()
  organizationId!: string;
}
