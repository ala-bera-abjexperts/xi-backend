import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

export enum PlanPermissionLevel {
  VIEW = 'view',
  EDIT = 'edit',
  ADMIN = 'admin',
}

export class CreatePlanPermissionDto {
  @ApiPropertyOptional({
    description:
      'Legacy body field accepted for compatibility; route param wins.',
  })
  @IsOptional()
  @IsUUID()
  plan_id?: string;

  @ApiProperty()
  @IsUUID()
  user_id!: string;

  @ApiPropertyOptional({
    enum: PlanPermissionLevel,
    default: PlanPermissionLevel.VIEW,
  })
  @IsOptional()
  @IsEnum(PlanPermissionLevel)
  permission_level?: PlanPermissionLevel;
}
