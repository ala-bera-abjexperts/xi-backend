/**
 * @fileoverview Automation action "Find Asset Object by name": resolves a name — normally a
 * `{{ }}` variable carrying a value someone submitted on a ticket form — to one asset object in a
 * chosen schema, and exposes its key, name and attributes to the later tasks in the run.
 *
 * It registers itself with the {@link ActionRegistryService} on module init, the same escape hatch
 * the Document Designer export action uses, because plain action definitions get no dependency
 * injection and this one needs the object-type ACL and the object read service. The dependency
 * points one way only (AssetsObjectsModule already imports AutomationsModule), so there is no cycle.
 *
 * Matching runs in LAYERS, and the first layer that matches anything wins:
 *  1. NAME — exact, case-insensitive, on a trimmed name. Unchanged, and still the only layer a value
 *     that resolves today ever reaches, so no saved automation changes behaviour.
 *  2. KEY — exact, case-insensitive (`searchSchemaObjects` matches `object_key` without wildcards).
 *  3. ATTRIBUTES — the same `contains` the schema search box uses, so an object reference, a user
 *     (matched on name OR email), a calculated formula value, a Yes/No and every other searchable
 *     attribute type behave here exactly as they do there.
 *
 * Layers 2 and 3 are reached ONLY when the name found nothing, which is what keeps the narrow name
 * rule intact: "SRV-001" still cannot quietly resolve to SRV-0010 while a real SRV-001 exists. Where
 * a `contains` hit is genuinely ambiguous the step FAILS as below rather than picking one.
 *
 * The Name may hold SEVERAL names — a multi-value variable, or commas/newlines — combined with the
 * Match operator (`any` = OR, the default; `all` = AND). The value as typed is always searched first,
 * so an object legitimately named "Dell, Inc." keeps resolving and no automation saved before this
 * existed changes behaviour; only when the whole value matches nothing is it treated as a list.
 *
 * Outcome contract, chosen with the user:
 *  - nothing found, an empty/unresolved name, or no accessible object type → the step SUCCEEDS with
 *    `found: false` and a `reason`, so a `control.condition` on `{{ …output.found }}` can branch and
 *    no later task ever receives stale data. A thrown error would cancel the whole run.
 *  - under `all`, a name that matched nothing → also a SUCCEEDED step, `reason: 'missing_names'`, so
 *    the same If/Else keeps working.
 *  - more than one match FOR ONE NAME → the step FAILS, naming the count and the matched keys. Asset
 *    names carry no unique constraint, so picking one arbitrarily could write the wrong asset into a
 *    ticket. That rule holds whether one name was searched or twenty.
 *  - more than one match from the KEY/ATTRIBUTE layers → the step SUCCEEDS with all of them in
 *    `objects` / `keys` / `names`. An attribute match is a `contains`, so several objects sharing a
 *    substring ("srv") is ordinary rather than an authoring mistake. The single-object fields stay
 *    null, so a later task still cannot read one arbitrary asset as though it were the answer.
 *  - `key` / `name` / `attributes` are filled only when EXACTLY one object matched; with several,
 *    later tasks read `keys` / `names` / `objects`.
 */

import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { ActionRegistryService } from '../../automations/actions/action-registry.service';
import type {
  ActionDefinition,
  ExecutionContext,
} from '../../automations/actions/types';
import { hasUnresolvedPlaceholder } from '../../automations/utils/template';
import { AssetObjectTypesService } from '../asset-object-types.service';
import { AssetObjectsService } from '../asset-objects.service';
import { escapeLikeValue } from '../filtering/asset-rule-translator';

const OBJECTS_TABLE = 'asset_objects';
const SCHEMAS_TABLE = 'asset_object_schemas';

/** Longest name an asset object can have (`app.asset_object.create` caps it), so nothing longer can exist. */
const MAX_NAME_LENGTH = 255;

/**
 * Sent to PostgREST as `object_type_id=in.(…)` only while the list stays inside the url budget the
 * asset field config already uses; beyond it the in-memory membership check alone does the scoping.
 */
const MAX_TYPE_IDS_IN_URL = 140;

/** One more than "ambiguous" needs, so >1 is detectable without reading a whole schema. */
const EXACT_PASS_LIMIT = 51;

/** Only reached when the exact pass found nothing — see the whitespace fallback below. */
const FALLBACK_PASS_LIMIT = 200;

/**
 * Rows the key/attribute pass may consider. Only ever used to decide "one object or ambiguous", so it
 * needs to be large enough to see a second match, not to page through everything.
 */
const KEY_ATTRIBUTE_PASS_LIMIT = 50;

/** `error_message` is truncated at 1000 chars, so only the first few keys are useful. */
const MAX_KEYS_IN_ERROR = 5;

/** An asset-type custom field stores the object's id, so a Name pointed at one resolves to a uuid. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What turns one Name value into a list. A newline can only come from a textarea or a joined array. */
const NAME_SEPARATOR_RE = /[,\n]/;

/** Each name costs its own search and its own enrichment read, so the list is bounded per node. */
const DEFAULT_MAX_NAMES = 20;

/** A hand-edited config cannot turn one step into thousands of round trips. */
const MAX_NAMES_CEILING = 200;

const configSchema = z.object({
  schemaId: z.string().min(1),
  objectTypeIds: z.array(z.string()).max(200).optional(),

  // Deliberately NOT `.min(1)` / `.max()`: a Zod failure is classified permanent and fails the whole
  // run, but an empty or oversized name has to degrade to `found: false` instead.
  name: z.string(),

  // Absent means 'any' — the dropdown is the only writer, and an older saved node has no value.
  nameMatch: z.enum(['any', 'all']).optional(),

  // Range-checked in code, not by Zod: a Zod failure is permanent, and a number the user can simply
  // retype must not kill the run.
  maxNames: z.number().optional(),
});

type FindAssetObjectConfig = z.infer<typeof configSchema>;

type FoundReason =
  | 'unresolved_variable'
  | 'empty_name'
  | 'name_too_long'
  | 'not_found'
  | 'not_permitted'
  | 'no_matching_object_types'
  | 'no_accessible_object_types'
  | 'missing_names';

interface ObjectRow {
  id: string;
  object_key: string;
  name: string;
  object_type_id: string | null;
  space_id: string;
  attribute_values: Record<string, unknown> | null;
}

/** Which object types this run may search, resolved once per run. */
interface TypeScope {
  typeIds: string[];
  typeNames: Map<string, string>;
  reason: FoundReason | null;

  /** The schema's space. Carried here so the key/attribute pass can reach it without re-loading. */
  spaceId: string;

  /**
   * The node's "Max names" setting, already range-checked.
   *
   * It bounds how many names are searched, and equally how many objects one value may return: an
   * attribute match is a `contains`, so a short value can hit far more objects than the person asked
   * to see. Same knob, so raising it raises both.
   */
  maxNames: number;
}

/** One matched object, as a later task sees it inside `objects`. */
interface FoundObject {
  id: string;
  key: string;
  name: string;
  objectTypeId: string | null;
  objectTypeName: string | null;
  attributes: Record<string, unknown>;
}

interface FindAssetObjectOutput {
  found: boolean;
  matchCount: number;
  missingCount: number;
  reason: FoundReason | null;
  id: string | null;
  key: string | null;
  name: string | null;
  objectTypeId: string | null;
  objectTypeName: string | null;
  schemaId: string;
  attributes: Record<string, unknown>;
  keys: string;
  names: string;
  notFoundNames: string;
  nameMatch: 'any' | 'all';
  objects: FoundObject[];
  notFound: string[];
}

/** Same key set whether or not something was found, so a later task never reads a key that vanished. */
function notFound(
  schemaId: string,
  reason: FoundReason,
  missing: string[] = [],
): FindAssetObjectOutput {
  return {
    found: false,
    matchCount: 0,
    missingCount: missing.length,
    reason,
    id: null,
    key: null,
    name: null,
    objectTypeId: null,
    objectTypeName: null,
    schemaId,
    attributes: {},
    keys: '',
    names: '',
    notFoundNames: missing.join(', '),
    nameMatch: 'any',
    objects: [],
    notFound: missing,
  };
}

/**
 * The one place that turns matches into the output.
 *
 * `id` / `key` / `name` / `attributes` are filled ONLY for a single match — with two objects in hand
 * there is no non-arbitrary answer, and a later task writing one of them into a ticket would be
 * writing the wrong asset. Use `keys` / `names` / `objects` for several.
 */
function composeOutput(
  objects: FoundObject[],
  missing: string[],
  missingCount: number,
  schemaId: string,
  requireAll: boolean,
): FindAssetObjectOutput {
  const single = objects.length === 1 ? objects[0] : null;
  const found = requireAll
    ? objects.length > 0 && missingCount === 0
    : objects.length > 0;

  return {
    found,
    matchCount: objects.length,
    missingCount,
    reason: found ? null : objects.length === 0 ? 'not_found' : 'missing_names',
    id: single?.id ?? null,
    key: single?.key ?? null,
    name: single?.name ?? null,
    objectTypeId: single?.objectTypeId ?? null,
    objectTypeName: single?.objectTypeName ?? null,
    schemaId,
    attributes: single?.attributes ?? {},
    keys: objects.map((obj) => obj.key).join(', '),
    names: objects.map((obj) => obj.name).join(', '),
    notFoundNames: missing.join(', '),
    nameMatch: requireAll ? 'all' : 'any',
    objects,
    notFound: missing,
  };
}

/** How many names this node may search — its own setting, or the default when it has none. */
function resolveMaxNames(configured: number | undefined): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return DEFAULT_MAX_NAMES;
  }

  return Math.min(Math.max(Math.trunc(configured), 1), MAX_NAMES_CEILING);
}

/** A multi-value custom field reaches the config as pretty-printed JSON, never as a joined string. */
function parseJsonArray(value: string): string[] | null {
  if (!value.startsWith('[')) return null;

  try {
    const parsed: unknown = JSON.parse(value);

    if (!Array.isArray(parsed)) return null;

    // `Array.isArray` narrows to `any[]`, which would make everything downstream unsafe.
    const entries = parsed as unknown[];

    return entries
      .map((entry) => (typeof entry === 'number' ? String(entry) : entry))
      .filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return null;
  }
}

/**
 * The names inside one Name value, or null when it holds a single name.
 *
 * Returning null for a value with no separator is what keeps every automation built before this
 * change on exactly the path it used: nothing is split unless there is something to split.
 */
function splitNames(raw: string): string[] | null {
  const value = raw.trim();
  const fromJson = parseJsonArray(value);

  if (fromJson) return fromJson.map((v) => v.trim()).filter((v) => v !== '');

  if (!NAME_SEPARATOR_RE.test(value)) return null;

  return value
    .split(NAME_SEPARATOR_RE)
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function flattenTypeTree(
  nodes: Record<string, unknown>[],
): Record<string, unknown>[] {
  return nodes.flatMap((node) => [
    node,
    ...flattenTypeTree((node['children'] ?? []) as Record<string, unknown>[]),
  ]);
}

@Injectable()
export class FindAssetObjectByNameAction implements OnModuleInit {
  private readonly logger = new Logger(FindAssetObjectByNameAction.name);

  constructor(
    private readonly registry: ActionRegistryService,
    private readonly objectTypesService: AssetObjectTypesService,
    private readonly assetObjectsService: AssetObjectsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.buildDefinition());
  }

  buildDefinition(): ActionDefinition {
    return {
      kind: 'app.asset_object.find_by_name',
      category: 'app_mutation',
      type: 'action',
      label: {
        en: 'Find Asset Object by name',
        de: 'Asset-Objekt nach Name suchen',
      },
      description: {
        en: 'Looks up asset objects by their exact name in a schema — one name, or several combined with Any/All — and exposes their keys, names and attributes to later tasks.',
        de: 'Sucht Asset-Objekte anhand ihres exakten Namens in einem Schema — ein Name oder mehrere, kombiniert mit Beliebig/Alle — und stellt Schlüssel, Namen und Attribute für weitere Aufgaben bereit.',
      },
      icon: 'bx-search-alt',
      inputSchema: z.unknown(),
      configSchema,
      outputSchema: z.object({
        found: z.boolean(),
        matchCount: z.number(),
        missingCount: z.number(),
        reason: z.string().nullable(),
        id: z.string().nullable(),
        key: z.string().nullable(),
        name: z.string().nullable(),
        objectTypeId: z.string().nullable(),
        objectTypeName: z.string().nullable(),
        schemaId: z.string(),
        attributes: z.record(z.string(), z.unknown()),
        keys: z.string(),
        names: z.string(),
        notFoundNames: z.string(),
        nameMatch: z.string(),
        objects: z.array(z.record(z.string(), z.unknown())),
        notFound: z.array(z.string()),
      }),
      handler: (config: unknown, _input: unknown, ctx: ExecutionContext) =>
        this.execute(configSchema.parse(config), ctx),
    };
  }

  private async execute(
    config: FindAssetObjectConfig,
    ctx: ExecutionContext,
  ): Promise<FindAssetObjectOutput> {
    const { schemaId } = config;
    const raw = config.name ?? '';
    const list = splitNames(raw);

    // A list of one is just a name with a stray comma — and a value with no separator at all never
    // becomes a list, which is what keeps every automation saved before this change on its old path.
    const single = !list ? raw.trim() : list.length === 1 ? list[0] : null;

    if (single !== null) {
      // `substitute()` leaves the placeholder text in place when an expression resolves to nothing,
      // so without this the search term would be the literal "{{ trigger.task.… }}".
      if (hasUnresolvedPlaceholder(single)) {
        ctx.logger.info(
          `Find Asset Object by name: the Name still contains an unresolved {{ }} for this trigger — nothing searched`,
        );

        return notFound(schemaId, 'unresolved_variable');
      }

      if (single === '') {
        ctx.logger.info(
          'Find Asset Object by name: the Name resolved to an empty value — nothing searched',
        );

        return notFound(schemaId, 'empty_name');
      }

      if (single.length > MAX_NAME_LENGTH) {
        ctx.logger.info(
          `Find Asset Object by name: the Name resolved to ${single.length} characters, longer than any asset object name can be — nothing searched`,
        );

        return notFound(schemaId, 'name_too_long');
      }
    } else if (list && list.length === 0) {
      ctx.logger.info(
        'Find Asset Object by name: the Name resolved to separators only — nothing searched',
      );

      return notFound(schemaId, 'empty_name');
    }

    const schema = await this.loadSchema(schemaId, ctx);

    const scope: TypeScope = {
      ...(await this.resolveTypeScope(config, schema.space_id, ctx)),
      spaceId: schema.space_id,
      maxNames: resolveMaxNames(config.maxNames),
    };

    if (scope.reason) return notFound(schemaId, scope.reason);

    if (single !== null) {
      return this.searchOne(single, schemaId, scope, ctx);
    }

    return this.searchMany(raw.trim(), list ?? [], config, scope, ctx);
  }

  /** One name — the original behaviour, unchanged, and still the path a single value takes. */
  private async searchOne(
    needle: string,
    schemaId: string,
    scope: TypeScope,
    ctx: ExecutionContext,
  ): Promise<FindAssetObjectOutput> {
    const matches = await this.matchesFor(needle, schemaId, scope, ctx);

    if (matches.length === 0) {
      ctx.logger.info(
        `Find Asset Object by name: no asset object named "${needle}" in this schema`,
      );

      return notFound(schemaId, 'not_found');
    }

    return this.outputForMatches(matches, scope, schemaId, ctx);
  }

  /**
   * Several names, combined with the Match operator.
   *
   * The value as typed is searched FIRST: asset names really do contain commas ("Dell, Inc."), and
   * splitting one unconditionally would break an automation that works today with no warning. Only
   * when the whole value matches nothing is it treated as a list.
   */
  private async searchMany(
    value: string,
    parts: string[],
    config: FindAssetObjectConfig,
    scope: TypeScope,
    ctx: ExecutionContext,
  ): Promise<FindAssetObjectOutput> {
    const { schemaId } = config;

    // Skipped for a JSON array (it can never be a name) and for a value still holding a {{ }},
    // which would search the placeholder text itself.
    const wholeValueIsSearchable =
      !value.startsWith('[') &&
      !hasUnresolvedPlaceholder(value) &&
      value.length <= MAX_NAME_LENGTH;

    if (wholeValueIsSearchable) {
      const whole = await this.matchesFor(value, schemaId, scope, ctx);

      // Several is now a real answer from the key/attribute pass, not a reason to fall through and
      // start splitting a value that already matched as written.
      if (whole.length > 0) {
        return this.outputForMatches(whole, scope, schemaId, ctx);
      }
    }

    const maxNames = resolveMaxNames(config.maxNames);
    const { usable, missing, missingCount } = this.planNames(
      parts,
      maxNames,
      ctx,
    );
    const found: FoundObject[] = [];
    const seenIds = new Set<string>();
    let missed = missingCount;

    // ponytail: one round trip per name, bounded by MAX_NAMES. Batching into a single `.or()` would
    // have to fight escapeFilterValue's quoting and the url budget for no gain at this size.
    for (const name of usable) {
      const matches = await this.matchesFor(name, schemaId, scope, ctx);

      if (matches.length === 0) {
        this.recordMissing(missing, name, maxNames);
        missed += 1;
        continue;
      }

      // Every match counts: one name can legitimately hit several objects through the key/attribute
      // pass, and keeping only the first would pick one of them arbitrarily.
      let resolved = 0;

      for (const row of matches) {
        // Two names — or two custom fields holding the same asset id — can land on one object.
        if (seenIds.has(row.id)) {
          resolved += 1;
          continue;
        }

        const object = await this.enrichObject(row, scope.typeNames, ctx);

        // Forbidden or vanished: skipped, and only a miss if nothing else resolved for this name.
        if (typeof object === 'string') continue;

        seenIds.add(row.id);
        found.push(object);
        resolved += 1;
      }

      if (resolved === 0) {
        this.recordMissing(missing, name, maxNames);
        missed += 1;
      }
    }

    ctx.logger.info(
      `Find Asset Object by name: ${usable.length} name(s) searched with Match "${config.nameMatch ?? 'any'}" — ${found.length} found, ${missed} missing`,
    );

    return composeOutput(
      found,
      missing,
      missed,
      schemaId,
      config.nameMatch === 'all',
    );
  }

  /**
   * The names actually worth a query: resolved, in range, de-duplicated and capped.
   *
   * A part that still holds a {{ }} is counted missing rather than abandoning the whole lookup, so
   * one empty variable among several no longer costs the names that did resolve.
   */
  private planNames(
    parts: string[],
    maxNames: number,
    ctx: ExecutionContext,
  ): { usable: string[]; missing: string[]; missingCount: number } {
    const usable: string[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    let missingCount = 0;

    for (const part of parts) {
      if (hasUnresolvedPlaceholder(part) || part.length > MAX_NAME_LENGTH) {
        this.recordMissing(missing, part, maxNames);
        missingCount += 1;
        continue;
      }

      const key = part.toLowerCase();

      if (seen.has(key)) continue;

      seen.add(key);

      if (usable.length >= maxNames) {
        this.recordMissing(missing, part, maxNames);
        missingCount += 1;
        continue;
      }

      usable.push(part);
    }

    if (missingCount > 0 && usable.length >= maxNames) {
      ctx.logger.info(
        `Find Asset Object by name: only the first ${maxNames} names were searched — raise "Max names" on this task to search more`,
      );
    }

    return { usable, missing, missingCount };
  }

  /** `missingCount` stays exact; the reported list is capped so a runaway variable cannot bloat it. */
  private recordMissing(
    missing: string[],
    name: string,
    maxNames: number,
  ): void {
    if (missing.length < maxNames) missing.push(name);
  }

  /**
   * Every match for one name, with the id→name conversion and the ambiguity rule applied.
   *
   * An asset-type custom field hands over the object's id, never its name. Turning it into the name
   * first keeps the task what it says it is — a name match, with the same schema, object-type and
   * ambiguity rules as any other value.
   *
   * A uuid that turns out NOT to be an asset id in scope falls through to the plain search: names
   * that look like ids exist, and "it resembled an id" must never cost the search itself.
   */
  private async matchesFor(
    needle: string,
    schemaId: string,
    scope: TypeScope,
    ctx: ExecutionContext,
  ): Promise<ObjectRow[]> {
    const searchFor = UUID_RE.test(needle)
      ? ((await this.nameOfObjectId(needle, schemaId, scope.typeIds, ctx)) ??
        needle)
      : needle;

    const matches = await this.findMatches(
      searchFor,
      schemaId,
      scope.typeIds,
      ctx,
    );

    if (matches.length > 0) {
      if (matches.length > 1) throw this.ambiguous(matches, searchFor);

      return matches;
    }

    // Only once the name found nothing. Keeping the name pass first is what makes this safe to add:
    // a value that resolves today takes exactly the path it always did, so no saved automation can
    // start matching a different object — or start failing as newly ambiguous.
    const wider = await this.matchesByKeyOrAttribute(
      searchFor,
      schemaId,
      scope,
      ctx,
    );

    // Deliberately NOT subject to the single-match rule above. A key is exact, but an attribute match
    // is a `contains`, so several objects sharing a substring ("srv") is ordinary rather than a
    // mistake — failing the step there would block a search that worked exactly as asked. All of them
    // are returned instead, and `composeOutput` leaves the single-object fields null so no later task
    // can read one arbitrary asset as if it were the answer.
    return wider;
  }

  /**
   * Asset names carry no unique constraint, so two objects can share one. Picking either could write
   * the wrong asset into a ticket — the step fails instead, whether it was searching one name or
   * twenty.
   *
   * The "(400)" marks this permanent so the step fails immediately instead of retrying 3× —
   * re-running cannot make an ambiguous name unambiguous.
   */
  private ambiguous(matches: ObjectRow[], searchFor: string): Error {
    const keys = matches
      .slice(0, MAX_KEYS_IN_ERROR)
      .map((row) => row.object_key)
      .join(', ');
    const more =
      matches.length > MAX_KEYS_IN_ERROR
        ? `, +${matches.length - MAX_KEYS_IN_ERROR} more`
        : '';

    return new Error(
      `Find Asset Object by name (400): ${matches.length} asset objects in this schema are named "${searchFor}" (${keys}${more}) — narrow the search with Object types, or make the name unique.`,
    );
  }

  /**
   * The name of the object with this id, or null when the id is not one this node may search.
   *
   * Scoped to the schema AND the configured object types on purpose: resolving an id from outside
   * the node's scope and then searching for that name here could return a different object that
   * happens to share it.
   */
  private async nameOfObjectId(
    id: string,
    schemaId: string,
    typeIds: string[],
    ctx: ExecutionContext,
  ): Promise<string | null> {
    let query = ctx.supabase
      .from(OBJECTS_TABLE)
      .select('name, object_type_id')
      .eq('id', id)
      .eq('organization_id', ctx.organizationId)
      .eq('schema_id', schemaId)
      .eq('is_archived', false);

    // Same scope as the search itself: an id pointing at a type this node may not search must not
    // be honoured through the back door.
    if (typeIds.length > 0 && typeIds.length <= MAX_TYPE_IDS_IN_URL) {
      query = query.in('object_type_id', typeIds);
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      throw new Error(
        `Find Asset Object by name: could not read the asset object behind the id — ${error.message}`,
      );
    }

    const row = data as {
      name?: string;
      object_type_id?: string | null;
    } | null;
    const name = row?.name;

    // Repeated in memory for the case where the id list was too long to send as a filter.
    if (
      row &&
      typeIds.length > 0 &&
      !typeIds.includes(row.object_type_id ?? '')
    ) {
      return null;
    }

    if (typeof name !== 'string' || name.trim() === '') return null;

    ctx.logger.info(
      `Find Asset Object by name: the Name resolved to an asset id — searching for its name "${name.trim()}" instead`,
    );

    return name.trim();
  }

  /** The schema is the one piece of config that must still exist, so a stale id fails loudly. */
  private async loadSchema(
    schemaId: string,
    ctx: ExecutionContext,
  ): Promise<{ space_id: string }> {
    const { data, error } = await ctx.supabase
      .from(SCHEMAS_TABLE)
      .select('id, space_id, is_archived')
      .eq('id', schemaId)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle();

    if (error) {
      throw new Error(
        `Find Asset Object by name: could not read the asset schema — ${error.message}`,
      );
    }

    const row = data as {
      space_id: string;
      is_archived: boolean | null;
    } | null;

    if (!row || row.is_archived === true) {
      throw new Error(
        `Find Asset Object by name (400): asset schema ${schemaId} was not found in this organization — was it deleted, or does the automation belong to another organization?`,
      );
    }

    return { space_id: row.space_id };
  }

  /**
   * Which object types this run may search.
   *
   * `getTree` is the ACL source rather than a per-type `getMyPermission` because it resolves the whole
   * schema in two queries AND propagates a hidden parent to its descendants — a per-type check does
   * not, so it would disagree with the tree the user sees in the UI.
   *
   * Only view permission narrows the list. `is_abstract` / `is_active` are picker concerns: treating
   * them as exclusions here would silently hide the objects of a type that was merely deactivated.
   */
  private async resolveTypeScope(
    config: FindAssetObjectConfig,
    schemaSpaceId: string,
    ctx: ExecutionContext,
  ): Promise<Omit<TypeScope, 'spaceId' | 'maxNames'>> {
    // `getTree` skips permission filtering entirely when there is no user — an automation running as
    // a service principal therefore sees every type, which matches every other app action.
    if (!ctx.actingUserId) {
      ctx.logger.info(
        'Find Asset Object by name: no acting user for this run — object type permissions are not applied',
      );
    }

    const tree = await this.objectTypesService.getTree(
      config.schemaId,
      schemaSpaceId,
      ctx.organizationId,
      ctx.actingUserId ?? undefined,
    );

    const viewable = flattenTypeTree(tree);
    const typeNames = new Map<string, string>();

    for (const type of viewable) {
      typeNames.set(type['id'] as string, (type['name'] as string) ?? '');
    }

    const configured = (config.objectTypeIds ?? []).filter(
      (id) => typeof id === 'string' && id.trim() !== '',
    );

    if (configured.length === 0) {
      if (viewable.length === 0) {
        ctx.logger.info(
          `Find Asset Object by name: no object type of schema ${config.schemaId} is visible to this run`,
        );

        return {
          typeIds: [],
          typeNames,
          reason: 'no_accessible_object_types',
        };
      }

      return { typeIds: [...typeNames.keys()], typeNames, reason: null };
    }

    const effective = configured.filter((id) => typeNames.has(id));

    if (effective.length === 0) {
      // Two different causes, kept apart on purpose: the builder's picker lists the types the EDITING
      // user can see, while the run filters by the run-as user's.
      const reason: FoundReason =
        viewable.length === 0
          ? 'no_accessible_object_types'
          : 'no_matching_object_types';

      ctx.logger.info(
        `Find Asset Object by name: none of the configured object types belong to schema ${config.schemaId} or are visible to this run (${reason})`,
      );

      return { typeIds: [], typeNames, reason };
    }

    return { typeIds: effective, typeNames, reason: null };
  }

  /**
   * Key and attribute fallback — reached only when the name search found nothing.
   *
   * Delegates to the same schema search the Assets page uses, so an object key, an object reference,
   * a user (matched on name OR email), a calculated formula value, a Yes/No and every other
   * searchable attribute type behave here exactly as they do there, all case-insensitively. That
   * search already tries an exact key first and only then attributes, which is the precedence this
   * action wants anyway.
   *
   * Its own permission filtering is by object type, and this node's configured Object types are
   * applied on top — a type outside the node's scope can never be reached through this path.
   */
  private async matchesByKeyOrAttribute(
    needle: string,
    schemaId: string,
    scope: TypeScope,
    ctx: ExecutionContext,
  ): Promise<ObjectRow[]> {
    // The shared search resolves object-type visibility per user. With no acting user there is
    // nobody to resolve it for, so the widening is skipped rather than guessed at.
    if (!ctx.actingUserId) return [];

    let ids: string[];

    try {
      const found = await this.assetObjectsService.searchSchemaObjects(
        schemaId,
        scope.spaceId,
        ctx.organizationId,
        ctx.actingUserId,
        needle,
        1,

        // One more than the person asked for, so "there are more than this" is still detectable
        // before the list is trimmed below.
        Math.min(scope.maxNames + 1, KEY_ATTRIBUTE_PASS_LIMIT),
      );

      ids = found.data
        .map((row) => {
          const id = (row as { id?: unknown }).id;

          // Narrowed rather than stringified: the search returns Record<string, unknown>, and
          // String() on a non-string would silently produce "[object Object]" as an id.
          return typeof id === 'string' ? id : '';
        })
        .filter(Boolean);
    } catch (error) {
      // A failure while widening must not turn a clean "not found" into a failed step: the name pass
      // has already reported nothing, and this pass only ever adds results.
      const message = error instanceof Error ? error.message : String(error);

      ctx.logger.info(
        `Find Asset Object by name: key/attribute search failed, keeping the name result — ${message}`,
      );

      return [];
    }

    if (ids.length === 0) return [];

    const rows = await this.rowsByIds(ids, schemaId, scope.typeIds, ctx);

    if (rows.length <= scope.maxNames) return rows;

    // Saying so matters: a `contains` on an attribute can match far more objects than the person
    // expected, and a silently shortened list reads exactly like a complete one.
    ctx.logger.info(
      `Find Asset Object by name: "${needle}" matched ${rows.length} objects by key or attribute — showing the first ${scope.maxNames}, raise "Max names" on this task to see more`,
    );

    return rows.slice(0, scope.maxNames);
  }

  /**
   * The full rows for ids the key/attribute pass returned.
   *
   * Re-read rather than reshaped: that search selects a display subset, while the output of this
   * action carries `attribute_values` and `space_id`. Re-applying org, schema, archived and the
   * object-type scope keeps this read under exactly the same rules as the name pass.
   */
  private async rowsByIds(
    ids: string[],
    schemaId: string,
    typeIds: string[],
    ctx: ExecutionContext,
  ): Promise<ObjectRow[]> {
    let query = ctx.supabase
      .from(OBJECTS_TABLE)
      .select(
        'id, object_key, name, object_type_id, space_id, attribute_values',
      )
      .in('id', ids)
      .eq('organization_id', ctx.organizationId)
      .eq('schema_id', schemaId)
      .eq('is_archived', false);

    if (typeIds.length > 0 && typeIds.length <= MAX_TYPE_IDS_IN_URL) {
      query = query.in('object_type_id', typeIds);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(
        `Find Asset Object by name: asset object lookup failed — ${error.message}`,
      );
    }

    const rows = (data ?? []) as ObjectRow[];

    // `.in()` cannot express the scope when the list is too long for a URL, so it is applied here
    // too — the same guard the name pass relies on.
    return typeIds.length > MAX_TYPE_IDS_IN_URL
      ? rows.filter(
          (row) =>
            row.object_type_id !== null && typeIds.includes(row.object_type_id),
        )
      : rows;
  }

  /**
   * Exact match first; a contains pass only if that found nothing.
   *
   * The fallback exists because stored names really do carry stray whitespace (" Laptop-D"), which an
   * exact comparison can never reach. It does NOT widen the matching rule: every row from either pass
   * goes through the same trimmed, case-insensitive equality check below.
   */
  private async findMatches(
    needle: string,
    schemaId: string,
    typeIds: string[],
    ctx: ExecutionContext,
  ): Promise<ObjectRow[]> {
    // `escapeLikeValue` neutralises % and _ but not *, which PostgREST rewrites into %. Turning it
    // into `_` (exactly one character) keeps the real row inside the result set — escaping it is not
    // an option, because PostgREST would rewrite the escape as well.
    const escaped = escapeLikeValue(needle).replace(/\*/g, '_');

    const exact = await this.queryObjects(
      escaped,
      schemaId,
      typeIds,
      EXACT_PASS_LIMIT,
      ctx,
    );
    const matches = this.keepTrueMatches(exact, needle, typeIds);

    if (matches.length > 0) return matches;

    const fallback = await this.queryObjects(
      `%${escaped}%`,
      schemaId,
      typeIds,
      FALLBACK_PASS_LIMIT,
      ctx,
    );

    return this.keepTrueMatches(fallback, needle, typeIds);
  }

  private async queryObjects(
    pattern: string,
    schemaId: string,
    typeIds: string[],
    limit: number,
    ctx: ExecutionContext,
  ): Promise<ObjectRow[]> {
    let query = ctx.supabase
      .from(OBJECTS_TABLE)
      .select(
        'id, object_key, name, object_type_id, space_id, attribute_values',
      )
      .eq('organization_id', ctx.organizationId)
      .eq('schema_id', schemaId)
      .eq('is_archived', false)
      .ilike('name', pattern)
      .limit(limit);

    if (typeIds.length > 0 && typeIds.length <= MAX_TYPE_IDS_IN_URL) {
      query = query.in('object_type_id', typeIds);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(
        `Find Asset Object by name: asset object lookup failed — ${error.message}`,
      );
    }

    return (data ?? []) as ObjectRow[];
  }

  /**
   * The only place that decides what "the same name" means.
   *
   * Runs in memory rather than trusting the SQL pattern, so a name containing `*` (or any other
   * PostgREST pattern character) can never widen the result, and the object-type scope holds even
   * when the id list was too long to send as a filter.
   */
  private keepTrueMatches(
    rows: ObjectRow[],
    needle: string,
    typeIds: string[],
  ): ObjectRow[] {
    const wanted = needle.toLowerCase();
    const allowed = new Set(typeIds);

    return rows.filter((row) => {
      if (typeof row.name !== 'string') return false;
      if (row.name.trim().toLowerCase() !== wanted) return false;

      return allowed.size === 0 || allowed.has(row.object_type_id ?? '');
    });
  }

  /**
   * Re-reads the one match through `getOne` so the attributes are the same ones the object detail
   * page shows — formula attributes are computed on read and are absent from the stored blob — and
   * so the acting user's view permission is checked a second time, this time per object.
   */
  /**
   * The output for however many objects one value matched.
   *
   * One match keeps the original single-object shape. Several — only possible from the key/attribute
   * pass, since a name still has to be unique — fill `objects` / `keys` / `names` while `id`, `key`,
   * `name` and `attributes` stay null, which is the contract `composeOutput` already documents.
   *
   * An object the run may not see is dropped rather than failing the step: confirming it exists would
   * leak it, and the remaining matches are still a valid answer.
   */
  private async outputForMatches(
    matches: ObjectRow[],
    scope: TypeScope,
    schemaId: string,
    ctx: ExecutionContext,
  ): Promise<FindAssetObjectOutput> {
    if (matches.length === 1) {
      return this.buildOutput(matches[0], scope.typeNames, schemaId, ctx);
    }

    const objects: FoundObject[] = [];

    for (const row of matches) {
      const object = await this.enrichObject(row, scope.typeNames, ctx);

      if (typeof object !== 'string') objects.push(object);
    }

    if (objects.length === 0) return notFound(schemaId, 'not_found');

    return composeOutput(objects, [], 0, schemaId, false);
  }

  private async buildOutput(
    row: ObjectRow,
    typeNames: Map<string, string>,
    schemaId: string,
    ctx: ExecutionContext,
  ): Promise<FindAssetObjectOutput> {
    const object = await this.enrichObject(row, typeNames, ctx);

    if (typeof object === 'string') {
      // Reported as "not found" rather than a permission error on purpose: the alternative confirms
      // the existence of an object the run is not allowed to see.
      return notFound(schemaId, object);
    }

    return composeOutput([object], [], 0, schemaId, false);
  }

  /**
   * One row as a later task sees it, or the reason it had to be skipped.
   *
   * The reason comes back as a value rather than living on the service: this is a singleton, and two
   * tickets firing at once would otherwise overwrite each other's outcome.
   *
   * Re-reads the match through `getOne` so the attributes are the same ones the object detail page
   * shows — formula attributes are computed on read and are absent from the stored blob — and so the
   * acting user's view permission is checked a second time, this time per object.
   */
  private async enrichObject(
    row: ObjectRow,
    typeNames: Map<string, string>,
    ctx: ExecutionContext,
  ): Promise<FoundObject | 'not_permitted' | 'not_found'> {
    const base: FoundObject = {
      id: row.id,
      key: row.object_key,
      name: row.name,
      objectTypeId: row.object_type_id,
      objectTypeName: row.object_type_id
        ? (typeNames.get(row.object_type_id) ?? null)
        : null,
      attributes: row.attribute_values ?? {},
    };

    if (!ctx.actingUserId) {
      // Without a user there is nobody to check `getOne`'s view permission against, so the stored
      // values are returned as they are — formula attributes are computed on read and stay absent.
      ctx.logger.info(
        `Find Asset Object by name: matched ${row.object_key} — formula attributes were not evaluated because the run has no acting user`,
      );

      return base;
    }

    try {
      // The row's OWN space, not the schema's: an object created by an automation carries the
      // automation's space, which is not guaranteed to be the schema's.
      const enriched: Record<string, unknown> =
        await this.assetObjectsService.getOne(
          row.id,
          row.space_id,
          ctx.organizationId,
          ctx.actingUserId,
        );

      const attributes =
        (enriched['attribute_values'] as Record<string, unknown> | null) ?? {};

      return {
        ...base,
        name: (enriched['name'] as string) ?? row.name,
        attributes,
      };
    } catch (err) {
      if (err instanceof ForbiddenException) {
        ctx.logger.info(
          `Find Asset Object by name: "${row.name}" exists but this run may not view objects of its type`,
        );

        return 'not_permitted';
      }

      // Archived or deleted between the search and the read.
      ctx.logger.info(
        `Find Asset Object by name: ${row.object_key} disappeared while it was being read — ${(err as Error)?.message ?? String(err)}`,
      );

      return 'not_found';
    }
  }
}
