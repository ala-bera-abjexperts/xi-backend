import { Injectable, OnModuleInit } from '@nestjs/common';
import { appEventTriggers } from './actions/triggers/app-event';
import { scheduleTriggers } from './actions/triggers/schedule';
import { webhookTriggers } from './actions/triggers/webhook';
import { mailboxTriggers } from './actions/triggers/mailbox';

export interface CatalogTrigger {
  kind: string;
  category: 'app_event' | 'schedule' | 'webhook';
  type: 'trigger';
  label: { en: string; de?: string };
  description?: { en: string; de?: string };
  icon: string;
  configSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  requiresConnection?: string;
}

@Injectable()
export class AutomationTriggerCatalogService implements OnModuleInit {
  private readonly map = new Map<string, CatalogTrigger>();

  onModuleInit(): void {
    [
      ...appEventTriggers,
      ...scheduleTriggers,
      ...webhookTriggers,
      ...mailboxTriggers,
    ].forEach((def) => this.map.set(def.kind, def));
  }

  getCatalog(): CatalogTrigger[] {
    return Array.from(this.map.values());
  }

  get(kind: string): CatalogTrigger | undefined {
    return this.map.get(kind);
  }

  has(kind: string): boolean {
    return this.map.has(kind);
  }

  getOutputSchema(kind: string): Record<string, unknown> | undefined {
    return this.map.get(kind)?.outputSchema;
  }
}
