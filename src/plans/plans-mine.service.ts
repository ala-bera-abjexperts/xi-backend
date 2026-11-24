// MCP-facing, permission-constrained plan search backing the MCP `plan.search`
// tool.
//
// Unlike wiki-mine (which re-resolves accessible spaces itself), this service
// DELEGATES the entire authorization + filtering + pagination pipeline to the
// existing `PlansService.listPlans` (the same method the product's GET /plans
// uses): org always from the caller, org-wide path per-row gated by
// `userCanAccessPlan` (org admin/owner bypass → space membership +
// `view_plans` → per-plan `plan_permissions` ACL), archived excluded unless
// requested, offset pagination with a 500-row raw-fetch cap. No business logic
// is duplicated here — this wrapper only:
//   - resolves `spaceIdOrKey` (uuid or key) to an org-scoped space id,
//   - collapses the space-path ForbiddenException to an EMPTY result
//     (anti-probing: non-member and nonexistent spaces are indistinguishable),
//   - wraps the backend's page number in an opaque cursor,
//   - re-projects raw plan rows to a whitelisted, MCP-safe shape.
//
// Exposure rules: archived plans are excluded from search by default (opt-in
// via includeArchived, flagged `isArchived`). NEVER exposed: `settings`,
// `custom_field_values`, `filter_id`, RAG bookkeeping (`rag_set_by/at/
// manually`), `budget`/`currency`, `created_by`/creator (has email),
// `sort_order`, raw `organization_id`. The owner is reduced to {id, name} —
// no email, no avatar. The org comes from the authenticated RequestUser
// (never a parameter), so the caller cannot cross orgs.

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PlansService } from './plans.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

/** Max plan-search page size (clamped; MCP zod also rejects above this). */
const MAX_PLAN_SEARCH_LIMIT = 50;

/** Default plan-search page size when none supplied. */
const DEFAULT_PLAN_SEARCH_LIMIT = 20;

/** Snippet length (chars) of the plan description in search results. */
const PLAN_SNIPPET_CHARS = 200;

/** Hard cap on the description returned by getMyPlan (mirrors tasks). */
const MAX_PLAN_DESCRIPTION_CHARS = 50 * 1024;

/** Hard cap on the identifier length accepted by getMyPlan (defensive). */
const MAX_PLAN_IDENTIFIER_CHARS = 255;

/** Plan statuses accepted as a search filter (archived is NOT a filter value —
 * archived visibility is controlled solely by `includeArchived`). */
const SEARCHABLE_PLAN_STATUSES = new Set([
  'draft',
  'active',
  'on_hold',
  'completed',
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A whitelisted space reference embedded in a plan result. */
export interface PlanSpaceRef {
  id: string;
  key: string;
  name: string;
}

/** A whitelisted owner reference — display identity only, never email/avatar. */
export interface PlanOwnerRef {
  id: string;
  name: string;
}

/** One whitelisted plan from `searchMyPlans` (list shape). */
export interface MyPlanSearchItem {
  id: string;
  planKey: string | null;
  name: string;
  /** Short plain-text excerpt of the description — never the full body. */
  snippet: string;
  planType: string | null;
  status: string | null;
  ragStatus: string | null;
  progress: number | null;
  owner: PlanOwnerRef | null;
  space: PlanSpaceRef | null;
  isArchived: boolean;
  startDate: string | null;
  endDate: string | null;
  updatedAt: string;
}

/** The `searchMyPlans` payload. Never null; `plans:[]` when empty. */
export interface MyPlanSearchResult {
  plans: MyPlanSearchItem[];
  nextCursor?: string;
  total?: number;
}

/** The whitelisted, MCP-safe plan detail returned by `getMyPlan`. */
export interface MyPlanDetail {
  id: string;
  planKey: string | null;
  name: string;
  /** Plan description, capped at MAX_PLAN_DESCRIPTION_CHARS. */
  description: string;
  /** Present and true only when the description was cut at the cap. */
  descriptionTruncated?: boolean;
  planType: string | null;
  status: string | null;
  ragStatus: string | null;
  progress: number | null;
  owner: PlanOwnerRef | null;
  space: PlanSpaceRef | null;
  isArchived: boolean;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  riskCount: number;
  stakeholderCount: number;
}

/** The `getMyPlan` payload. */
export interface MyPlanResult {
  plan: MyPlanDetail;
}

/** The raw joined owner shape `PlansService.listPlans` selects. */
interface RawPlanOwner {
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
}

@Injectable()
export class PlansMineService {
  private static readonly SPACES = 'spaces';
  private readonly logger = new Logger(PlansMineService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly plansService: PlansService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Encode the backend page number as an opaque cursor. */
  private encodeCursor(page: number): string {
    return Buffer.from(`p:${page}`, 'utf8').toString('base64url');
  }

  /** Decode an opaque cursor to a page number; malformed/invalid → page 1. */
  private decodeCursor(cursor?: string): number {
    if (!cursor) return 1;

    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');

      if (!decoded.startsWith('p:')) return 1;

      const page = Number.parseInt(decoded.slice(2), 10);

      return Number.isFinite(page) && page >= 1 ? page : 1;
    } catch {
      return 1;
    }
  }

  /** Resolve a space UUID or key to a space id, scoped to the org (or null). */
  private async resolveSpaceIdOrKey(
    spaceIdOrKey: string,
    organizationId: string,
  ): Promise<string | null> {
    const isUuid = UUID_RE.test(spaceIdOrKey);

    const result = await this.client
      .from(PlansMineService.SPACES)
      .select('id')
      .eq(
        isUuid ? 'id' : 'key',
        isUuid ? spaceIdOrKey : spaceIdOrKey.toUpperCase(),
      )
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (result.error) return null;

    return (result.data as { id?: string } | null)?.id ?? null;
  }

  /** Batch-resolve whitelisted space refs for the page's distinct space ids. */
  private async fetchSpaceRefs(
    spaceIds: string[],
    organizationId: string,
  ): Promise<Map<string, PlanSpaceRef>> {
    const refs = new Map<string, PlanSpaceRef>();

    if (spaceIds.length === 0) return refs;

    const result = await this.client
      .from(PlansMineService.SPACES)
      .select('id, key, name')
      .eq('organization_id', organizationId)
      .in('id', spaceIds);

    if (result.error) {
      this.logger.warn(
        `fetchSpaceRefs: space lookup failed: ${result.error.message}`,
      );

      return refs;
    }

    for (const row of (result.data ?? []) as PlanSpaceRef[]) {
      refs.set(row.id, { id: row.id, key: row.key, name: row.name });
    }

    return refs;
  }

  /** Reduce the joined owner row to {id, name} — no email, no avatar. */
  private toOwnerRef(raw: unknown): PlanOwnerRef | null {
    const owner = raw as RawPlanOwner | null | undefined;

    if (!owner || typeof owner.id !== 'string' || owner.id.length === 0) {
      return null;
    }

    const name = [owner.first_name, owner.last_name]
      .filter((part): part is string => !!part)
      .join(' ')
      .trim();

    return { id: owner.id, name };
  }

  /** Whitelist one raw plan row into the MCP-safe list shape. */
  private toSearchItem(
    row: Record<string, unknown>,
    spaceRefs: Map<string, PlanSpaceRef>,
  ): MyPlanSearchItem {
    const spaceId = (row.space_id as string | null | undefined) ?? null;
    const description = (row.description as string | null | undefined) ?? '';

    return {
      id: String(row.id),
      planKey: (row.plan_key as string | null | undefined) ?? null,
      name: (row.name as string | undefined) ?? '',
      snippet: description.slice(0, PLAN_SNIPPET_CHARS),
      planType: (row.plan_type as string | null | undefined) ?? null,
      status: (row.status as string | null | undefined) ?? null,
      ragStatus: (row.rag_status as string | null | undefined) ?? null,
      progress:
        typeof row.progress === 'number' && Number.isFinite(row.progress)
          ? row.progress
          : null,
      owner: this.toOwnerRef(row.owner),
      space: spaceId ? (spaceRefs.get(spaceId) ?? null) : null,
      isArchived: row.is_archived === true,
      startDate: (row.start_date as string | null | undefined) ?? null,
      endDate: (row.end_date as string | null | undefined) ?? null,
      updatedAt: (row.updated_at as string | undefined) ?? '',
    };
  }

  // Permission-constrained plan search backing MCP `plan.search`.
  //
  // Delegates authorization, filtering, and pagination to
  // `PlansService.listPlans` and re-projects to the whitelisted shape. A
  // non-accessible or nonexistent `spaceIdOrKey`, an invalid `ownerId`, and a
  // denied space path all yield an EMPTY result (anti-probing), never an
  // error. The result is never null. The caller (org + ids) comes from the
  // authenticated user; no org parameter is ever accepted.
  async searchMyPlans(
    user: RequestUser,
    opts: {
      query?: string;
      spaceIdOrKey?: string;
      status?: string;
      ownerId?: string;
      includeArchived?: boolean;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<MyPlanSearchResult> {
    if (!user.organizationId) {
      return { plans: [] };
    }

    // Sanitize exactly like PlansService.listOrganizationPlans to prevent
    // PostgREST filter injection. An empty/absent query lists accessible plans.
    const safe = (opts.query ?? '').replace(/[,.()"'\\]/g, '').trim();

    // Status is a closed enum here; anything else (incl. 'archived') → empty.
    if (opts.status && !SEARCHABLE_PLAN_STATUSES.has(opts.status)) {
      return { plans: [] };
    }

    // Owner filter: 'me' aliases the caller; otherwise a UUID is required
    // (prevents PostgREST errors from malformed values and keeps failures
    // indistinguishable from no-matches).
    let ownerId: string | undefined;

    if (opts.ownerId) {
      if (opts.ownerId === 'me') {
        ownerId = user.userId;
      } else if (UUID_RE.test(opts.ownerId)) {
        ownerId = opts.ownerId;
      } else {
        return { plans: [] };
      }
    }

    let spaceId: string | undefined;

    if (opts.spaceIdOrKey) {
      const resolved = await this.resolveSpaceIdOrKey(
        opts.spaceIdOrKey,
        user.organizationId,
      );

      // Nonexistent space yields empty (cannot probe existence).
      if (!resolved) {
        return { plans: [] };
      }

      spaceId = resolved;
    }

    const page = this.decodeCursor(opts.cursor);
    const requestedLimit = Number.isFinite(opts.limit)
      ? (opts.limit as number)
      : DEFAULT_PLAN_SEARCH_LIMIT;
    const pageSize = Math.min(
      Math.max(1, requestedLimit),
      MAX_PLAN_SEARCH_LIMIT,
    );

    let listed: Awaited<ReturnType<PlansService['listPlans']>>;

    try {
      listed = await this.plansService.listPlans(
        user.organizationId,
        user.userId,
        {
          space_id: spaceId,
          search: safe || undefined,
          status: opts.status,
          owner_id: ownerId,
          is_archived: opts.includeArchived === true,
          page,
          pageSize,
        },
      );
    } catch (err) {
      // Non-member space → the SAME empty result as a nonexistent space
      // (anti-probing). Any other failure degrades to empty, never a leak.
      if (!(err instanceof ForbiddenException)) {
        const message = err instanceof Error ? err.message : String(err);

        this.logger.warn(`searchMyPlans: listPlans failed: ${message}`);
      }

      return { plans: [] };
    }

    const rows = listed.data ?? [];
    const distinctSpaceIds = [
      ...new Set(
        rows
          .map((row) => (row.space_id as string | null | undefined) ?? '')
          .filter((id) => id.length > 0),
      ),
    ];

    const spaceRefs = await this.fetchSpaceRefs(
      distinctSpaceIds,
      user.organizationId,
    );

    const result: MyPlanSearchResult = {
      plans: rows.map((row) => this.toSearchItem(row, spaceRefs)),
      total: listed.total,
    };

    if (listed.hasMore) {
      result.nextCursor = this.encodeCursor(page + 1);
    }

    return result;
  }

  // Permission-constrained single-plan read backing MCP `plan.get`.
  //
  // Resolves the identifier (plan UUID, or a plan key resolved org-scoped —
  // a key matching MORE than one plan in the org is treated as not found, since
  // plan_key is only unique per space), then delegates authorization + the
  // detail load to `PlansService.getPlan` — the exact call the web app makes
  // (view gate: org admin/owner bypass → space membership + `view_plans` →
  // per-plan `plan_permissions`). EVERY failure (nonexistent, cross-org,
  // permission-denied, ambiguous key, malformed id, backend error) throws the
  // IDENTICAL NotFoundException (anti-probing; also collapses getPlan's 403).
  //
  // The response drops getPlan's heavy/leaky parts: `items[]` (nested task
  // PII + cost fields), `active_baseline` (`snapshot_data`), `creator` (email),
  // `settings`, `custom_field_values`, budget, RAG bookkeeping — returning
  // metadata + counts only. Archived plans ARE returned, flagged `isArchived`
  // (mirrors wiki.get). The org comes from the authenticated user.
  async getMyPlan(
    user: RequestUser,
    planIdOrKey: string,
  ): Promise<MyPlanResult> {
    // Uniform 404 for every "you cannot see this" case; never disambiguate.
    const notFound = () => new NotFoundException('Plan not found');

    if (!user.organizationId) {
      throw notFound();
    }

    const identifier = (planIdOrKey ?? '').trim();

    if (
      identifier.length === 0 ||
      identifier.length > MAX_PLAN_IDENTIFIER_CHARS
    ) {
      throw notFound();
    }

    let planId: string;

    if (UUID_RE.test(identifier)) {
      planId = identifier;
    } else {
      // Key resolution, org-scoped. plan_key is unique per SPACE only, so a
      // key matching multiple plans in the org is ambiguous → uniform 404.
      const candidates = [...new Set([identifier, identifier.toUpperCase()])];

      const keyResult = await this.client
        .from('plans')
        .select('id')
        .eq('organization_id', user.organizationId)
        .in('plan_key', candidates)
        .limit(2);

      if (keyResult.error) {
        this.logger.warn(
          `getMyPlan: key resolution failed: ${keyResult.error.message}`,
        );

        throw notFound();
      }

      const rows = (keyResult.data ?? []) as { id: string }[];

      if (rows.length !== 1) {
        throw notFound();
      }

      planId = rows[0].id;
    }

    // Delegate authorization + detail load to the app's own path. ANY failure
    // (Forbidden from the view gate, NotFound, malformed-uuid DB error, ...)
    // collapses to the uniform 404 so hidden == nonexistent.
    let detail: { data: Record<string, unknown> };

    try {
      detail = await this.plansService.getPlan(
        planId,
        user.organizationId,
        user.userId,
      );
    } catch {
      throw notFound();
    }

    const raw = detail.data;
    const spaceId = (raw.space_id as string | null | undefined) ?? null;
    const spaceRefs = await this.fetchSpaceRefs(
      spaceId ? [spaceId] : [],
      user.organizationId,
    );

    const fullDescription =
      (raw.description as string | null | undefined) ?? '';
    const descriptionTruncated =
      fullDescription.length > MAX_PLAN_DESCRIPTION_CHARS;

    const plan: MyPlanDetail = {
      id: String(raw.id),
      planKey: (raw.plan_key as string | null | undefined) ?? null,
      name: (raw.name as string | undefined) ?? '',
      description: descriptionTruncated
        ? fullDescription.slice(0, MAX_PLAN_DESCRIPTION_CHARS)
        : fullDescription,
      planType: (raw.plan_type as string | null | undefined) ?? null,
      status: (raw.status as string | null | undefined) ?? null,
      ragStatus: (raw.rag_status as string | null | undefined) ?? null,
      progress:
        typeof raw.progress === 'number' && Number.isFinite(raw.progress)
          ? raw.progress
          : null,
      owner: this.toOwnerRef(raw.owner),
      space: spaceId ? (spaceRefs.get(spaceId) ?? null) : null,
      isArchived: raw.is_archived === true,
      startDate: (raw.start_date as string | null | undefined) ?? null,
      endDate: (raw.end_date as string | null | undefined) ?? null,
      createdAt: (raw.created_at as string | undefined) ?? '',
      updatedAt: (raw.updated_at as string | undefined) ?? '',
      itemCount: typeof raw.item_count === 'number' ? raw.item_count : 0,
      riskCount: typeof raw.risk_count === 'number' ? raw.risk_count : 0,
      stakeholderCount:
        typeof raw.stakeholder_count === 'number' ? raw.stakeholder_count : 0,
    };

    if (descriptionTruncated) {
      plan.descriptionTruncated = true;
    }

    return { plan };
  }
}
