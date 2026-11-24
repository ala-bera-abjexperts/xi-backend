/**
 * @fileoverview DTO for sharing a support request with another XISUITE user by email.
 * @module src/help-center/dto/share-support-request.dto
 * @author Prince Jadiya
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

export class ShareSupportRequestDto {
  @ApiProperty({ description: 'Email address to share this ticket with' })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
