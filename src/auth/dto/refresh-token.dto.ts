/**
 * @fileoverview Data Transfer Object for token refresh requests.
 * Validates that a refresh token is provided before exchanging it for a new token pair.
 * @module src/auth/dto/refresh-token.dto
 * @author Prince Jadiya
 */

import { IsOptional, IsString, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for the `POST /auth/refresh` endpoint.
 *
 * Validation rules:
 * - `refreshToken`: optional non-empty string. If absent, the controller falls back
 *   to the `refresh_token` HttpOnly cookie (preferred for browser callers).
 */
export class RefreshTokenDto {
  /**
   * The refresh token obtained from a previous sign-in or token refresh response.
   * Optional — the controller will read the `refresh_token` cookie if this field is absent.
   *
   * @example 'pcnpngwwbrge'
   */
  @ApiPropertyOptional({
    example: 'pcnpngwwbrge',
    description:
      'Refresh token. Optional when the refresh_token cookie is present.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  refreshToken?: string;
}
