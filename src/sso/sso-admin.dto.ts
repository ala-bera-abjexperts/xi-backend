/**
 * @fileoverview Request bodies for the SSO administration API (XE-T346).
 * @module src/sso/sso-admin.dto
 */

import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class CreateSsoConnectionDto {
  @ApiProperty({ example: 'Microsoft Entra ID', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  display_name!: string;

  @ApiProperty({
    description: 'IdP Entity ID (the SAML Issuer)',
    example: 'https://sts.windows.net/00000000-0000-0000-0000-000000000000/',
  })
  @IsString()
  @Length(1, 1000)
  idp_entity_id!: string;

  @ApiProperty({
    description: 'IdP single sign-on URL',
    example:
      'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/saml2',
  })
  @IsString()
  @MaxLength(2000)
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  })
  idp_sso_url!: string;

  @ApiProperty({
    description:
      'IdP signing certificates as PEM, with or without BEGIN/END lines',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(20000, { each: true })
  idp_certs!: string[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_enabled?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'Create accounts and memberships on first SSO login',
  })
  @IsOptional()
  @IsBoolean()
  jit_enabled?: boolean;
}

export class UpdateSsoConnectionDto extends PartialType(
  CreateSsoConnectionDto,
) {}

export class AddSsoDomainDto {
  @ApiProperty({ example: 'example.com' })
  @IsString()
  @Length(1, 253)
  domain!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  connection_id?: string | null;
}

export class UpdateSsoDomainDto {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'Connection allowed to sign in this domain, or null to unbind',
  })
  @ValidateIf((_dto, value) => value !== null)
  @IsUUID()
  connection_id!: string | null;
}

export class CreateScimTokenDto {
  @ApiProperty({ example: 'Microsoft Entra ID provisioning', maxLength: 100 })
  @IsString()
  @Length(1, 100)
  label!: string;
}

export class UpdateSsoSettingsDto {
  @ApiProperty()
  @IsBoolean()
  require_sso!: boolean;
}
