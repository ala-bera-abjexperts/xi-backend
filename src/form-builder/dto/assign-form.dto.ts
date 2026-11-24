import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';

export const ASSIGNABLE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

// Assign a form to specific users and/or whole roles. Roles are expanded to their
// current space members at assign time (snapshot). The global ValidationPipe runs
// whitelist + forbidNonWhitelisted, so status/assigned_by/organization_id sent by a
// client are rejected rather than trusted.
export class AssignFormDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'public.users.id values',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  userIds?: string[];

  @ApiPropertyOptional({ enum: ASSIGNABLE_ROLES, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn(ASSIGNABLE_ROLES as unknown as string[], { each: true })
  roles?: AssignableRole[];

  @ApiPropertyOptional({ description: 'ISO-8601 due date' })
  @IsOptional()
  @IsDateString()
  dueAt?: string;
}
