import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

// Limits mirror the test_management_api_keys CHECKs; the database re-checks the dates.
export const TM_API_KEY_LIMITS = {
  maxActivePerUser: 10,
  defaultDays: 90,
  maxDays: 365,
  name: 100,
} as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateTestManagementApiKeyDto {
  @ApiProperty({ minLength: 1, maxLength: TM_API_KEY_LIMITS.name })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @Length(1, TM_API_KEY_LIMITS.name)
  name: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: TM_API_KEY_LIMITS.maxDays,
    default: TM_API_KEY_LIMITS.defaultDays,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(TM_API_KEY_LIMITS.maxDays)
  expires_in_days?: number;

  // A custom length chosen by the user; use it instead of expires_in_days.
  @ApiPropertyOptional({ minimum: 1, maximum: 999 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999)
  expires_in_amount?: number;

  @ApiPropertyOptional({ enum: ['days', 'months', 'years'] })
  @IsOptional()
  @IsIn(['days', 'months', 'years'])
  expires_in_unit?: 'days' | 'months' | 'years';

  @ApiPropertyOptional({
    description: 'A key that never expires (owners and admins only)',
  })
  @IsOptional()
  @IsBoolean()
  never_expires?: boolean;
}

export class AuthenticateTestManagementApiKeyDto {
  @ApiProperty({ format: 'uuid', description: 'Id of the API key' })
  @IsUUID('all')
  client_id: string;

  @ApiProperty({ description: 'The API key itself (xis_tm_…)' })
  @IsString()
  @Length(1, 200)
  client_secret: string;
}

export interface TestManagementAccessToken {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  expires_at: string;
}

export class TestManagementAccessTokenResponse implements TestManagementAccessToken {
  @ApiProperty({
    description:
      'Send as Authorization: Bearer <access_token> on the routes that accept API keys',
  })
  access_token: string;

  @ApiProperty({ enum: ['Bearer'] })
  token_type: 'Bearer';

  @ApiProperty({ description: 'Seconds until the token expires' })
  expires_in: number;

  @ApiProperty({
    format: 'date-time',
    description: 'Never later than the key itself',
  })
  expires_at: string;
}

export class ListTestManagementApiKeysQueryDto {
  @ApiPropertyOptional({
    description: 'Every key of the organization (owners and admins only)',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  all?: boolean;
}

export interface TestManagementApiKeyOwner {
  id: string;
  email: string | null;
  name: string | null;
}

export interface TestManagementApiKey {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;

  // Null for a key that never expires.
  expires_at: string | null;
  last_used_at: string | null;
  expired: boolean;
  owner?: TestManagementApiKeyOwner;
}
