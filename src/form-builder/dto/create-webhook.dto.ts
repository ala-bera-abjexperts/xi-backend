import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// the only event emitted today; kept as an allow-list so a client can't register a hook
// for an event that will never fire.
export const WEBHOOK_EVENTS = ['submission.created'] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

// integration presets. JSON providers (generic/zapier/make/n8n) post the full payload;
// chat providers (slack/discord/teams/googlechat/mattermost) post a formatted message to an
// incoming-webhook URL. All ride the same delivery queue — only the request body differs
// (see FormBuilderWebhookDispatcherService.formatChatBody).
export const WEBHOOK_PROVIDERS = [
  'generic',
  'slack',
  'discord',
  'teams',
  'googlechat',
  'mattermost',
  'rocketchat',
  'zohocliq',
  'webex',
  'telegram',
  'zapier',
  'make',
  'n8n',
  'pipedream',
  'ifttt',
  'powerautomate',
  'airtable',
  'googlesheets',
] as const;

export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

// The URL is only shape-validated here; the real SSRF/HTTPS check is
// assertPublicHttpUrl() in the service (both at save and at fire time). The global
// ValidationPipe (whitelist + forbidNonWhitelisted) strips org/space/id if a client sends
// them.
export class CreateWebhookDto {
  @ApiPropertyOptional({ enum: WEBHOOK_PROVIDERS, default: 'generic' })
  @IsOptional()
  @IsIn(WEBHOOK_PROVIDERS as unknown as string[])
  provider?: WebhookProvider;

  @ApiProperty({ description: 'HTTPS endpoint that receives the POST' })
  @IsString()
  @MaxLength(2000)
  url!: string;

  @ApiPropertyOptional({ enum: WEBHOOK_EVENTS, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn(WEBHOOK_EVENTS as unknown as string[], { each: true })
  events?: WebhookEvent[];

  @ApiPropertyOptional({
    description: 'Optional HMAC signing secret (write-only)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  secret?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
