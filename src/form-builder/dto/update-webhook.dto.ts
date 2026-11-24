import { PartialType } from '@nestjs/swagger';

import { CreateWebhookDto } from './create-webhook.dto';

// All fields optional. A provided non-empty `secret` re-encrypts and replaces the stored
// one; an omitted `secret` leaves the existing secret untouched.
export class UpdateWebhookDto extends PartialType(CreateWebhookDto) {}
