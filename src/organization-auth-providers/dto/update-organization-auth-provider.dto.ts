import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateOrganizationAuthProviderDto {
  @ApiProperty({ description: 'Whether the auth provider is enabled' })
  @IsBoolean()
  is_enabled!: boolean;
}
