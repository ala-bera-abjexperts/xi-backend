import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { SlaAccessService } from './sla-access.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { validateRules } from './sla-rules';
import { buildSlaFieldMetadata } from './sla-configuration.service';

export function normalizeSlaReport(
  config: Record<string, unknown>,
  offset = 0,
) {
  const preset = config.slaPreset;
  if (
    !['completed_pie', 'completed_timeline', 'active_breached'].includes(
      String(preset),
    )
  )
    throw new BadRequestException('Invalid SLA preset');
  if (typeof config.slaSpaceId !== 'string' || !isUUID(config.slaSpaceId))
    throw new BadRequestException('Select an SLA space');
  const metrics = config.slaMetricIds;
  if (
    !Array.isArray(metrics) ||
    metrics.length > 100 ||
    metrics.some((id) => typeof id !== 'string' || !isUUID(id))
  )
    throw new BadRequestException('Invalid SLA metrics');
  const timezone = config.slaTimezone;
  try {
    if (typeof timezone !== 'string' || !timezone) throw new Error();
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new BadRequestException('Invalid reporting timezone');
  }
  const from = config.slaDateFrom;
  const to = config.slaDateTo;
  for (const value of [from, to]) {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      throw new BadRequestException('Invalid completion date range');
  }
  if (
    String(from) > String(to) ||
    Date.parse(String(to)) - Date.parse(String(from)) > 3660 * 86400000
  )
    throw new BadRequestException(
      'Completion date range must be ordered and at most ten years',
    );
  const bucket = config.slaBucket ?? 'month';
  if (!['day', 'week', 'month'].includes(String(bucket)))
    throw new BadRequestException('Invalid SLA bucket');
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000000)
    throw new BadRequestException('Invalid SLA page');
  const limit = config.pageSize ?? 20;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 5 ||
    limit > 100
  )
    throw new BadRequestException('Invalid SLA page size');
  return {
    preset,
    spaceId: config.slaSpaceId,
    metrics,
    timezone,
    from,
    to,
    bucket,
    offset,
    limit,
  };
}

@Injectable()
export class SlaReportService {
  constructor(
    private readonly admin: SupabaseAdminService,
    private readonly access: SlaAccessService,
  ) {}
  async options(user: RequestUser, spaceId: string) {
    await this.access.authorizeSpace(
      user,
      user.organizationId,
      spaceId,
      'view_tasks',
    );
    await this.access.authorizeSpace(
      user,
      user.organizationId,
      spaceId,
      'view_sla',
    );
    const db = this.admin.getClient();
    const [fields, metrics] = await Promise.all([
      db
        .from('custom_fields')
        .select('id,name,field_key,field_type')
        .eq('organization_id', user.organizationId)
        .eq('is_active', true)
        .eq('is_deleted', false)
        .or(`space_id.is.null,space_id.eq.${spaceId}`),
      db
        .from('sla_metrics')
        .select('id,field_id')
        .eq('organization_id', user.organizationId)
        .eq('space_id', spaceId),
    ]);
    if (fields.error || metrics.error)
      throw new InternalServerErrorException('Unable to load report options');
    return {
      metrics: (metrics.data ?? []).map((metric) => ({
        id: metric.id,
        name:
          fields.data?.find((field) => field.id === metric.field_id)?.name ??
          'SLA metric',
      })),
      fields: buildSlaFieldMetadata(fields.data ?? []).map((field) => ({
        name: field.id,
        label:
          fields.data?.find((f) => `cf_${f.id}` === field.id)?.name ??
          field.id.replaceAll('_', ' '),
        inputType:
          field.type === 'number'
            ? 'number'
            : field.type === 'date'
              ? 'date'
              : field.type === 'boolean'
                ? 'checkbox'
                : 'text',
        entityTypes: ['task'],
        operators: [
          '=',
          '!=',
          'in',
          'notIn',
          'null',
          'notNull',
          ...(['number', 'date'].includes(field.type)
            ? ['<', '<=', '>', '>=']
            : []),
        ].map((name) => ({ name, label: name })),
      })),
    };
  }

  async report(
    organizationId: string,
    userId: string,
    config: Record<string, unknown>,
    offset = 0,
  ) {
    const query = normalizeSlaReport(config, offset);
    const user = { organizationId, userId } as RequestUser;
    await this.access.authorizeSpace(
      user,
      organizationId,
      query.spaceId,
      'view_tasks',
    );
    await this.access.authorizeSpace(
      user,
      organizationId,
      query.spaceId,
      'view_sla',
    );
    const db = this.admin.getClient();
    const { data: fields, error: fieldsError } = await db
      .from('custom_fields')
      .select('id,field_key,field_type')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .eq('is_deleted', false)
      .or(`space_id.is.null,space_id.eq.${query.spaceId}`);
    if (fieldsError)
      throw new InternalServerErrorException(
        'Unable to validate report fields',
      );
    const metadata = buildSlaFieldMetadata(fields ?? []);
    let filter: unknown = null;
    if (config.slaFilter != null) {
      try {
        filter = {
          query: validateRules(config.slaFilter, metadata),
          fields: metadata.map((field) => ({
            ...field,
            key: fields?.find((f) => `cf_${f.id}` === field.id)?.field_key,
          })),
        };
      } catch (error) {
        throw new BadRequestException((error as Error).message);
      }
    }
    const { data, error } = await db.rpc('sla_report', {
      p_organization_id: organizationId,
      p_space_id: query.spaceId,
      p_metric_ids: query.metrics,
      p_preset: query.preset,
      p_timezone: query.timezone,
      p_date_from: query.from,
      p_date_to: query.to,
      p_bucket: query.bucket,
      p_filter: filter,
      p_offset: query.offset,
      p_limit: query.limit,
    });
    if (error)
      throw new InternalServerErrorException('Unable to load SLA report');
    const rows = Array.isArray(data?.rows)
      ? (data.rows as Record<string, unknown>[])
      : [];
    const ownerIds = [
      ...new Set(
        rows.flatMap((row) =>
          typeof row.owner === 'string' && row.owner ? [row.owner] : [],
        ),
      ),
    ];
    if (!ownerIds.length)
      return {
        ...data,
        rows: rows.map((row) => ({ ...row, owner_name: null })),
      };
    const owners = await db
      .from('users')
      .select('id,first_name,last_name,email')
      .in('id', ownerIds);
    if (owners.error)
      throw new InternalServerErrorException('Unable to load SLA task owners');
    const names = new Map(
      (owners.data ?? []).map((owner) => [
        owner.id,
        [owner.first_name, owner.last_name].filter(Boolean).join(' ').trim() ||
          owner.email ||
          'User',
      ]),
    );
    return {
      ...data,
      rows: rows.map((row) => ({
        ...row,
        owner_name:
          typeof row.owner === 'string' ? (names.get(row.owner) ?? null) : null,
      })),
    };
  }
}
