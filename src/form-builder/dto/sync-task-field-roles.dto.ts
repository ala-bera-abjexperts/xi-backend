import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsUUID } from 'class-validator';

export class SyncTaskFieldRolesDto {
  @ApiProperty({ description: 'The space where tasks will be created' })
  @IsUUID()
  space_id: string;

  @ApiProperty({
    description: 'Map of task field → form field_key (null to clear)',
  })
  @IsObject()
  mappings: Record<string, string | null>;
}
