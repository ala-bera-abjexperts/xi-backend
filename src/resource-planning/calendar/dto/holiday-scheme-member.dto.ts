import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Assigns (or reassigns, on conflict) a user to a holiday scheme. */
export class AssignHolidaySchemeMemberDto {
  @ApiProperty()
  @IsUUID()
  scheme_id!: string;

  @ApiProperty()
  @IsUUID()
  user_id!: string;
}
