import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdateShareDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  can_view?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  can_create?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  can_delete?: boolean;

  @ApiPropertyOptional({
    description: 'New password. Pass null to remove the existing password.',
  })
  @IsOptional()
  @ValidateIf((o) => o.password !== null)
  @IsString()
  @MaxLength(100)
  password?: string | null;

  @ApiPropertyOptional({
    description: 'Expiry date (ISO 8601). Pass null to remove the expiry.',
  })
  @IsOptional()
  @ValidateIf((o) => o.expires_at !== null)
  @IsDateString()
  expires_at?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
