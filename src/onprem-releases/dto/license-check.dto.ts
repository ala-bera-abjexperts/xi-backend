/**
 * @fileoverview Request body for the on-prem licence check endpoint.
 * @module onprem-releases/dto/license-check.dto
 *
 * Author: Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

/** Users and version the box reports, for billing and oversight. */
export class OnpremUsageDto {
  @ApiProperty()
  @IsInt()
  @Min(0)
  activeUsers!: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  totalUsers!: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @Length(0, 64)
  version?: string | null;
}

export class LicenseCheckDto {
  /**
   * The installation's activation code. This is the credential: it is minted
   * SaaS-side per installation and delivered to the box through client.conf.
   */
  @ApiProperty({ description: 'Per-installation activation code (uuid).' })
  @IsString()
  @Length(8, 128)
  activationCode!: string;

  /**
   * Client-generated freshness proof, echoed back inside the signature.
   *
   * Without it a signature alone does not prove the answer is current: the
   * customer controls DNS and could re-serve a captured valid response forever.
   * Constrained to hex/base64url so it cannot smuggle structure into the
   * signed payload.
   */
  @ApiPropertyOptional({ description: 'Nonce echoed into the signed payload.' })
  @IsOptional()
  @IsString()
  @Length(16, 128)
  @Matches(/^[A-Za-z0-9_-]+$/)
  nonce?: string;

  @ApiPropertyOptional({ description: 'Release the box is running.' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  release?: string;

  /** Free-form diagnostics (hostname, container ids). Never trusted. */
  @ApiPropertyOptional({ description: 'Opaque host diagnostics.' })
  @IsOptional()
  @IsObject()
  hostInfo?: Record<string, unknown>;

  /**
   * Box identity (cloud-linked licensing). Optional so boxes on an older
   * release keep checking in; a box that sends them gets a licence bound to
   * its fingerprint.
   */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  installationId?: string | null;

  @ApiPropertyOptional({ description: 'sha256 hex of the box public key.' })
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/)
  fingerprint?: string;

  @ApiPropertyOptional({ description: 'Box public key, base64 SPKI DER.' })
  @IsOptional()
  @IsString()
  @Length(40, 200)
  publicKey?: string;

  @ApiPropertyOptional({ type: OnpremUsageDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OnpremUsageDto)
  usage?: OnpremUsageDto;
}
