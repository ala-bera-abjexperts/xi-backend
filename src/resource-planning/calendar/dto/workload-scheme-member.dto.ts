import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Assigns (or reassigns, on conflict) a user to a workload scheme. */
export class AssignWorkloadSchemeMemberDto {
  @ApiProperty()
  @IsUUID()
  scheme_id!: string;

  @ApiProperty()
  @IsUUID()
  user_id!: string;
}
