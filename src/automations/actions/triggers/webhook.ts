import type { CatalogTrigger } from '../../automation-trigger-catalog.service';

export const webhookReceivedTrigger: CatalogTrigger = {
  kind: 'webhook.received',
  category: 'webhook',
  type: 'trigger',
  label: { en: 'Webhook received', de: 'Webhook empfangen' },
  description: {
    en: 'Triggered by an HTTP POST to a unique automation URL',
    de: 'Wird durch einen HTTP-POST an eine eindeutige Automatisierungs-URL ausgelöst',
  },
  icon: 'bx-link-external',
  configSchema: {
    type: 'object',
    properties: {
      requireSignature: {
        type: 'boolean',
        title: 'Require signature',
        default: false,
        description:
          'When enabled, requests must include a valid HMAC signature — recommended for production',
      },
      signatureAlgorithm: {
        type: 'string',
        title: 'Signature algorithm',
        enum: ['hmac-sha256', 'hmac-sha1', 'hmac-sha512', 'bearer'],
        default: 'hmac-sha256',
        description:
          'hmac-sha256 = x-hub-signature-256 (GitHub-style) · hmac-sha1 = x-hub-signature · bearer = Authorization: Bearer <secret>',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      body: { title: 'Request body (parsed JSON or raw string)' },
      headers: {
        type: 'object',
        title: 'Request headers',
        additionalProperties: { type: 'string' },
      },
      method: { type: 'string', title: 'HTTP method' },
      receivedAt: { type: 'string', title: 'Received at (ISO datetime)' },
    },
  },
};

export const webhookTriggers: CatalogTrigger[] = [webhookReceivedTrigger];
