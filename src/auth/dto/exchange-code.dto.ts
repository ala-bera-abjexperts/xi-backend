/**
 * @fileoverview DTO for the public `POST /auth/exchange-code` endpoint that
 * trades a one-time Supabase auth code (from a recovery / invite email link
 * or OAuth callback) for a session.
 * @module src/auth/dto/exchange-code.dto
 */

import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ExchangeCodeDto {
  @ApiProperty({
    description:
      'One-time Supabase auth code from a recovery / invite email link or OAuth callback.',
  })
  @IsString()
  @MinLength(1)
  code: string;
}
