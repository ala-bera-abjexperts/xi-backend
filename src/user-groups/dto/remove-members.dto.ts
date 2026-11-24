import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsUUID, ValidateIf } from 'class-validator';

export class RemoveMembersDto {
  @ApiPropertyOptional({ description: 'Single user ID to remove' })
  @ValidateIf((o: RemoveMembersDto) => !o.user_ids)
  @IsUUID('loose')
  user_id?: string;

  @ApiPropertyOptional({ description: 'Multiple user IDs to remove (bulk)' })
  @ValidateIf((o: RemoveMembersDto) => !o.user_id)
  @IsArray()
  @IsUUID('loose', { each: true })
  user_ids?: string[];
}
