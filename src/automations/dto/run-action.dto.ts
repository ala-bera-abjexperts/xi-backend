import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class RunActionDto {
  @ApiProperty({ description: 'Space ID the automation belongs to' })
  @IsUUID()
  spaceId: string;
}
