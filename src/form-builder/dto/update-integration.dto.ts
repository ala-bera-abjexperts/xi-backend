import { OmitType, PartialType } from '@nestjs/swagger';

import { CreateIntegrationDto } from './create-integration.dto';

// All fields optional; `provider` can't change. A provided non-empty `credential` re-encrypts and
// replaces the stored one; an omitted `credential` leaves the existing one untouched.
export class UpdateIntegrationDto extends PartialType(
  OmitType(CreateIntegrationDto, ['provider'] as const),
) {}
