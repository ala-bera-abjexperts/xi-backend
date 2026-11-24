import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';

const SUBMISSIONS_TABLE = 'form_builder_submissions';
const FORMS_TABLE = 'form_builder';
const FIELDS_TABLE = 'form_builder_fields';

// hard cap on rows aggregated in-app (no per-field-value index exists). Beyond this the
// response is flagged `truncated` and the UI shows a "based on the most recent N" notice.
const ANALYTICS_MAX_ROWS = 5000;
const PAGE_SIZE = 1000;
// cap distinct categories charted per field so a free-text-ish field can't bloat the payload.
const MAX_BUCKETS = 20;
const MAX_SAMPLES = 5;

// backend field-type → aggregation kind. FORM_FIELD_TYPE_INFO lives in the frontend package
// and is not importable here, so we keep a minimal local map.
type Kind = 'choice' | 'boolean' | 'numeric' | 'text' | 'datetime' | 'other';

const KIND_BY_TYPE: Record<string, Kind> = {
  dropdown: 'choice',
  radio: 'choice',
  checkboxes: 'choice',
  yes_no: 'boolean',
  number: 'numeric',
  rating: 'numeric',
  linear_scale: 'numeric',
  slider: 'numeric',
  nps: 'numeric',
  short_text: 'text',
  long_text: 'text',
  email: 'text',
  url: 'text',
  phone: 'text',
  date: 'datetime',
  datetime: 'datetime',
  time: 'datetime',
  date_range: 'datetime',
};

// layout / no-value types never charted.
const SKIP_TYPES = new Set([
  'heading',
  'paragraph',
  'divider',
  'page_break',
  'image',
  'hidden',
]);

interface Ctx {
  spaceId: string;
  orgId: string;
}

interface SubmissionRow {
  id: string;
  data: Record<string, unknown> | null;
  field_snapshot: unknown;
  created_at: string;
}

interface FieldMeta {
  field_key: string;
  field_type: string;
  label: string;
}

export interface FieldAnalytics {
  field_key: string;
  label: string;
  type: string;
  kind: Kind;
  responseCount: number;
  buckets?: Array<{ name: string; value: number }>;
  stats?: { count: number; avg: number; min: number; max: number };
  samples?: string[];
}

// Read-only response analytics. Aggregates submitted, non-test responses server-side (up to
// ANALYTICS_MAX_ROWS) and returns buckets — never raw rows. Field labels/types come from each
// submission's field_snapshot (drift-safe), supplemented by the form's live fields.
@Injectable()
export class FormBuilderAnalyticsService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getAnalytics(formId: string, ctx: Ctx, from?: string, to?: string) {
    await this.assertForm(formId, ctx);

    const total = await this.countSubmissions(formId, ctx, from, to);
    const rows = await this.loadSubmissions(formId, ctx, from, to);

    const fieldMeta = await this.buildFieldMeta(formId, ctx, rows);
    const fields = this.aggregateFields(fieldMeta, rows);
    const trend = this.buildTrend(rows);

    return {
      metrics: {
        total,
        sampleSize: rows.length,
        truncated: total > rows.length,
      },
      trend,
      fields,
    };
  }

  // internals

  private async assertForm(formId: string, ctx: Ctx): Promise<void> {
    const { data, error } = await this.client
      .from(FORMS_TABLE)
      .select('id')
      .eq('id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Form not found');
  }

  private async countSubmissions(
    formId: string,
    ctx: Ctx,
    from?: string,
    to?: string,
  ): Promise<number> {
    // reuse baseFilter by re-selecting head-only for a cheap exact count.
    let q = this.client
      .from(SUBMISSIONS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('form_id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .eq('status', 'submitted')
      .eq('is_test', false);

    if (from) q = q.gte('created_at', from);
    if (to) q = q.lte('created_at', to);

    const { count, error } = await q;

    if (error) throw new BadRequestException(error.message);

    return count ?? 0;
  }

  private async loadSubmissions(
    formId: string,
    ctx: Ctx,
    from?: string,
    to?: string,
  ): Promise<SubmissionRow[]> {
    const out: SubmissionRow[] = [];

    for (let offset = 0; offset < ANALYTICS_MAX_ROWS; offset += PAGE_SIZE) {
      const upper = Math.min(offset + PAGE_SIZE, ANALYTICS_MAX_ROWS) - 1;

      let q = this.client
        .from(SUBMISSIONS_TABLE)
        .select('id, data, field_snapshot, created_at')
        .eq('form_id', formId)
        .eq('space_id', ctx.spaceId)
        .eq('organization_id', ctx.orgId)
        .eq('status', 'submitted')
        // exclude builder previews / test submissions from analytics.
        .eq('is_test', false);

      if (from) q = q.gte('created_at', from);
      if (to) q = q.lte('created_at', to);

      const { data, error } = await q
        .order('created_at', { ascending: false })
        .range(offset, upper);

      if (error) throw new BadRequestException(error.message);

      const page = (data ?? []) as SubmissionRow[];

      out.push(...page);

      if (page.length < upper - offset + 1) break;
    }

    return out;
  }

  // canonical field list from the form's live fields, supplemented by any field_key seen in
  // a submission snapshot but no longer live (deleted after responses existed).
  private async buildFieldMeta(
    formId: string,
    ctx: Ctx,
    rows: SubmissionRow[],
  ): Promise<FieldMeta[]> {
    void ctx;

    const byKey = new Map<string, FieldMeta>();

    const { data: liveFields, error } = await this.client
      .from(FIELDS_TABLE)
      .select('field_key, field_type, label, sort_order')
      .eq('form_id', formId)
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    for (const f of (liveFields ?? []) as Array<{
      field_key: string;
      field_type: string;
      label: string | null;
    }>) {
      byKey.set(f.field_key, {
        field_key: f.field_key,
        field_type: f.field_type,
        label: f.label || f.field_key,
      });
    }

    // supplement from snapshots for deleted fields (labels can vary per submission — first
    // non-empty label wins).
    for (const row of rows) {
      const snapshot = Array.isArray(row.field_snapshot)
        ? (row.field_snapshot as Array<Record<string, unknown>>)
        : [];

      for (const f of snapshot) {
        const key = f.field_key as string | undefined;

        if (!key || byKey.has(key)) continue;

        byKey.set(key, {
          field_key: key,
          field_type: (f.field_type as string) || 'short_text',
          label: (f.label as string) || key,
        });
      }
    }

    return Array.from(byKey.values());
  }

  private aggregateFields(
    fieldMeta: FieldMeta[],
    rows: SubmissionRow[],
  ): FieldAnalytics[] {
    const out: FieldAnalytics[] = [];

    for (const meta of fieldMeta) {
      if (SKIP_TYPES.has(meta.field_type)) continue;

      const kind: Kind = KIND_BY_TYPE[meta.field_type] ?? 'other';
      const values = rows
        .map((r) => (r.data ?? {})[meta.field_key])
        .filter((v) => !this.isEmpty(v));

      const base: FieldAnalytics = {
        field_key: meta.field_key,
        label: meta.label,
        type: meta.field_type,
        kind,
        responseCount: values.length,
      };

      if (kind === 'choice') base.buckets = this.choiceBuckets(values);
      else if (kind === 'boolean') base.buckets = this.booleanBuckets(values);
      else if (kind === 'numeric') {
        base.stats = this.numericStats(values);
        base.buckets = this.numericBuckets(values);
      } else if (kind === 'text') base.samples = this.textSamples(values);
      else if (kind === 'datetime') base.buckets = this.choiceBuckets(values);

      out.push(base);
    }

    return out;
  }

  private buildTrend(
    rows: SubmissionRow[],
  ): Array<{ date: string; count: number }> {
    const byDay = new Map<string, number>();

    for (const r of rows) {
      const day = (r.created_at ?? '').slice(0, 10);

      if (!day) continue;

      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }

    return Array.from(byDay.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  private choiceBuckets(
    values: unknown[],
  ): Array<{ name: string; value: number }> {
    const counts = new Map<string, number>();

    for (const v of values) {
      if (Array.isArray(v)) {
        for (const item of v) this.bump(counts, this.toLabel(item));
      } else {
        this.bump(counts, this.toLabel(v));
      }
    }

    return this.topBuckets(counts);
  }

  private booleanBuckets(
    values: unknown[],
  ): Array<{ name: string; value: number }> {
    const counts = new Map<string, number>();

    for (const v of values) {
      const yes = v === true || v === 'yes' || v === 'Yes' || v === 'true';

      this.bump(counts, yes ? 'Yes' : 'No');
    }

    return this.topBuckets(counts);
  }

  private numericStats(values: unknown[]): {
    count: number;
    avg: number;
    min: number;
    max: number;
  } {
    const nums = values.map(Number).filter((n) => Number.isFinite(n));

    if (!nums.length) return { count: 0, avg: 0, min: 0, max: 0 };

    const sum = nums.reduce((a, b) => a + b, 0);

    return {
      count: nums.length,
      avg: Math.round((sum / nums.length) * 100) / 100,
      min: Math.min(...nums),
      max: Math.max(...nums),
    };
  }

  private numericBuckets(
    values: unknown[],
  ): Array<{ name: string; value: number }> {
    const counts = new Map<string, number>();

    for (const v of values) {
      const n = Number(v);

      if (Number.isFinite(n)) this.bump(counts, String(n));
    }

    return this.topBuckets(counts).sort(
      (a, b) => Number(a.name) - Number(b.name),
    );
  }

  private textSamples(values: unknown[]): string[] {
    const out: string[] = [];

    for (const v of values) {
      const s = this.toLabel(v).trim();

      if (s && !out.includes(s)) out.push(s);
      if (out.length >= MAX_SAMPLES) break;
    }

    return out;
  }

  private topBuckets(
    counts: Map<string, number>,
  ): Array<{ name: string; value: number }> {
    return Array.from(counts.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, MAX_BUCKETS);
  }

  private bump(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  private isEmpty(v: unknown): boolean {
    return (
      v === undefined ||
      v === null ||
      v === '' ||
      (Array.isArray(v) && v.length === 0)
    );
  }

  private toLabel(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return `${v}`;

    if (typeof v === 'object') {
      // option objects store the chosen value under `value`.
      const value = (v as { value?: unknown }).value;

      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean')
        return `${value}`;

      try {
        return JSON.stringify(v);
      } catch {
        return '';
      }
    }

    return '';
  }
}
