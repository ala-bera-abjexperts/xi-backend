import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateOrganizationModuleDto {
  @ApiProperty({ description: 'Whether the organization module is enabled' })
  @IsBoolean()
  is_enabled!: boolean;
}
