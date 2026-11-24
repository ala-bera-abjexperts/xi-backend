import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { RequestUser } from '../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { SlaAccessService } from './sla-access.service';
import { isSlaReference, loadSlaRuleOptions } from './sla-rule-options';
import { validateCalendar } from './sla-clock';
import { validateRules } from './sla-rules';
import { SlaFieldMetadata, SlaCalendar } from './sla.types';
interface FieldRow {
  id: string;
  name: string;
  field_type: string;
  scope: string;
  space_id: string;
  is_deleted?: boolean;
  contexts: string[];
  options?: unknown;
}
interface CalendarRow {
  id: string;
  current_revision_id: string;
  space_id: string;
  name: string;
}
interface MetricRow {
  id: string;
  current_revision_id: string;
  enabled: boolean;
}
interface DbError {
  code?: string;
  message?: string;
}

const FIELD_LABELS: Record<string, string> = {
  summary: 'Task title',
  status: 'Status',
  status_id: 'Status reference',
  priority: 'Priority',
  assigned_to: 'Assignee',
  created_by: 'Created by',
  task_type_id: 'Task type',
  parent_task_id: 'Parent task',
  request_id: 'Support request',
  created_at: 'Created on',
  due_date: 'Due date',
  start_date: 'Start date',
  completed_at: 'Completed on',
  is_completed: 'Task completed',
};
const BUILTINS: SlaFieldMetadata[] = [
  ...[
    'summary',
    'status',
    'status_id',
    'priority',
    'assigned_to',
    'created_by',
    'task_type_id',
    'parent_task_id',
    'request_id',
  ].map((id) => ({ id, type: 'string' as const })),
  ...['created_at', 'due_date', 'start_date', 'completed_at'].map((id) => ({
    id,
    type: 'date' as const,
  })),
  { id: 'is_completed', type: 'boolean' },
];
export function buildSlaFieldMetadata(
  fields: { id: string; field_type: string }[],
): SlaFieldMetadata[] {
  const types: Record<string, SlaFieldMetadata['type']> = {
    string: 'string',
    editor: 'string',
    multiselect: 'string[]',
    user_select: 'string',
    user_multi: 'string[]',
    radio: 'string',
    label: 'string[]',
    text: 'string',
    textarea: 'string',
    url: 'string',
    email: 'string',
    phone: 'string',
    select: 'string',
    single_select: 'string',
    number: 'number',
    currency: 'number',
    percent: 'number',
    checkbox: 'boolean',
    boolean: 'boolean',
    date: 'date',
    datetime: 'date',
    multi_select: 'string[]',
  };
  return [
    ...BUILTINS,
    ...fields
      .filter((f) => types[f.field_type])
      .map((f) => ({ id: `cf_${f.id}`, type: types[f.field_type] })),
  ];
}

export function validateMetricConfiguration(
  input: unknown,
  metadata: SlaFieldMetadata[],
  calendars: Set<string>,
) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('Invalid SLA configuration');
  const c = input as Record<string, unknown>;
  if (
    Object.keys(c).some(
      (k) =>
        ![
          'version',
          'cycle_mode',
          'fulfillment',
          'start',
          'pause',
          'stop',
          'goals',
        ].includes(k),
    ) ||
    (c.version !== undefined && c.version !== 1) ||
    !['once', 'on_reopen'].includes(String(c.cycle_mode)) ||
    !['condition', 'customer_reply'].includes(String(c.fulfillment))
  )
    throw new BadRequestException('Unsupported SLA configuration');
  if (c.fulfillment === 'customer_reply' && c.cycle_mode !== 'once')
    throw new BadRequestException('Customer first response is once per task');
  if (!Array.isArray(c.goals) || c.goals.length === 0 || c.goals.length > 100)
    throw new BadRequestException('Provide one to 100 ordered SLA goals');
  const condition = (value: unknown) =>
    value == null ? null : validateRules(value, metadata);
  const goals = (c.goals as unknown[]).map((value) => {
    const goal = value as Record<string, unknown>;
    if (
      !goal ||
      typeof goal !== 'object' ||
      typeof goal.id !== 'string' ||
      !goal.id ||
      goal.id.length > 100 ||
      typeof goal.target_ms !== 'number' ||
      !Number.isSafeInteger(goal.target_ms) ||
      goal.target_ms <= 0 ||
      goal.target_ms > 36600 * 86400000 ||
      typeof goal.calendar_revision_id !== 'string' ||
      !calendars.has(goal.calendar_revision_id)
    )
      throw new BadRequestException(
        'Invalid SLA goal or out-of-scope calendar revision',
      );
    return {
      id: goal.id,
      filter: condition(goal.filter),
      target_ms: goal.target_ms,
      calendar_revision_id: goal.calendar_revision_id,
    };
  });
  if (new Set(goals.map((g) => g.id)).size !== goals.length)
    throw new BadRequestException('SLA goal IDs must be unique');
  const stop = condition(c.stop);
  if (c.fulfillment === 'condition' && (!stop || stop.rules.length === 0))
    throw new BadRequestException(
      'A nonempty fulfillment condition is required',
    );
  return {
    version: 1,
    cycle_mode: c.cycle_mode as 'once' | 'on_reopen',
    fulfillment: c.fulfillment as 'condition' | 'customer_reply',
    start: condition(c.start),
    pause: condition(c.pause),
    stop,
    goals,
    field_metadata: structuredClone(metadata),
  };
}

@Injectable()
export class SlaConfigurationService {
  constructor(
    private readonly db: SupabaseAdminService,
    private readonly access: SlaAccessService,
  ) {}
  private get client() {
    return this.db.getClient();
  }
  private check(error: { code?: string; message?: string } | null) {
    if (!error) return;
    if (['40001', '23505', 'P0002'].includes(error.code ?? ''))
      throw new ConflictException(
        'SLA configuration changed; reload before saving',
      );
    if (error.code === '22023' || error.code === '23514')
      throw new BadRequestException('Invalid SLA configuration');
    throw new InternalServerErrorException(
      'Unable to persist SLA configuration',
    );
  }
  private async authorize(user: RequestUser, space: string) {
    await this.access.authorizeSpace(
      user,
      user.organizationId,
      space,
      'manage_sla',
    );
  }
  private async field(user: RequestUser, id: string) {
    const { data, error } = await this.client
      .from('custom_fields')
      .select('*')
      .eq('id', id)
      .eq('organization_id', user.organizationId)
      .returns<FieldRow[]>()
      .maybeSingle();
    this.check(error);
    if (
      !data ||
      data.is_deleted ||
      data.field_type !== 'sla_time' ||
      data.scope !== 'space' ||
      !data.space_id
    )
      throw new NotFoundException('SLA field not found');
    await this.authorize(user, data.space_id);
    return data;
  }
  private async metadata(user: RequestUser, space: string) {
    const { data, error } = await this.client
      .from('custom_fields')
      .select('id,name,field_type,contexts,options')
      .eq('organization_id', user.organizationId)
      .eq('space_id', space)
      .eq('is_active', true)
      .or('is_deleted.is.null,is_deleted.eq.false')
      .returns<FieldRow[]>();
    this.check(error);
    return {
      fields: data ?? [],
      metadata: buildSlaFieldMetadata(
        (data ?? []).filter(
          (f) =>
            !Array.isArray(f.contexts) ||
            !f.contexts.length ||
            f.contexts.includes('task'),
        ),
      ),
    };
  }
  async ruleFields(user: RequestUser, space: string) {
    await this.authorize(user, space);
    const { fields, metadata } = await this.metadata(user, space);
    return metadata.map((f) => ({
      name: f.id,
      label:
        fields.find((c) => `cf_${c.id}` === f.id)?.name ??
        FIELD_LABELS[f.id] ??
        f.id.replaceAll('_', ' '),
      ...(isSlaReference(
        f.id,
        fields.find((c) => `cf_${c.id}` === f.id),
      )
        ? { spaceId: space, multiple: f.type === 'string[]' }
        : {}),
      inputType: isSlaReference(
        f.id,
        fields.find((c) => `cf_${c.id}` === f.id),
      )
        ? 'sla-reference'
        : f.type === 'number'
          ? 'number'
          : f.type === 'date'
            ? 'date'
            : f.type === 'boolean'
              ? 'checkbox'
              : 'text',
      entityTypes: ['task'],
      operators: [
        ...['=', '!=', 'in', 'notIn', 'null', 'notNull'],
        ...(['number', 'date'].includes(f.type) ? ['<', '<=', '>', '>='] : []),
        ...(['string', 'string[]'].includes(f.type)
          ? ['contains', 'doesNotContain']
          : []),
        ...(f.type === 'string' ? ['beginsWith', 'endsWith'] : []),
      ].map((name) => ({ name, label: name })),
    }));
  }
  async ruleOptions(
    user: RequestUser,
    space: string,
    field: string,
    search = '',
    selected = '',
  ) {
    await this.authorize(user, space);
    if (
      typeof field !== 'string' ||
      field.length > 100 ||
      typeof search !== 'string' ||
      search.length > 200 ||
      typeof selected !== 'string' ||
      selected.length > 12000
    )
      throw new BadRequestException('Invalid SLA choice query');
    let parsed: unknown;
    try {
      parsed = selected.startsWith('[')
        ? JSON.parse(selected)
        : selected.split(',').filter(Boolean);
    } catch {
      throw new BadRequestException('Invalid SLA selections');
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((value) => typeof value !== 'string')
    )
      throw new BadRequestException('Invalid SLA selections');
    const ids = [...new Set(parsed as string[])];
    if (ids.length > 100 || ids.some((id) => id.length > 200))
      throw new BadRequestException('Too many SLA selections');
    const { fields, metadata } = await this.metadata(user, space);
    if (!metadata.some((row) => row.id === field))
      throw new BadRequestException('Unsupported SLA reference field');
    if (['parent_task_id', 'request_id'].includes(field))
      await this.access.authorizeSpace(
        user,
        user.organizationId,
        space,
        'view_tasks',
      );
    if (field === 'request_id')
      await this.access.authorizeSpace(
        user,
        user.organizationId,
        space,
        'publish_customer_replies',
      );
    return loadSlaRuleOptions(
      this.client,
      user.organizationId,
      space,
      field,
      fields,
      search,
      ids,
    );
  }
  async calendars(user: RequestUser, space: string) {
    await this.authorize(user, space);
    const { data, error } = await this.client
      .from('sla_calendars')
      .select('*')
      .eq('organization_id', user.organizationId)
      .eq('space_id', space)
      .order('name')
      .returns<CalendarRow[]>();
    this.check(error);
    if (!data?.length) return [];
    const revisions = await this.client
      .from('sla_calendar_revisions')
      .select('id,config')
      .eq('organization_id', user.organizationId)
      .eq('space_id', space)
      .in(
        'id',
        data.map((c) => c.current_revision_id),
      )
      .returns<{ id: string; config: SlaCalendar }[]>();
    this.check(revisions.error);
    return data.map((c) => ({
      ...c,
      revision: c.current_revision_id,
      config: revisions.data?.find((r) => r.id === c.current_revision_id)
        ?.config,
    }));
  }
  async saveCalendar(
    user: RequestUser,
    space: string | null,
    id: string | null,
    dto: { name: string; config: unknown; expected_revision?: string | null },
  ) {
    if (id) {
      const row = await this.client
        .from('sla_calendars')
        .select('space_id')
        .eq('id', id)
        .eq('organization_id', user.organizationId)
        .returns<{ space_id: string }[]>()
        .maybeSingle();
      this.check(row.error);
      if (!row.data) throw new NotFoundException('Calendar not found');
      space = row.data.space_id;
    }
    await this.authorize(user, space!);
    if (
      typeof dto.name !== 'string' ||
      !dto.name.trim() ||
      dto.name.length > 200
    )
      throw new BadRequestException('A calendar name is required');
    let config: SlaCalendar;
    try {
      config = validateCalendar(dto.config);
    } catch {
      throw new BadRequestException('Invalid SLA calendar');
    }
    const { data, error } = (await this.client.rpc('sla_save_calendar', {
      p_org: user.organizationId,
      p_space: space,
      p_calendar: id,
      p_expected_revision: dto.expected_revision ?? null,
      p_name: dto.name.trim(),
      p_config: config,
    })) as { data: CalendarRow | CalendarRow[]; error: DbError | null };
    this.check(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { ...row, revision: row.current_revision_id, config };
  }
  async getMetric(user: RequestUser, id: string) {
    const field = await this.field(user, id);
    const { data, error } = await this.client
      .from('sla_metrics')
      .select('*')
      .eq('field_id', id)
      .eq('organization_id', user.organizationId)
      .eq('space_id', field.space_id)
      .returns<MetricRow[]>()
      .maybeSingle();
    this.check(error);
    if (!data) return null;
    const revision = await this.client
      .from('sla_metric_revisions')
      .select('config')
      .eq('id', data.current_revision_id)
      .eq('organization_id', user.organizationId)
      .eq('space_id', field.space_id)
      .returns<{ config: Record<string, unknown> }[]>()
      .single();
    this.check(revision.error);
    const config = Object.fromEntries(
      Object.entries(revision.data!.config).filter(
        ([key]) => key !== 'field_metadata',
      ),
    );
    return { ...data, revision: data.current_revision_id, config };
  }
  async saveMetric(
    user: RequestUser,
    id: string,
    dto: { config: unknown; expected_revision?: string | null },
  ) {
    const field = await this.field(user, id);
    const { metadata } = await this.metadata(user, field.space_id);
    const revisions = await this.client
      .from('sla_calendar_revisions')
      .select('id')
      .eq('organization_id', user.organizationId)
      .eq('space_id', field.space_id)
      .returns<{ id: string }[]>();
    this.check(revisions.error);
    let config: ReturnType<typeof validateMetricConfiguration>;
    try {
      config = validateMetricConfiguration(
        dto.config,
        metadata,
        new Set((revisions.data ?? []).map((r) => r.id)),
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid SLA conditions',
      );
    }
    const saved = await this.client.rpc('sla_save_metric', {
      p_org: user.organizationId,
      p_space: field.space_id,
      p_field: id,
      p_expected_revision: dto.expected_revision ?? null,
      p_config: config,
    });
    this.check(saved.error);
    return this.getMetric(user, id);
  }
  async setEnabled(
    user: RequestUser,
    id: string,
    enabled: boolean,
    expectedRevision: string,
  ) {
    const metric = await this.getMetric(user, id);
    if (!metric)
      throw new BadRequestException(
        'Save the SLA configuration before activation',
      );
    const result = await this.client.rpc('sla_set_metric_enabled', {
      p_metric_id: metric.id,
      p_expected_revision: expectedRevision,
      p_enabled: enabled,
    });
    this.check(result.error);
    return this.getMetric(user, id);
  }
}
