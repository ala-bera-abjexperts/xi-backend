/** Immutable JSON snapshots used by the SLA clock and condition evaluator. */
export interface SlaCalendar {
  id?: string;
  timezone: string;
  weekly: Record<number, { startMinute: number; endMinute: number }[]>;
  holidays: string[];
}
export interface SlaFieldMetadata {
  id: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'string[]';
  sla?: boolean;
}
export interface SlaRule {
  field: string;
  operator: string;
  value?: unknown;
}
export interface SlaRuleGroup {
  combinator: 'and' | 'or';
  not?: boolean;
  rules: (SlaRule | SlaRuleGroup)[];
}
