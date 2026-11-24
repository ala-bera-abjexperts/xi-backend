/**
 * @fileoverview DTOs for MFA enrollment, challenge, and verification flows.
 * @module src/auth/mfa/dto/enroll-mfa.dto
 */

import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsIn,
  MinLength,
  Length,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body for `POST /auth/mfa/enroll`. Currently only supports TOTP (Supabase MFA factor type).
 */
export class EnrollMfaDto {
  @ApiPropertyOptional({
    enum: ['totp'],
    default: 'totp',
    description: 'MFA factor type (only TOTP supported today).',
  })
  @IsOptional()
  @IsIn(['totp'])
  factorType = 'totp' as const;

  @ApiPropertyOptional({
    description:
      'Optional friendly name for this factor (e.g., "Personal phone").',
  })
  @IsOptional()
  @IsString()
  friendlyName?: string;
}

/**
 * Body for `POST /auth/mfa/challenge`.
 */
export class ChallengeMfaDto {
  @ApiProperty({ description: 'Factor ID returned by /auth/mfa/enroll.' })
  @IsString()
  @MinLength(1)
  factorId: string;
}

/**
 * Body for `POST /auth/mfa/verify`. Verifies a 6-digit TOTP code against an
 * outstanding challenge. On success, NestJS rotates the auth cookies to the
 * new aal2 tokens.
 */
export class VerifyMfaDto {
  @ApiProperty({ description: 'Factor ID being verified.' })
  @IsString()
  @MinLength(1)
  factorId: string;

  @ApiProperty({
    description: 'Challenge ID from /auth/mfa/challenge.',
  })
  @IsString()
  @MinLength(1)
  challengeId: string;

  @ApiProperty({ description: '6-digit TOTP code from the authenticator app.' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code: string;
}

/**
 * Body for `POST /auth/mfa/unenroll`.
 */
export class UnenrollMfaDto {
  @ApiProperty({ description: 'Factor ID to unenroll.' })
  @IsString()
  @MinLength(1)
  factorId: string;
}
