import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class SetRagDto {
  @ApiProperty({ enum: ['green', 'amber', 'red'] })
  @IsIn(['green', 'amber', 'red'])
  rag_status!: 'green' | 'amber' | 'red';
}
