/**
 * @fileoverview DTO for a customer-portal comment posted against a support request.
 * @module src/help-center/dto/add-support-request-comment.dto
 * @author Prince Jadiya
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AddSupportRequestCommentDto {
  @ApiProperty({ description: 'Comment body (1-10000 chars)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  content!: string;
}
