import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/**
 * Typed confirmation for the guarded undo.
 *
 * A boolean `confirm: true` is one careless click away from deleting a customer's migrated work.
 * Requiring the caller to retype the job's own name makes the destruction deliberate: you cannot
 * send it without having looked at which job you are undoing.
 */
export class DeleteTargetsDto {
  @ApiProperty({
    description:
      'The exact name of the job being undone, retyped. Must match, or the request is rejected.',
    example: 'SDP → Engineering',
  })
  @IsString()
  confirm_job_name!: string;
}
