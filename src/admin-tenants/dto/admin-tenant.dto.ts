import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const TENANT_SIZES = ['small', 'medium', 'large', 'enterprise'] as const;
const TENANT_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

export type TenantSize = (typeof TENANT_SIZES)[number];
export type TenantRole = (typeof TENANT_ROLES)[number];

function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function trimLowerString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

function trimOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class CreateAdminTenantDto {
  @Transform(({ value }) => trimString(value))
  @IsString()
  @Length(2, 100)
  name!: string;

  @Transform(({ value }) => trimLowerString(value))
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug!: string;

  @IsOptional()
  @IsIn(TENANT_SIZES)
  size?: TenantSize;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpdateAdminTenantDto {
  @IsOptional()
  @Transform(({ value }) => trimString(value))
  @IsString()
  @Length(2, 100)
  name?: string;

  @IsOptional()
  @Transform(({ value }) => trimLowerString(value))
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug?: string;

  @IsOptional()
  @IsIn(TENANT_SIZES)
  size?: TenantSize;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value === undefined ? null : (value as string | null),
  )
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  default_space_id?: string | null;
}

export class UpdateAdminTenantStatusDto {
  @IsBoolean()
  is_active!: boolean;
}

export class CreateAdminTenantUserDto {
  @Transform(({ value }) => trimLowerString(value))
  @IsEmail()
  email!: string;

  @Transform(({ value }) => trimString(value))
  @IsString()
  @Length(1, 50)
  first_name!: string;

  @Transform(({ value }) => trimString(value))
  @IsString()
  @Length(1, 50)
  last_name!: string;

  @IsOptional()
  @Transform(({ value }) => trimOrNull(value))
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(20)
  mobile?: string | null;

  @IsOptional()
  @IsIn(TENANT_ROLES)
  role?: TenantRole;

  @IsOptional()
  @IsString()
  @Length(8, 128)
  password?: string;

  @IsOptional()
  @IsBoolean()
  send_invite?: boolean;
}

export class UpdateAdminTenantUserDto {
  @IsOptional()
  @Transform(({ value }) => trimString(value))
  @IsString()
  @Length(1, 50)
  first_name?: string;

  @IsOptional()
  @Transform(({ value }) => trimString(value))
  @IsString()
  @Length(1, 50)
  last_name?: string;

  @IsOptional()
  @Transform(({ value }) => trimOrNull(value))
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(20)
  mobile?: string | null;
}

export class UpdateAdminTenantUserStatusDto {
  @IsBoolean()
  is_active!: boolean;
}

export class UpdateAdminTenantUserRoleDto {
  @IsIn(TENANT_ROLES)
  role!: TenantRole;
}
