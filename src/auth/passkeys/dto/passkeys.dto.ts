import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
  ValidateBy,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const MAX_CREDENTIAL_ID_LENGTH = 2048;
const MAX_CLIENT_DATA_LENGTH = 16 * 1024;
const MAX_AUTHENTICATOR_DATA_LENGTH = 16 * 1024;
const MAX_ATTESTATION_OBJECT_LENGTH = 128 * 1024;
const MAX_SIGNATURE_LENGTH = 16 * 1024;
const MAX_EXTENSION_RESULTS_BYTES = 16 * 1024;

function IsBoundedObject(maxBytes: number): PropertyDecorator {
  return ValidateBy({
    name: 'isBoundedObject',
    constraints: [maxBytes],
    validator: {
      validate(value: unknown): boolean {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return false;
        }

        try {
          return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes;
        } catch {
          return false;
        }
      },
      defaultMessage: () => 'clientExtensionResults is too large',
    },
  });
}

class PasskeyCredentialResponseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_CLIENT_DATA_LENGTH)
  clientDataJSON!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_AUTHENTICATOR_DATA_LENGTH)
  authenticatorData?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ATTESTATION_OBJECT_LENGTH)
  attestationObject?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SIGNATURE_LENGTH)
  signature?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  userHandle?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'], {
    each: true,
  })
  transports?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(16 * 1024)
  publicKey?: string;

  @IsOptional()
  @IsInt()
  @Min(-65535)
  @Max(65535)
  publicKeyAlgorithm?: number;
}

export class PasskeyCredentialDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_CREDENTIAL_ID_LENGTH)
  id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_CREDENTIAL_ID_LENGTH)
  rawId!: string;

  @Equals('public-key')
  type!: 'public-key';

  @IsOptional()
  @IsIn(['platform', 'cross-platform'])
  authenticatorAttachment?: 'platform' | 'cross-platform';

  @IsObject()
  @IsBoundedObject(MAX_EXTENSION_RESULTS_BYTES)
  clientExtensionResults!: Record<string, unknown>;

  @IsObject()
  @ValidateNested()
  @Type(() => PasskeyCredentialResponseDto)
  response!: PasskeyCredentialResponseDto;
}

export class VerifyPasskeyRegistrationDto {
  @IsUUID()
  challengeId!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, {
    message: 'friendlyName must contain a non-whitespace character',
  })
  @MaxLength(120)
  friendlyName!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => PasskeyCredentialDto)
  credential!: PasskeyCredentialDto;
}

export class VerifyPasskeyAuthenticationDto {
  @IsUUID()
  challengeId!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => PasskeyCredentialDto)
  credential!: PasskeyCredentialDto;
}

export class RenamePasskeyDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, {
    message: 'friendlyName must contain a non-whitespace character',
  })
  @MaxLength(120)
  friendlyName!: string;
}

export class PasskeyIdParamDto {
  @IsUUID()
  passkeyId!: string;
}
