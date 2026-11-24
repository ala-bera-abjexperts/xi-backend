import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class DeleteMenuPermissionDto {
  @ApiProperty({ description: 'Menu permission ID to delete' })
  @IsUUID()
  id!: string;
}
