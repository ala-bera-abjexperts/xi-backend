import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PlanPermissionLevel } from './create-plan-permission.dto';

export class UpdatePlanPermissionDto {
  @ApiPropertyOptional({
    description:
      'Legacy body field accepted for compatibility; route param wins.',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ enum: PlanPermissionLevel })
  @IsEnum(PlanPermissionLevel)
  permission_level!: PlanPermissionLevel;
}
