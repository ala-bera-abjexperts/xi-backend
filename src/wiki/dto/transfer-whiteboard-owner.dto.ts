/**
 * @fileoverview DTO for handing a whiteboard to another space member.
 * @module src/wiki/dto/transfer-whiteboard-owner.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class TransferWhiteboardOwnerDto {
  @ApiProperty({ description: 'public.users.id of the new owner' })
  @IsUUID()
  user_id!: string;
}
