import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_TASK_HIERARCHY_CONFIG } from '../task-hierarchy-config/models/task-hierarchy-config.model';

type Option = { name: string; label: string; unavailable?: boolean };
type Field = { id: string; field_type: string; options?: unknown };
const references = new Set([
  'status',
  'status_id',
  'priority',
  'assigned_to',
  'created_by',
  'task_type_id',
  'parent_task_id',
  'request_id',
]);
const choiceTypes = new Set([
  'select',
  'single_select',
  'multiselect',
  'multi_select',
  'radio',
  'user_select',
  'user_multi',
]);
export function isSlaReference(field: string, custom?: Field) {
  return (
    references.has(field) || (!!custom && choiceTypes.has(custom.field_type))
  );
}
export function parseTicketNumberSearch(search: string): string | null {
  const digits = /^(?:#\s*)?(\d{1,19})$/.exec(search.trim())?.[1];
  if (!digits || BigInt(digits) > 9223372036854775807n) return null;
  return BigInt(digits).toString();
}
function check(error: unknown) {
  if (error)
    throw new InternalServerErrorException('Unable to load SLA choices');
}
function finish(
  rows: Option[],
  selected: string[],
  selectedRows: Option[] = [],
) {
  const unique = [...new Map(rows.map((row) => [row.name, row])).values()];
  const known = new Map(
    [...unique, ...selectedRows].map((row) => [row.name, row]),
  );
  const page = unique.slice(0, 50);
  return {
    options: [
      ...page,
      ...selected
        .filter((name) => !page.some((row) => row.name === name))
        .map(
          (name) =>
            known.get(name) ?? {
              name,
              label: 'Unavailable selection',
              unavailable: true,
            },
        ),
    ],
    hasMore: rows.length > 50,
  };
}

/** Bounded typeahead; selected hydration uses the same tenant/scope filters. */
export async function loadSlaRuleOptions(
  db: SupabaseClient,
  organization: string,
  space: string,
  field: string,
  fields: Field[],
  search: string,
  selected: string[],
) {
  const custom = fields.find((row) => `cf_${row.id}` === field);
  if (!isSlaReference(field, custom))
    throw new BadRequestException('Unsupported SLA reference field');
  const needle = search.trim().toLocaleLowerCase();
  const literal = `%${search.trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  if (custom && !['user_select', 'user_multi'].includes(custom.field_type)) {
    const options = (
      Array.isArray(custom.options) ? custom.options : []
    ).flatMap((row: unknown): Option[] => {
      if (!row || typeof row !== 'object') return [];
      const option = row as { value?: unknown; label?: unknown };
      return typeof option.value === 'string' &&
        typeof option.label === 'string'
        ? [{ name: option.value, label: option.label }]
        : [];
    });
    return finish(
      options.filter((row) => row.label.toLocaleLowerCase().includes(needle)),
      selected,
      options,
    );
  }
  if (field === 'task_type_id') {
    const { data, error } = await db
      .from('task_hierarchy_configurations')
      .select('config')
      .eq('organization_id', organization)
      .eq('space_id', space)
      .maybeSingle();
    check(error);
    const levels = data?.config?.levels ?? DEFAULT_TASK_HIERARCHY_CONFIG.levels;
    const options = (Array.isArray(levels) ? levels : [])
      .filter(
        (row) =>
          row.is_active !== false &&
          typeof row.id === 'string' &&
          typeof row.name === 'string',
      )
      .map((row) => ({ name: row.id as string, label: row.name as string }));
    return finish(
      options.filter((row) => row.label.toLocaleLowerCase().includes(needle)),
      selected,
      options,
    );
  }
  const users = ['assigned_to', 'created_by'].includes(field) || !!custom;
  const task = field === 'parent_task_id';
  const request = field === 'request_id';
  const table = users
    ? 'organization_members'
    : task
      ? 'tasks'
      : request
        ? 'support_requests'
        : field === 'priority'
          ? 'task_priorities'
          : 'task_statuses';
  const columns = users
    ? 'user_id,users:users!inner(id,first_name,last_name,email)'
    : task
      ? 'id,key,summary'
      : request
        ? 'id,ticket_number,subject'
        : 'id,key,name';
  const key = users
    ? 'user_id'
    : ['status', 'priority'].includes(field)
      ? 'key'
      : 'id';
  const searchColumns = users
    ? ['first_name', 'last_name', 'email']
    : task
      ? ['key', 'summary']
      : request
        ? ['ticket_number', 'subject']
        : ['name'];
  const base = () => {
    let query = db
      .from(table)
      .select(columns)
      .eq('organization_id', organization);
    if (!users) {
      query =
        task || request
          ? query.eq('space_id', space)
          : query.or(`space_id.is.null,space_id.eq.${space}`);
      if (task) query = query.eq('is_archived', false);
      else if (!request) query = query.eq('is_active', true);
    }
    return query;
  };
  const format = (rows: unknown[]): Option[] =>
    rows.flatMap((value) => {
      const row = value as Record<string, any>;
      const person = users
        ? Array.isArray(row.users)
          ? row.users[0]
          : row.users
        : null;
      const name = users ? person?.id : row[key];
      const fullName = [person?.first_name, person?.last_name]
        .filter(Boolean)
        .join(' ');
      const label = users
        ? fullName && person?.email
          ? `${fullName} (${person.email})`
          : fullName || person?.email
        : task
          ? [row.key, row.summary].filter(Boolean).join(': ')
          : request
            ? [row.ticket_number, row.subject].filter(Boolean).join(': ')
            : row.name;
      return typeof name === 'string' && typeof label === 'string'
        ? [{ name, label }]
        : [];
    });
  const ticketNumber = request ? parseTicketNumberSearch(search) : null;
  const searches = search.trim()
    ? request && ticketNumber === null
      ? ['subject']
      : searchColumns
    : [searchColumns[0]];
  const pages = await Promise.all(
    searches.map(async (column) => {
      let query = base();
      if (search.trim())
        query =
          request && column === 'ticket_number'
            ? query.eq('ticket_number', ticketNumber)
            : query.ilike(users ? `users.${column}` : column, literal);
      query = users
        ? query.order('user_id')
        : query.order(searchColumns[0]).order(key);
      const { data, error } = await query.limit(51);
      check(error);
      return format(data ?? []);
    }),
  );
  let selectedRows: Option[] = [];
  if (selected.length) {
    // UUID-backed references reject non-UUID historic substrings as unavailable,
    // instead of letting Postgres reject the entire choice request.
    const ids =
      key === 'id' || users
        ? selected.filter((value) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              value,
            ),
          )
        : selected;
    // Task type identifiers and custom choices are resolved above, not as UUIDs.
    if (ids.length) {
      const { data, error } = await base().in(key, ids).limit(100);
      check(error);
      selectedRows = format(data ?? []);
    }
  }
  const rows = [
    ...new Map(pages.flat().map((row) => [row.name, row])).values(),
  ].sort((a, b) => a.label.localeCompare(b.label));
  const result = finish(rows, selected, selectedRows);
  return {
    ...result,
    hasMore: result.hasMore || pages.some((page) => page.length > 50),
  };
}
