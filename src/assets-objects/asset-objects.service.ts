import { storageSafeFileName } from '../common/upload-filename';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import jexl from 'jexl';

import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import { formatMaxUpload, UPLOAD_LIMITS } from '../common/upload-limits';
import { assertImageMime } from '../common/upload-mime';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AssetObjectHistoryService } from './asset-object-history.service';
import { AssetObjectTypesService } from './asset-object-types.service';
import type { CreateAssetObjectDto } from './dto/create-asset-object.dto';
import type { UpdateAssetObjectDto } from './dto/update-asset-object.dto';
import {
  ATTRIBUTE_FIELD_KEY_PATTERN,
  ATTRIBUTE_FIELD_PREFIX,
  SORTABLE_ATTRIBUTE_KINDS,
  buildAssetFilterFields,
} from './filtering/asset-filter-fields';
import {
  buildFilterPlan,
  evaluateGroupInMemory,
  groupNeedsReferenceIndex,
  referenceDirectionsFor,
  referenceKey,
} from './filtering/asset-filter-plan';

import type { AssetReferenceIndex } from './filtering/asset-filter-plan';
import type {
  AssetReferenceDirection,
  IAssetFilterGroup,
} from './filtering/asset-filter.types';
import {
  escapeFilterValue,
  escapeLikeValue,
} from './filtering/asset-rule-translator';

/**
 * Sort tokens `list()` accepts. `attr_<field_key>` orders on the stored
 * attribute value; it is resolved against the schema's attributes before use,
 * so the key never reaches the query unchecked.
 */
export type AssetObjectSortField =
  | 'object_key'
  | 'name'
  | 'created_at'
  | 'updated_at'
  | `attr_${string}`;

const TABLE = 'asset_objects';

type SearchKind = 'text' | 'user' | 'users' | 'bool' | 'formula';

/** How the schema search reads each attribute type; formulas are calculated during the search. */
const SEARCH_KIND_BY_DATA_TYPE = new Map<string, SearchKind>([
  ['text', 'text'],
  ['textarea', 'text'],
  ['email', 'text'],
  ['url', 'text'],
  ['select', 'text'],
  ['status', 'text'],
  ['multiselect', 'text'],
  ['date', 'text'],
  ['datetime', 'text'],
  ['integer', 'text'],
  ['float', 'text'],
  ['object_reference', 'text'],
  ['user', 'user'],
  ['user_multi', 'users'],
  ['bool', 'bool'],
  ['formula', 'formula'],
]);

/**
 * Alias for the reference join used by object-reference filters. Prefixed so it
 * cannot collide with a real column, and stripped from every row before the
 * response leaves this service.
 */
const REFERENCE_EMBED_ALIAS = '__refs';

/**
 * PostgREST clamps every response to `max_rows` (1000, supabase/config.toml:18).
 * A bounded read that returns exactly this many rows may have been truncated,
 * which is what `partial` reports.
 */
const MAX_BOUNDED_ROWS = 1000;
const IMAGES_BUCKET = 'asset-object-images';
/** Object images accept any `image/*` type, SVG included — this endpoint has always allowed SVG. */
const IMAGE_MIME_OPTS = { allowSvg: true } as const;

const MAX_IMAGE_SIZE_BYTES = UPLOAD_LIMITS.SMALL_IMAGE;

@Injectable()
export class AssetObjectsService {
  private readonly logger = new Logger(AssetObjectsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly history: AssetObjectHistoryService,
    private readonly objectTypesService: AssetObjectTypesService,
    private readonly outboxService: AutomationEventOutboxService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Evaluates formula attributes and merges computed values into attribute_values.
   * Runs after object_reference enrichment so formulas can reference those values.
   * Invalid expressions or missing fields produce null (displayed as — in the UI).
   */
  private evaluateFormulas(
    objects: Record<string, unknown>[],
    formulaAttrs: {
      object_type_id: string;
      field_key: string;
      options: unknown;
    }[],
  ): Record<string, unknown>[] {
    if (!formulaAttrs.length) return objects;

    const formulaMap = new Map<
      string,
      { field_key: string; formula: string; result_type: string }[]
    >();

    for (const fa of formulaAttrs) {
      const opts = (fa.options as Record<string, unknown> | null) ?? {};
      const formula = opts['formula'] as string | undefined;

      if (!formula) continue;

      const result_type = (opts['result_type'] as string) ?? 'float';

      if (!formulaMap.has(fa.object_type_id)) {
        formulaMap.set(fa.object_type_id, []);
      }

      formulaMap
        .get(fa.object_type_id)!
        .push({ field_key: fa.field_key, formula, result_type });
    }

    return objects.map((obj) => {
      const typeId = obj['object_type_id'] as string | undefined;

      if (!typeId) return obj;

      const formulas = formulaMap.get(typeId);

      if (!formulas?.length) return obj;

      const attrVals = (obj['attribute_values'] ?? {}) as Record<
        string,
        unknown
      >;
      const computed: Record<string, unknown> = {};

      for (const { field_key, formula, result_type } of formulas) {
        try {
          const evalFn = jexl.evalSync.bind(jexl) as (
            e: string,
            c: unknown,
          ) => unknown;
          const raw = evalFn(formula, attrVals);

          if (raw == null) {
            computed[field_key] = null;
          } else if (result_type === 'text') {
            computed[field_key] = String(raw as string | number | boolean);
          } else if (result_type === 'bool') {
            computed[field_key] = Boolean(raw);
          } else if (result_type === 'date' || result_type === 'datetime') {
            computed[field_key] = String(raw as string | number | boolean);
          } else {
            // float or integer (default)
            const num = Number(raw);

            computed[field_key] = isFinite(num)
              ? result_type === 'integer'
                ? Math.round(num)
                : num
              : null;
          }
        } catch {
          computed[field_key] = null;
        }
      }

      return { ...obj, attribute_values: { ...attrVals, ...computed } };
    });
  }

  /**
   * Builds the allowlist of filterable fields for a schema.
   *
   * Attribute definitions carry a denormalised `schema_id`, so every attribute
   * in the schema is reachable without joining through object types — which
   * also means inherited attributes are included automatically.
   *
   * Resolved per request, never cached: a permission or schema change must take
   * effect on the very next call.
   */
  private async resolveFilterableFields(
    schemaId: string,
    organizationId: string,
    spaceId: string,
  ) {
    const { data, error } = await this.client
      .from('asset_object_type_attributes')
      // `id` scopes a reference embed to this attribute; `options` carries the
      // jexl formula and its result_type for calculated attributes.
      .select('id, field_key, data_type, options')
      .eq('schema_id', schemaId)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId);

    if (error) throw new BadRequestException(error.message);

    return buildAssetFilterFields(
      (data ?? []) as {
        id: string;
        field_key: string;
        data_type: string;
        options: Record<string, unknown> | null;
      }[],
    );
  }

  /**
   * Resolves reference TARGET IDS for the given objects.
   *
   * `attribute_values` only carries target names after enrichment, which is
   * fine for display but useless for filtering — rules reference targets by id.
   * Keyed `<objectId>:<attributeId>` so two attributes pointing at the same
   * type stay independent.
   */
  private async buildReferenceIndex(
    objectIds: string[],
    organizationId: string,
    spaceId: string,
    directions: AssetReferenceDirection[] = ['outgoing'],
  ): Promise<AssetReferenceIndex> {
    const index: AssetReferenceIndex = new Map();

    if (objectIds.length === 0) return index;

    // Queried per direction rather than with one `.or()`: the id list can hold
    // up to MAX_BOUNDED_ROWS entries and an or-group would double the URL.
    for (const direction of directions) {
      const own =
        direction === 'incoming' ? 'target_object_id' : 'source_object_id';

      const far =
        direction === 'incoming' ? 'source_object_id' : 'target_object_id';

      const { data, error } = await this.client
        .from('asset_object_references')
        .select('source_object_id, target_object_id, attribute_id')
        .in(own, objectIds)
        .eq('organization_id', organizationId)
        .eq('space_id', spaceId)
        // Relation-type references carry no attribute_id and must never satisfy
        // an attribute-scoped rule.
        .not('attribute_id', 'is', null);

      if (error) throw new BadRequestException(error.message);

      const rows = (data ?? []) as unknown as Record<string, string>[];

      for (const row of rows) {
        const key = referenceKey(row[own], row['attribute_id'], direction);

        if (!index.has(key)) index.set(key, new Set());
        index.get(key)!.add(row[far]);
      }
    }

    return index;
  }

  async list(
    schemaId: string,
    objectTypeId: string | undefined,
    spaceId: string,
    organizationId: string,
    userId: string,
    page = 1,
    pageSize = 50,
    sortField: AssetObjectSortField = 'created_at',
    sortDirection: 'asc' | 'desc' = 'desc',
    search?: string,
    filter?: IAssetFilterGroup | null,
  ) {
    if (objectTypeId) {
      const perms = await this.objectTypesService.getMyPermission(
        objectTypeId,
        spaceId,
        organizationId,
        userId,
      );

      if (!perms.can_view) {
        throw new ForbiddenException(
          'You do not have permission to view objects of this type',
        );
      }
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    const ascending = sortDirection === 'asc';

    // name / object_key contain numeric substrings that must sort numerically, not lexicographically.
    // Fetch all matching rows and apply localeCompare({ numeric: true }) in memory.
    const isNaturalSortField =
      sortField === 'name' || sortField === 'object_key';

    // An attribute sort is validated against the same field map the filter
    // uses, so the map is resolved whenever either one needs it.
    const isAttrSort = sortField.startsWith(ATTRIBUTE_FIELD_PREFIX);

    // Resolved up front because the plan decides the SELECT (a reference filter
    // adds an embed) and the range (memory mode must fetch bounded, not paged).
    const filterFields =
      (filter && filter.rules.length > 0) || isAttrSort
        ? await this.resolveFilterableFields(schemaId, organizationId, spaceId)
        : null;

    const plan = filterFields ? buildFilterPlan(filter, filterFields) : null;

    // Only kinds whose value lives in attribute_values can be ordered in SQL.
    // An unknown or unsortable token falls back to the default order, the same
    // way the controller treats an unrecognised base column.
    const sortAttr = isAttrSort ? filterFields?.get(sortField) : undefined;

    const attrSortColumn =
      sortAttr?.fieldKey && SORTABLE_ATTRIBUTE_KINDS.has(sortAttr.kind)
        ? `attribute_values->>${sortAttr.fieldKey}`
        : null;

    // Memory mode = at least one rule (formula, or a reference shape the embed
    // cannot express) must be evaluated in JS, so the whole page must be
    // filtered after fetching rather than by SQL.
    const isMemoryMode = plan?.mode === 'memory';
    const isBounded = isNaturalSortField || isMemoryMode;

    // A reference filter joins asset_object_references. `!inner` keeps ONE row
    // per parent (children nest as an array), so `count` stays the parent count.
    // The FK must be named explicitly — asset_object_references has two FKs to
    // asset_objects (source and target) and an unqualified embed returns 300.
    // `incoming` reads the same rows from the other end: the candidate is the
    // reference TARGET, pointed at by the given object.
    const embedIncoming = plan?.embed?.direction === 'incoming';

    const embedFk = embedIncoming
      ? 'asset_object_references_target_object_id_fkey'
      : 'asset_object_references_source_object_id_fkey';

    const selectClause = plan?.embed
      ? `*,${REFERENCE_EMBED_ALIAS}:asset_object_references!${embedFk}!inner(id)`
      : '*';

    let query = this.client
      .from(TABLE)
      .select(selectClause, { count: 'exact' })
      .eq('schema_id', schemaId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_archived', false);

    if (plan?.embed) {
      query = query
        .eq(`${REFERENCE_EMBED_ALIAS}.attribute_id`, plan.embed.attributeId)
        .eq(
          `${REFERENCE_EMBED_ALIAS}.${embedIncoming ? 'source_object_id' : 'target_object_id'}`,
          plan.embed.targetObjectId,
        )
        // The child rows are service-role reads too, so scope them explicitly.
        .eq(`${REFERENCE_EMBED_ALIAS}.organization_id`, organizationId)
        .eq(`${REFERENCE_EMBED_ALIAS}.space_id`, spaceId);
    }

    if (attrSortColumn) {
      // Ordered in SQL for both read shapes below: a memory-mode filter bounds
      // the read, and the in-memory pass further down only re-sorts
      // name/object_key. Ties are common on an attribute (many rows share a
      // vendor, or have none), so `id` breaks them — an unstable order would
      // repeat or skip rows between pages. Empty values sort last either way.
      query = query
        .order(attrSortColumn, { ascending, nullsFirst: false })
        .order('id', { ascending: true });
    }

    if (isBounded) {
      // KNOWN LIMITATION — read before raising this number, it will not help.
      //
      // This asks for 10 000 rows, but PostgREST clamps every response to its
      // `max_rows` cap (1000, see supabase/config.toml), so at most 1000 arrive.
      // The in-memory natural sort and the `.slice(from, to + 1)` below then run
      // over that truncated set, while `count` comes from `count: 'exact'` and
      // reports the TRUE total — so `data` and `count` disagree, and any page
      // past ~1000/pageSize returns empty while the client still believes more
      // exist.
      //
      // Not fixed here because the correct fix is structural: the sort must move
      // into SQL, or the read must page through the full set (see
      // common/utils/fetch-all-rows.ts), and the latter needs this method's
      // shared mutable `query` builder turned into a per-page factory. At current
      // volumes (single-digit to low-hundreds of asset objects per space) the cap
      // is never reached, so this is a latent correctness bug rather than a live
      // one — but it WILL bite silently once a schema passes 1000 objects.
      //
      // The in-memory pass below only re-sorts name/object_key, so any other
      // column (a memory-mode filter with a date sort) must be ordered here.
      if (!isNaturalSortField && !attrSortColumn) {
        query = query.order(isAttrSort ? 'created_at' : sortField, {
          ascending,
        });
      }

      query = query.range(0, 9999);
    } else if (attrSortColumn) {
      query = query.range(from, to);
    } else {
      // An attr_ token that did not resolve falls back to the default column.
      query = query
        .order(isAttrSort ? 'created_at' : sortField, { ascending })
        .range(from, to);
    }

    if (objectTypeId) {
      query = query.eq('object_type_id', objectTypeId);
    }

    if (search?.trim()) {
      // Escaped so commas, brackets and LIKE wildcards match literally
      const pattern = escapeFilterValue(`%${escapeLikeValue(search.trim())}%`);

      query = query.or(`name.ilike.${pattern},object_key.ilike.${pattern}`);
    }

    if (plan && plan.mode === 'sql') {
      // Applied BEFORE the query is awaited so filtering happens in SQL — and
      // therefore before the `.range()` above — keeping `data` and `count`
      // consistent with each other and with pagination.
      //
      // Each fragment is applied as its own `.or(...)` call. A single-element
      // or-group behaves as a plain condition, so chaining them yields AND,
      // while one call containing all rules yields OR. One code path, both
      // combinators.
      for (const fragment of plan.fragments) {
        query = query.or(fragment);
      }
    }

    const { data, error, count } = await query;

    if (error) throw new BadRequestException(error.message);

    // Double cast: `selectClause` is computed at runtime (it may carry the
    // reference embed), so supabase-js cannot statically parse it into a row
    // type and infers a ParserError instead.
    let enrichedObjects = (data ?? []) as unknown as Record<string, unknown>[];

    // How many rows the read actually returned, captured BEFORE any in-memory
    // filtering — used to detect that the bounded read hit max_rows.
    const fetchedRowCount = enrichedObjects.length;

    if (plan?.embed) {
      // The `!inner` embed is a join predicate only. Its nested rows must never
      // reach the client — the list response shape has to stay `{data, count}`.
      enrichedObjects = enrichedObjects.map((row) => {
        const rest = { ...row };

        delete rest[REFERENCE_EMBED_ALIAS];

        return rest;
      });
    }

    if (enrichedObjects.length > 0) {
      const objectIds = enrichedObjects.map((o) => o['id'] as string);

      const typeIds = [
        ...new Set(
          enrichedObjects
            .map((o) => o['object_type_id'] as string)
            .filter(Boolean),
        ),
      ];

      const { data: refs } = await this.client
        .from('asset_object_references')
        .select(
          `source_object_id,
          attribute:asset_object_type_attributes!asset_object_references_attribute_id_fkey(field_key),
          target_object:asset_objects!asset_object_references_target_object_id_fkey(name)`,
        )
        .in('source_object_id', objectIds)
        .eq('organization_id', organizationId)
        .eq('space_id', spaceId)
        .not('attribute_id', 'is', null);

      // `attribute_values` keeps a denormalised copy of reference target names,
      // written by a separate, non-atomic request. When the edge write fails or
      // an edge is later removed, the copy goes stale and renders a value the
      // reference filter — which reads edges — can never match. Knowing which
      // keys are references lets the merge below drop a copy with no edge.
      // Per type, not per schema: two types may share a field_key with
      // different data types, and a plain text value must never be cleared.
      const { data: refAttrs } = await this.client
        .from('asset_object_type_attributes')
        .select('object_type_id, field_key')
        .in('object_type_id', typeIds)
        .eq('data_type', 'object_reference')
        .eq('organization_id', organizationId);

      const refKeysByType = new Map<string, string[]>();

      for (const attr of (refAttrs ?? []) as {
        object_type_id: string;
        field_key: string;
      }[]) {
        const keys = refKeysByType.get(attr.object_type_id) ?? [];

        keys.push(attr.field_key);
        refKeysByType.set(attr.object_type_id, keys);
      }

      const refMap = new Map<string, Record<string, string[]>>();

      if (refs && refs.length > 0) {
        for (const ref of refs as Record<string, unknown>[]) {
          const sourceId = ref['source_object_id'] as string;
          const attr = ref['attribute'] as Record<string, unknown> | null;

          const targetObj = ref['target_object'] as Record<
            string,
            unknown
          > | null;

          if (!attr || !targetObj) continue;

          const fieldKey = attr['field_key'] as string;
          const targetName = targetObj['name'] as string;

          if (!refMap.has(sourceId)) refMap.set(sourceId, {});

          const entry = refMap.get(sourceId)!;

          if (!entry[fieldKey]) entry[fieldKey] = [];
          entry[fieldKey].push(targetName);
        }
      }

      // Runs for every object, not only those with edges: an object whose
      // reference field has no edge still carries the stale copy, including
      // when a different reference field on it does have one.
      enrichedObjects = enrichedObjects.map((obj) => {
        const refData = refMap.get(obj['id'] as string);

        const values = (obj['attribute_values'] ?? {}) as Record<
          string,
          unknown
        >;

        const staleKeys = (
          refKeysByType.get(obj['object_type_id'] as string) ?? []
        ).filter((key) => !refData?.[key] && key in values);

        if (!refData && staleKeys.length === 0) return obj;

        const merged: Record<string, unknown> = { ...values, ...refData };

        for (const key of staleKeys) delete merged[key];

        return { ...obj, attribute_values: merged };
      });

      // Formula evaluation — runs after ref enrichment so formulas see object_reference values
      const { data: fAttrs } = await this.client
        .from('asset_object_type_attributes')
        .select('object_type_id, field_key, options')
        .in('object_type_id', typeIds)
        .eq('data_type', 'formula')
        .eq('organization_id', organizationId);

      if (fAttrs && fAttrs.length > 0) {
        enrichedObjects = this.evaluateFormulas(
          enrichedObjects,
          fAttrs as {
            object_type_id: string;
            field_key: string;
            options: unknown;
          }[],
        );
      }
    }

    // Rules SQL cannot express (formula, and reference shapes the embed cannot
    // model) are applied here, AFTER enrichment — formula values and reference
    // names only exist on the row once enrichment has run.
    let filteredCount: number | null = null;

    if (isMemoryMode && plan && filterFields) {
      // Reference rules compare target IDs, but enrichment only merged target
      // NAMES into attribute_values — so the real ids have to be resolved
      // separately. Without this every reference rule fails and an AND group
      // silently returns nothing.
      const referenceIndex = groupNeedsReferenceIndex(
        plan.memoryRules,
        filterFields,
      )
        ? await this.buildReferenceIndex(
            enrichedObjects.map((o) => o['id'] as string),
            organizationId,
            spaceId,
            referenceDirectionsFor(plan.memoryRules, filterFields),
          )
        : undefined;

      enrichedObjects = enrichedObjects.filter((row) =>
        evaluateGroupInMemory(
          row,
          plan.memoryRules,
          plan.combinator,
          filterFields,
          referenceIndex,
        ),
      );

      // The SQL `count` counts pre-filter rows, so it would overstate the total.
      filteredCount = enrichedObjects.length;
    }

    if (isNaturalSortField) {
      const direction = ascending ? 1 : -1;

      enrichedObjects = [...enrichedObjects].sort((a, b) => {
        const aVal = String((a[sortField] as string | undefined) ?? '');
        const bVal = String((b[sortField] as string | undefined) ?? '');

        return (
          direction *
          aVal.localeCompare(bVal, undefined, {
            numeric: true,
            sensitivity: 'base',
          })
        );
      });
    }

    if (isBounded) {
      const total = filteredCount ?? count ?? 0;

      // `partial` is true when the bounded read hit PostgREST's max_rows cap, so
      // rows beyond it were never seen and the result may be incomplete. Say so
      // rather than silently returning a short list.
      const partial = isMemoryMode && fetchedRowCount >= MAX_BOUNDED_ROWS;

      return {
        data: enrichedObjects.slice(from, to + 1),
        count: total,
        ...(partial ? { partial: true } : {}),
      };
    }

    return { data: enrichedObjects, count: count ?? 0 };
  }

  /**
   * Schema-wide object search for the schema page: name, key and text-like
   * attribute values, no enrichment, skipping object types the caller cannot view.
   */
  async searchSchemaObjects(
    schemaId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
    search: string | undefined,
    page = 1,
    pageSize = 25,
    objectTypeId?: string,
  ): Promise<{
    data: Record<string, unknown>[];
    count: number;
    partial?: boolean;
  }> {
    const term = search?.trim();

    if (!term) return { data: [], count: 0 };

    const { data: types, error: typesError } = await this.client
      .from('asset_object_types')
      .select('id, permissions')
      .eq('schema_id', schemaId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (typesError) throw new BadRequestException(typesError.message);

    const typeRows = (types ?? []) as {
      id: string;
      permissions: {
        user_permissions?: unknown[];
        group_permissions?: unknown[];
      } | null;
    }[];

    // Types without permission entries are open to everyone; only the rest need a check
    const restricted = typeRows.filter(
      (t) =>
        (t.permissions?.user_permissions?.length ?? 0) > 0 ||
        (t.permissions?.group_permissions?.length ?? 0) > 0,
    );

    const checks = await Promise.all(
      restricted.map(async (t) => {
        const perms = await this.objectTypesService.getMyPermission(
          t.id,
          spaceId,
          organizationId,
          userId,
        );

        return { id: t.id, canView: perms.can_view };
      }),
    );

    const deniedIds = checks.filter((c) => !c.canView).map((c) => c.id);

    if (typeRows.length > 0 && deniedIds.length === typeRows.length) {
      return { data: [], count: 0 };
    }

    // A selected type the caller cannot view has nothing to show
    if (objectTypeId && deniedIds.includes(objectTypeId)) {
      return { data: [], count: 0 };
    }

    // An exact object key (any case) shows only that object
    let exactQuery = this.client
      .from(TABLE)
      .select('id, object_key, name, object_type_id, image_path')
      .eq('schema_id', schemaId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_archived', false)
      .ilike('object_key', escapeLikeValue(term));

    if (objectTypeId) {
      exactQuery = exactQuery.eq('object_type_id', objectTypeId);
    }

    if (deniedIds.length > 0) {
      exactQuery = exactQuery.not(
        'object_type_id',
        'in',
        `(${deniedIds.join(',')})`,
      );
    }

    const { data: exact, error: exactError } = await exactQuery;

    if (exactError) throw new BadRequestException(exactError.message);

    if (exact && exact.length > 0) {
      return {
        data: exact as unknown as Record<string, unknown>[],
        count: exact.length,
      };
    }

    // A field_key shared by several types is searched only when every definition is visible and read the same way
    const { data: attrs, error: attrsError } = await this.client
      .from('asset_object_type_attributes')
      .select('object_type_id, field_key, name, data_type, is_hidden, options')
      .eq('schema_id', schemaId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (attrsError) throw new BadRequestException(attrsError.message);

    // Same rule as ilike: case-insensitive contains, `*` matches anything
    const parts = term.toLowerCase().split('*').filter(Boolean);

    const matches = (text: string) => {
      const lower = text.toLowerCase();
      let at = 0;

      for (const part of parts) {
        const found = lower.indexOf(part, at);

        if (found === -1) return false;
        at = found + part.length;
      }

      return true;
    };

    // `->>` reads arrays and objects as JSON text
    const toText = (value: unknown): string =>
      typeof value === 'object' && value !== null
        ? JSON.stringify(value)
        : String(value as string | number | boolean);

    const attrInfo = new Map<string, { label: string; kind: SearchKind }>();
    const skippedKeys = new Set<string>();

    const attrRows = (attrs ?? []) as {
      object_type_id: string;
      field_key: string;
      name: string;
      data_type: string;
      is_hidden: boolean | null;
      options: unknown;
    }[];

    for (const attr of attrRows) {
      const kind = SEARCH_KIND_BY_DATA_TYPE.get(attr.data_type);
      const known = attrInfo.get(attr.field_key);

      // Hidden, formula, unsafe key, or a key another type stores differently
      if (
        attr.is_hidden ||
        !kind ||
        !ATTRIBUTE_FIELD_KEY_PATTERN.test(attr.field_key) ||
        (known && known.kind !== kind)
      ) {
        skippedKeys.add(attr.field_key);
      } else if (!known) {
        attrInfo.set(attr.field_key, { label: attr.name, kind });
      }
    }

    const searchAttrs = [...attrInfo].filter(([key]) => !skippedKeys.has(key));

    // Formula definitions to calculate, same rows list() hands to evaluateFormulas
    const formulaKeys = new Set(
      searchAttrs.filter(([, a]) => a.kind === 'formula').map(([key]) => key),
    );

    const formulaDefs = attrRows.filter(
      (a) => a.data_type === 'formula' && formulaKeys.has(a.field_key),
    );

    // User attributes store ids, so first find org members whose name or email matches (at most 50)
    const userNames = new Map<string, string>();

    if (searchAttrs.some(([, a]) => a.kind === 'user' || a.kind === 'users')) {
      const { data: members, error: membersError } = await this.client
        .from('organization_members')
        .select('user_id')
        .eq('organization_id', organizationId);

      if (membersError) throw new BadRequestException(membersError.message);

      const memberIds = ((members ?? []) as { user_id: string }[]).map(
        (m) => m.user_id,
      );

      if (memberIds.length > 0) {
        const { data: people, error: peopleError } = await this.client
          .from('users')
          .select('id, first_name, last_name, email')
          .in('id', memberIds);

        if (peopleError) throw new BadRequestException(peopleError.message);

        for (const person of (people ?? []) as {
          id: string;
          first_name: string | null;
          last_name: string | null;
          email: string | null;
        }[]) {
          const email = person.email ?? '';

          const name =
            `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim() ||
            email;

          if (userNames.size < 50 && (matches(name) || matches(email))) {
            userNames.set(person.id, name);
          }
        }
      }
    }

    const pattern = escapeFilterValue(`%${escapeLikeValue(term)}%`);

    // Bool values are shown as Yes / No, so only those whole words match them
    const lowerTerm = term.toLowerCase();
    const boolValue =
      lowerTerm === 'yes' ? 'true' : lowerTerm === 'no' ? 'false' : null;
    const userIds = [...userNames.keys()];
    const conditions = [`name.ilike.${pattern}`, `object_key.ilike.${pattern}`];

    for (const [key, attr] of searchAttrs) {
      if (attr.kind === 'text') {
        conditions.push(`attribute_values->>${key}.ilike.${pattern}`);
      } else if (attr.kind === 'bool' && boolValue) {
        conditions.push(`attribute_values->>${key}.eq.${boolValue}`);
      } else if (attr.kind === 'user' && userIds.length > 0) {
        conditions.push(`attribute_values->>${key}.in.(${userIds.join(',')})`);
      } else if (attr.kind === 'users') {
        for (const id of userIds) {
          conditions.push(`attribute_values->>${key}.ilike.%${id}%`);
        }
      }
    }

    let query = this.client
      .from(TABLE)
      .select(
        'id, object_key, name, object_type_id, image_path, attribute_values',
        { count: 'exact' },
      )
      .eq('schema_id', schemaId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_archived', false)
      .or(conditions.join(','))
      .order('object_key', { ascending: true })
      .limit(MAX_BOUNDED_ROWS);

    if (deniedIds.length > 0) {
      query = query.not('object_type_id', 'in', `(${deniedIds.join(',')})`);
    }

    if (objectTypeId) {
      query = query.eq('object_type_id', objectTypeId);
    }

    const { data, error, count } = await query;

    if (error) throw new BadRequestException(error.message);

    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    const sqlCount = count ?? rows.length;
    let formulaMatches = 0;
    let formulaPartial = false;

    // Calculated values are not stored, so evaluate formulas for their types and add any object they match
    const formulaTypeIds = [
      ...new Set(formulaDefs.map((f) => f.object_type_id)),
    ].filter(
      (id) => !deniedIds.includes(id) && (!objectTypeId || id === objectTypeId),
    );

    if (formulaTypeIds.length > 0) {
      const { data: candidates, error: candidatesError } = await this.client
        .from(TABLE)
        .select(
          'id, object_key, name, object_type_id, image_path, attribute_values',
        )
        .eq('schema_id', schemaId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .eq('is_archived', false)
        .in('object_type_id', formulaTypeIds)
        .limit(MAX_BOUNDED_ROWS);

      if (candidatesError) {
        throw new BadRequestException(candidatesError.message);
      }

      const candidateRows = (candidates ?? []) as unknown as Record<
        string,
        unknown
      >[];

      formulaPartial = candidateRows.length >= MAX_BOUNDED_ROWS;

      const seen = new Set(rows.map((r) => r['id'] as string));

      for (const obj of this.evaluateFormulas(candidateRows, formulaDefs)) {
        const id = obj['id'] as string;
        const values = (obj['attribute_values'] ?? {}) as Record<
          string,
          unknown
        >;

        const hit = formulaDefs.some(
          (f) =>
            f.object_type_id === obj['object_type_id'] &&
            values[f.field_key] != null &&
            matches(toText(values[f.field_key])),
        );

        if (hit && !seen.has(id)) {
          rows.push(obj);
          seen.add(id);
          formulaMatches++;
        }
      }
    }

    // Natural key order (CMDB-2 before CMDB-10), same comparator as list()
    rows.sort((a, b) =>
      String((a['object_key'] as string | undefined) ?? '').localeCompare(
        String((b['object_key'] as string | undefined) ?? ''),
        undefined,
        { numeric: true, sensitivity: 'base' },
      ),
    );

    const from = (page - 1) * pageSize;
    const total = sqlCount + formulaMatches;

    // Label with calculated values, never a stale stored copy
    const pageRows = this.evaluateFormulas(
      rows.slice(from, from + pageSize),
      formulaDefs,
    );

    // attribute_values is only read to label attribute matches; it is not returned
    const hits = pageRows.map((row) => {
      const { attribute_values: values, ...hit } = row;

      if (
        matches((hit['name'] as string | undefined) ?? '') ||
        matches((hit['object_key'] as string | undefined) ?? '')
      ) {
        return hit;
      }

      const stored = (values ?? {}) as Record<string, unknown>;

      for (const [key, attr] of searchAttrs) {
        const value = stored[key];

        if (value === null || value === undefined) continue;

        let shown: string | null = null;

        if (
          (attr.kind === 'text' || attr.kind === 'formula') &&
          matches(toText(value))
        ) {
          shown = Array.isArray(value)
            ? (value as unknown[]).map(toText).join(', ')
            : toText(value);
        } else if (
          attr.kind === 'bool' &&
          boolValue &&
          toText(value) === boolValue
        ) {
          shown = boolValue === 'true' ? 'Yes' : 'No';
        } else if (attr.kind === 'user' || attr.kind === 'users') {
          const names = (Array.isArray(value) ? (value as unknown[]) : [value])
            .map((id) => userNames.get(toText(id)))
            .filter(Boolean);

          if (names.length > 0) shown = names.join(', ');
        }

        if (shown !== null) {
          return { ...hit, matched: { attribute: attr.label, value: shown } };
        }
      }

      return hit;
    });

    return {
      data: hits,
      count: total,
      ...(total > rows.length || formulaPartial ? { partial: true } : {}),
    };
  }

  async getOne(
    id: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Asset object not found');

    let row = data as Record<string, unknown>;
    const objectTypeId = row['object_type_id'] as string | undefined;

    if (objectTypeId) {
      const perms = await this.objectTypesService.getMyPermission(
        objectTypeId,
        spaceId,
        organizationId,
        userId,
      );

      if (!perms.can_view) {
        throw new ForbiddenException(
          'You do not have permission to view objects of this type',
        );
      }

      // Formula enrichment — evaluate any formula attributes for this object type
      const { data: fAttrs } = await this.client
        .from('asset_object_type_attributes')
        .select('object_type_id, field_key, options')
        .eq('object_type_id', objectTypeId)
        .eq('data_type', 'formula')
        .eq('organization_id', organizationId);

      if (fAttrs && fAttrs.length > 0) {
        [row] = this.evaluateFormulas(
          [row],
          fAttrs as {
            object_type_id: string;
            field_key: string;
            options: unknown;
          }[],
        );
      }
    }

    return row;
  }

  async create(
    dto: CreateAssetObjectDto,
    schemaId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    // Verify object type belongs to the schema and space
    const { data: typeRow, error: typeErr } = await this.client
      .from('asset_object_types')
      .select('id')
      .eq('id', dto.object_type_id)
      .eq('schema_id', schemaId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (typeErr) throw new BadRequestException(typeErr.message);
    if (!typeRow)
      throw new NotFoundException('Object type not found in this schema');

    const createPerms = await this.objectTypesService.getMyPermission(
      dto.object_type_id,
      spaceId,
      organizationId,
      userId,
    );

    if (!createPerms.can_create) {
      throw new ForbiddenException(
        'You do not have permission to create objects of this type',
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        ...dto,
        schema_id: schemaId,
        space_id: spaceId,
        organization_id: organizationId,
        created_by: userId,
        updated_by: userId,
      })
      .select('*')
      .single();

    if (error) throw new BadRequestException(error.message);

    const created = data as Record<string, unknown>;

    void this.outboxService.write(
      organizationId,
      spaceId,
      'app.asset_object.created',
      {
        asset: {
          id: created['id'],
          name: created['name'],
          schema_id: schemaId,
          object_type_id: (created['object_type_id'] as string | null) ?? null,
          space_id: spaceId,
          organization_id: organizationId,
        },
        asset_id: created['id'],
        schema_id: schemaId,
        space_id: spaceId,
        organization_id: organizationId,
        created_by: userId,
      },
    );

    this.history
      .logChange(
        (data as Record<string, unknown>).id as string,
        schemaId,
        organizationId,
        spaceId,
        'object_create',
        userId,
      )
      .catch(() => undefined);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return data;
  }

  async update(
    id: string,
    dto: UpdateAssetObjectDto,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    const { data: existing, error: fetchErr } = await this.client
      .from(TABLE)
      .select('id, name, object_type_id, schema_id')
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchErr) throw new BadRequestException(fetchErr.message);
    if (!existing) throw new NotFoundException('Asset object not found');

    const existingRow = existing as Record<string, unknown>;

    const editObjectTypeId = existingRow['object_type_id'] as
      | string
      | undefined;

    if (editObjectTypeId) {
      const editPerms = await this.objectTypesService.getMyPermission(
        editObjectTypeId,
        spaceId,
        organizationId,
        userId,
      );

      if (!editPerms.can_edit) {
        throw new ForbiddenException(
          'You do not have permission to edit objects of this type',
        );
      }
    }

    const oldTypeId = editObjectTypeId;
    const newTypeId = dto.object_type_id;

    if (newTypeId && newTypeId !== oldTypeId) {
      const { data: typeRow } = await this.client
        .from('asset_object_types')
        .select('id')
        .eq('id', newTypeId)
        .eq('schema_id', existingRow['schema_id'] as string)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (!typeRow) {
        throw new BadRequestException(
          'Object type does not belong to this schema',
        );
      }

      const targetPerms = await this.objectTypesService.getMyPermission(
        newTypeId,
        spaceId,
        organizationId,
        userId,
      );

      if (!targetPerms.can_create) {
        throw new ForbiddenException(
          'No permission to create objects in the target type',
        );
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { version: _v, ...updatePayload } = dto;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({ ...updatePayload, updated_by: userId })
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .select('*')
      .single();

    if (error) throw new BadRequestException(error.message);

    const changedFields = Object.keys(dto).filter(
      (k) =>
        k !== 'version' && (dto as Record<string, unknown>)[k] !== undefined,
    );

    if (newTypeId && newTypeId !== oldTypeId) {
      void this.outboxService.write(
        organizationId,
        spaceId,
        'app.asset_object.type_changed',
        {
          asset: {
            id,
            name: existingRow['name'] as string,
            schema_id: existingRow['schema_id'] as string,
            space_id: spaceId,
            organization_id: organizationId,
            object_type_id: newTypeId,
          },
          asset_id: id,
          schema_id: existingRow['schema_id'] as string,
          space_id: spaceId,
          organization_id: organizationId,
          old_type_id: oldTypeId ?? null,
          new_type_id: newTypeId,
          // snake_case aliases so automation filter keys resolve correctly via camelToSnake
          old_object_type_id: oldTypeId ?? null,
          new_object_type_id: newTypeId,
          updated_by: userId,
        },
      );
    }

    void this.outboxService.write(
      organizationId,
      spaceId,
      'app.asset_object.updated',
      {
        asset: {
          id,
          name: existingRow['name'] as string,
          schema_id: existingRow['schema_id'] as string,
          object_type_id: newTypeId ?? oldTypeId ?? null,
          space_id: spaceId,
          organization_id: organizationId,
        },
        asset_id: id,
        schema_id: existingRow['schema_id'] as string,
        space_id: spaceId,
        organization_id: organizationId,
        changedFields,
        updated_by: userId,
      },
    );

    const row = existing as Record<string, unknown>;
    const schemaId = row.schema_id as string;

    if (newTypeId && newTypeId !== oldTypeId) {
      // Fetch old and new type names in parallel for semantic history entry
      const [oldTypeResult, newTypeResult] = await Promise.all([
        oldTypeId
          ? this.client
              .from('asset_object_types')
              .select('name')
              .eq('id', oldTypeId)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        this.client
          .from('asset_object_types')
          .select('name')
          .eq('id', newTypeId)
          .maybeSingle(),
      ]);

      const oldTypeName =
        (oldTypeResult.data as Record<string, unknown> | null)?.['name'] ??
        null;
      const newTypeName =
        (newTypeResult.data as Record<string, unknown> | null)?.['name'] ??
        null;

      this.history
        .logChange(
          id,
          schemaId,
          organizationId,
          spaceId,
          'object_update',
          userId,
          {
            attributeKey: 'object_type_id',
            oldValue: { id: oldTypeId ?? null, name: oldTypeName },
            newValue: { id: newTypeId, name: newTypeName },
            metadata: { reason: 'type_changed' },
          },
        )
        .catch(() => undefined);
    } else {
      this.history
        .logChange(
          id,
          schemaId,
          organizationId,
          spaceId,
          'object_update',
          userId,
        )
        .catch(() => undefined);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return data;
  }

  async delete(
    id: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    const { data: existing, error: fetchErr } = await this.client
      .from(TABLE)
      .select('id, name, object_type_id, schema_id, image_path')
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchErr) throw new BadRequestException(fetchErr.message);
    if (!existing) throw new NotFoundException('Asset object not found');

    const row = existing as Record<string, unknown>;
    const deleteObjectTypeId = row['object_type_id'] as string | undefined;

    if (deleteObjectTypeId) {
      const deletePerms = await this.objectTypesService.getMyPermission(
        deleteObjectTypeId,
        spaceId,
        organizationId,
        userId,
      );

      if (!deletePerms.can_delete) {
        throw new ForbiddenException(
          'You do not have permission to delete objects of this type',
        );
      }
    }

    // Clean up cover image from storage if present
    const imagePath = row['image_path'] as string | null;

    if (imagePath) {
      await this.client.storage.from(IMAGES_BUCKET).remove([imagePath]);
    }

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);

    this.outboxService
      .write(organizationId, spaceId, 'app.asset_object.deleted', {
        asset: {
          id,
          name: row['name'] as string,
          schema_id: row['schema_id'] as string,
          space_id: spaceId,
          organization_id: organizationId,
        },
        asset_id: id,
        schema_id: row['schema_id'] as string,
        space_id: spaceId,
        organization_id: organizationId,
        deleted_by: userId,
      })
      .catch((err: unknown) =>
        this.logger.error('[asset-objects.delete] outbox write failed', err),
      );

    this.history
      .logChange(
        id,
        row.schema_id as string,
        organizationId,
        spaceId,
        'object_delete',
        userId,
      )
      .catch(() => undefined);

    return { success: true };
  }

  async uploadImage(
    objectId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
    file: Express.Multer.File,
  ): Promise<Record<string, unknown>> {
    const { data: existing, error: fetchErr } = await this.client
      .from(TABLE)
      .select('id, schema_id, image_path')
      .eq('id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchErr) throw new BadRequestException(fetchErr.message);
    if (!existing) throw new NotFoundException('Asset object not found');

    const row = existing as Record<string, unknown>;

    if (!file) throw new BadRequestException('File is required');

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      throw new BadRequestException(
        `Image exceeds maximum size of ${formatMaxUpload(MAX_IMAGE_SIZE_BYTES)}`,
      );
    }

    assertImageMime(file.mimetype, IMAGE_MIME_OPTS);

    const sanitizedName = storageSafeFileName(file.originalname);
    const filePath = `objects/${organizationId}/${objectId}/${Date.now()}-${sanitizedName}`;

    const oldImagePath = row['image_path'] as string | null;

    if (oldImagePath) {
      await this.client.storage.from(IMAGES_BUCKET).remove([oldImagePath]);
    }

    const { error: uploadError } = await this.client.storage
      .from(IMAGES_BUCKET)
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError)
      throw new BadRequestException(`Upload failed: ${uploadError.message}`);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({ image_path: filePath, updated_by: userId })
      .eq('id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .select('*')
      .single();

    if (error || !data) {
      await this.client.storage.from(IMAGES_BUCKET).remove([filePath]);
      throw new BadRequestException(
        error?.message ?? 'Failed to update object image',
      );
    }

    this.history
      .logChange(
        objectId,
        row.schema_id as string,
        organizationId,
        spaceId,
        'object_update',
        userId,
      )
      .catch(() => undefined);

    const updatedRow = data as Record<string, unknown>;

    void this.outboxService.write(
      organizationId,
      spaceId,
      'app.asset_object.image_added',
      {
        asset: {
          id: objectId,
          name: updatedRow['name'] as string,
          schema_id: updatedRow['schema_id'] as string,
          object_type_id: updatedRow['object_type_id'] as string | null,
          space_id: spaceId,
          organization_id: organizationId,
        },
        asset_id: objectId,
        schema_id: updatedRow['schema_id'] as string,
        object_type_id: updatedRow['object_type_id'] as string | null,
        space_id: spaceId,
        organization_id: organizationId,
        image: { path: filePath },
        updated_by: userId,
      },
    );

    return updatedRow;
  }

  async deleteImage(
    objectId: string,
    spaceId: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const { data: existing, error: fetchErr } = await this.client
      .from(TABLE)
      .select('id, schema_id, image_path')
      .eq('id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (fetchErr) throw new BadRequestException(fetchErr.message);
    if (!existing) throw new NotFoundException('Asset object not found');

    const row = existing as Record<string, unknown>;
    const imagePath = row['image_path'] as string | null;

    if (imagePath) {
      await this.client.storage.from(IMAGES_BUCKET).remove([imagePath]);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update({ image_path: null, updated_by: userId })
      .eq('id', objectId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .select('*')
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to remove object image',
      );

    this.history
      .logChange(
        objectId,
        row.schema_id as string,
        organizationId,
        spaceId,
        'object_update',
        userId,
      )
      .catch(() => undefined);

    const updatedRow = data as Record<string, unknown>;

    void this.outboxService.write(
      organizationId,
      spaceId,
      'app.asset_object.image_removed',
      {
        asset: {
          id: objectId,
          name: updatedRow['name'] as string,
          schema_id: updatedRow['schema_id'] as string,
          object_type_id: updatedRow['object_type_id'] as string | null,
          space_id: spaceId,
          organization_id: organizationId,
        },
        asset_id: objectId,
        schema_id: updatedRow['schema_id'] as string,
        object_type_id: updatedRow['object_type_id'] as string | null,
        space_id: spaceId,
        organization_id: organizationId,
        image: { previous_path: imagePath },
        updated_by: userId,
      },
    );

    return updatedRow;
  }

  async getSchemaStats(
    schemaId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<{ total: number; updatedLast24h: number }> {
    const { count: total, error: e1 } = await this.client
      .from(TABLE)
      .select('*', { count: 'exact', head: true })
      .eq('schema_id', schemaId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_archived', false);

    if (e1) throw new BadRequestException(e1.message);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { count: updatedLast24h, error: e2 } = await this.client
      .from(TABLE)
      .select('*', { count: 'exact', head: true })
      .eq('schema_id', schemaId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_archived', false)
      .gte('updated_at', since);

    if (e2) throw new BadRequestException(e2.message);

    return { total: total ?? 0, updatedLast24h: updatedLast24h ?? 0 };
  }
}
