import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

// Per-space Stripe connection. The publishable key is NOT secret (returned to the anonymous fill
// page); the secret + webhook secret are write-only, encrypted at rest, never returned.
// Omitting a secret on update keeps the stored one (blank-to-keep).
export class SavePaymentConfigDto {
  @ApiPropertyOptional({ description: 'Stripe publishable key (pk_...).' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  publishableKey?: string;

  @ApiPropertyOptional({
    description: 'Stripe secret key (sk_...). Write-only.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  secretKey?: string;

  @ApiPropertyOptional({
    description: 'Stripe webhook signing secret (whsec_...). Write-only.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  webhookSecret?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
