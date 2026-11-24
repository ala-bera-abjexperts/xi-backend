import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ example: 'Acme Corp' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'acme-corp' })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({ enum: ['small', 'medium', 'large', 'enterprise'] })
  @IsOptional()
  @IsString()
  size?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Default space ID, or null to clear',
  })
  @IsOptional()
  @ValidateIf((o: UpdateOrganizationDto) => o.default_space_id !== null)
  @IsUUID()
  default_space_id?: string | null;
}
