/**
 * @fileoverview Body for adding a restore destination.
 * @module src/backup/dto/restore-destination.dto
 *
 * Required even where fields are optional: the global ValidationPipe runs with `whitelist` and
 * `forbidNonWhitelisted`, so a POST carrying a key no DTO declares is a 400.
 *
 * The service-role key travels in the body, never the URL, where it would reach browser history,
 * proxy logs and the referrer header. The owning organization is never a field — it comes from the
 * session, because a body-supplied tenant is a tenant boundary the caller gets to choose.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateRestoreDestinationDto {
  @ApiProperty({ description: 'What the operator will see in the picker.' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    enum: ['this_instance', 'supabase'],
    description:
      "`this_instance` writes through the server's own client. `supabase` opens a second one.",
  })
  @IsIn(['this_instance', 'supabase'])
  kind!: 'this_instance' | 'supabase';

  @ApiPropertyOptional({
    description: 'Required for `supabase`. Must be https.',
  })
  @IsOptional()
  // `require_tld: false` so a self-hosted Supabase on an internal hostname is not rejected; the
  // service still refuses anything that is not an https origin.
  @IsUrl({ protocols: ['https'], require_tld: false })
  @MaxLength(2048)
  supabase_url?: string;

  @ApiPropertyOptional({
    description:
      'Service-role key for that instance. Sealed at rest and never returned by the API.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  service_key?: string;

  @ApiPropertyOptional({
    description:
      "Tenant to write into. Omit for the archive's own. A different one requires `supabase`.",
  })
  @IsOptional()
  @IsUUID()
  target_organization_id?: string;
}

/**
 * Body for listing the organizations that exist on a destination, before it is saved.
 *
 * The picker has to be filled in while the operator is still typing the connection, so this takes
 * the credentials directly rather than a destination id. Same channel as create: the key is in the
 * body, over https, and is never written down by this call.
 */
export class ProbeDestinationOrganizationsDto {
  @ApiProperty({
    description: 'The instance to read organizations from. Must be https.',
  })
  @IsUrl({ protocols: ['https'], require_tld: false })
  @MaxLength(2048)
  supabase_url!: string;

  @ApiProperty({
    description:
      'Service-role key for that instance. Used for this request and not stored.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  service_key!: string;
}
