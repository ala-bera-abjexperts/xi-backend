import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsUUID, ValidateIf } from 'class-validator';

export class AddMembersDto {
  @ApiPropertyOptional({ description: 'Single user ID to add' })
  @ValidateIf((o: AddMembersDto) => !o.user_ids)
  @IsUUID('loose')
  user_id?: string;

  @ApiPropertyOptional({ description: 'Multiple user IDs to add (bulk)' })
  @ValidateIf((o: AddMembersDto) => !o.user_id)
  @IsArray()
  @IsUUID('loose', { each: true })
  user_ids?: string[];

  @ApiPropertyOptional({ description: 'Role ID to assign to added member(s)' })
  @IsOptional()
  @IsUUID('loose')
  role_id?: string | null;
}
