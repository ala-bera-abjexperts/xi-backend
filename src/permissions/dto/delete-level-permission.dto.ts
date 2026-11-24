import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class DeleteLevelPermissionDto {
  @ApiProperty({ description: 'Level permission ID to delete' })
  @IsUUID()
  id!: string;
}
