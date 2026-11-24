/**
 * @fileoverview Pure SCIM 2.0 helpers for Microsoft Entra ID provisioning: the
 * PATCH normaliser, the filter parser, paging, and resource/error builders.
 * @module src/sso/scim.util
 */

import { HttpException, HttpStatus } from '@nestjs/common';

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_LIST_SCHEMA =
  'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

/** Upper bound for `count` and the advertised `filter.maxResults`. */
export const SCIM_MAX_RESULTS = 100;

/** Static `GET /ServiceProviderConfig` document. */
export const SCIM_SERVICE_PROVIDER_CONFIG = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: SCIM_MAX_RESULTS },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: 'oauthbearertoken',
      name: 'OAuth Bearer Token',
      description: 'Authentication with a workspace SCIM token',
      primary: true,
    },
  ],
};

/**
 * Normalised result of a SCIM PATCH request. Only the attributes this API
 * supports are kept; everything else in the request is ignored.
 */
export interface IScimPatch {
  active?: boolean;
  userName?: string;
  externalId?: string | null;
  givenName?: string;
  familyName?: string;
  displayName?: string;
  addMembers: string[];
  removeMembers: string[];
}

/** A parsed `attr eq "value"` filter (plus the Entra group-membership probe). */
export interface IScimFilter {
  attribute: string;
  value: string;
  /** Set only for `id eq "x" and members[value eq "y"]`. */
  memberValue?: string;
}

/** Minimal `public.users` shape needed to render a SCIM User. */
export interface IScimUserSource {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

/** Minimal `scim_links` shape needed to render a SCIM User. */
export interface IScimUserLinkSource {
  user_name: string;
  external_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Minimal `user_groups` shape needed to render a SCIM Group. */
export interface IScimGroupSource {
  id: string;
  name: string;
  created_at: string | null;
  updated_at: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EQ_FILTER = /^\s*([A-Za-z][\w.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;
const ID_MEMBER_FILTER =
  /^\s*id\s+eq\s+"((?:[^"\\]|\\.)*)"\s+and\s+members\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]\s*$/i;
const MEMBER_PATH = /^members\[\s*value\s+eq\s+"((?:[^"\\]|\\.)*)"\s*\]$/i;
const CORE_URN_PREFIX =
  /^urn:ietf:params:scim:schemas:core:2\.0:(user|group):/i;

/**
 * Builds an HttpException that {@link ScimExceptionFilter} renders as a SCIM error.
 *
 * @param {HttpStatus} status - HTTP status code
 * @param {string} detail - Human-readable detail (never internals)
 * @param {string} [scimType] - RFC 7644 scimType, e.g. `uniqueness`
 * @returns {HttpException} The exception to throw
 */
export function scimError(
  status: HttpStatus,
  detail: string,
  scimType?: string,
): HttpException {
  return new HttpException({ message: detail, scimType }, status);
}

/** True when the value is a UUID string (anything else can never be a SCIM id). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Lowercases a SCIM `userName` and requires it to look like an email address.
 *
 * @throws {HttpException} 400 `invalidValue` when it is not an email
 */
export function normalizeScimUserName(value: unknown): string {
  const userName = typeof value === 'string' ? value.trim().toLowerCase() : '';

  if (!EMAIL_RE.test(userName)) {
    throw scimError(
      HttpStatus.BAD_REQUEST,
      'userName must be an email address',
      'invalidValue',
    );
  }

  return userName;
}

/**
 * Parses SCIM `active`. Entra sends booleans or the strings "True"/"False".
 *
 * @throws {HttpException} 400 `invalidValue` for anything else
 */
export function parseScimActive(value: unknown): boolean {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string' && /^(true|false)$/i.test(value)) {
    return value.toLowerCase() === 'true';
  }

  throw scimError(
    HttpStatus.BAD_REQUEST,
    'active must be a boolean',
    'invalidValue',
  );
}

/**
 * Parses an anchored `attr eq "value"` filter. When `attributes` includes `id`,
 * the Entra membership probe `id eq "x" and members[value eq "y"]` is accepted too.
 *
 * @param {unknown} filter - Raw `filter` query value
 * @param {readonly string[]} attributes - Filterable attributes (canonical case)
 * @returns {IScimFilter | null} The filter, or null when none was given
 * @throws {HttpException} 400 `invalidFilter` for anything else
 */
export function parseScimFilter(
  filter: unknown,
  attributes: readonly string[],
): IScimFilter | null {
  if (filter === undefined || filter === '') return null;

  if (typeof filter === 'string') {
    const composite = attributes.includes('id')
      ? ID_MEMBER_FILTER.exec(filter)
      : null;

    if (composite) {
      return {
        attribute: 'id',
        value: unescapeQuoted(composite[1]),
        memberValue: unescapeQuoted(composite[2]),
      };
    }

    const match = EQ_FILTER.exec(filter);
    const attribute =
      match &&
      attributes.find((name) => name.toLowerCase() === match[1].toLowerCase());

    if (match && attribute) {
      return { attribute, value: unescapeQuoted(match[2]) };
    }
  }

  throw scimError(
    HttpStatus.BAD_REQUEST,
    'Unsupported filter',
    'invalidFilter',
  );
}

/**
 * Parses 1-based `startIndex` and `count` (capped at {@link SCIM_MAX_RESULTS}).
 */
export function parseScimPaging(
  startIndex: unknown,
  count: unknown,
): { startIndex: number; count: number } {
  const start = Number.parseInt(
    typeof startIndex === 'string' ? startIndex : '',
    10,
  );
  const size = Number.parseInt(typeof count === 'string' ? count : '', 10);

  return {
    startIndex: Number.isFinite(start) && start > 0 ? start : 1,
    // ponytail: count=0 is served as 1; add a head-only count query if a client needs it.
    count: Number.isFinite(size)
      ? Math.min(Math.max(size, 1), SCIM_MAX_RESULTS)
      : SCIM_MAX_RESULTS,
  };
}

/**
 * Normalises both Entra PATCH dialects (path + value, and path-less value
 * objects with nested or dotted keys) into one {@link IScimPatch}.
 * Unsupported attributes such as `emails[type eq "work"].value` or the
 * enterprise `manager` are ignored.
 *
 * @throws {HttpException} 400 `invalidSyntax` / `invalidValue` on malformed input
 */
export function normalizeScimPatch(body: Record<string, unknown>): IScimPatch {
  const operations = body?.Operations;

  if (!Array.isArray(operations)) {
    throw scimError(
      HttpStatus.BAD_REQUEST,
      'Operations must be an array',
      'invalidSyntax',
    );
  }

  const patch: IScimPatch = { addMembers: [], removeMembers: [] };

  for (const operation of operations as unknown[]) {
    const { op, path, value } = isObject(operation) ? operation : {};
    const verb = typeof op === 'string' ? op.toLowerCase() : '';

    if (verb !== 'add' && verb !== 'replace' && verb !== 'remove') {
      throw scimError(
        HttpStatus.BAD_REQUEST,
        'Unsupported PATCH operation',
        'invalidSyntax',
      );
    }

    if (typeof path === 'string' && path.trim()) {
      applyPath(patch, verb, path.trim(), value);
    } else if (isObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        applyPath(patch, verb, key, item);
      }
    }
  }

  return patch;
}

/** Renders a SCIM User from its account row and SCIM link. */
export function buildScimUser(
  baseUrl: string,
  user: IScimUserSource,
  link: IScimUserLinkSource,
) {
  const displayName = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(' ');

  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    externalId: link.external_id ?? undefined,
    userName: link.user_name,
    name: {
      givenName: user.first_name || undefined,
      familyName: user.last_name || undefined,
    },
    displayName: displayName || user.email,
    emails: [{ value: user.email, type: 'work', primary: true }],
    active: link.is_active,
    meta: {
      resourceType: 'User',
      created: link.created_at,
      lastModified: link.updated_at,
      location: `${baseUrl}/Users/${user.id}`,
    },
  };
}

/** Renders a SCIM Group; `memberIds` undefined omits `members`. */
export function buildScimGroup(
  baseUrl: string,
  group: IScimGroupSource,
  externalId: string | null,
  memberIds?: string[],
) {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: group.id,
    externalId: externalId ?? undefined,
    displayName: group.name,
    members: memberIds?.map((value) => ({ value })),
    meta: {
      resourceType: 'Group',
      created: group.created_at ?? undefined,
      lastModified: group.updated_at ?? undefined,
      location: `${baseUrl}/Groups/${group.id}`,
    },
  };
}

/** Wraps resources in a SCIM ListResponse. */
export function buildScimList(
  resources: unknown[],
  totalResults: number,
  startIndex: number,
) {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

function applyPath(
  patch: IScimPatch,
  op: 'add' | 'replace' | 'remove',
  rawPath: string,
  value: unknown,
): void {
  const path = rawPath.replace(CORE_URN_PREFIX, '');
  const memberFilter = MEMBER_PATH.exec(path);

  if (memberFilter) {
    if (op === 'remove') {
      setMember(patch, unescapeQuoted(memberFilter[1]), false);
    }

    return;
  }

  const attribute = path.toLowerCase();

  if (attribute === 'members') {
    for (const member of Array.isArray(value) ? value : [value]) {
      if (isObject(member) && typeof member.value === 'string') {
        setMember(patch, member.value, op !== 'remove');
      }
    }

    return;
  }

  // Removing a scalar attribute is not supported; it is ignored like any
  // other unsupported attribute.
  if (op === 'remove') return;

  switch (attribute) {
    case 'active':
      patch.active = parseScimActive(value);
      return;
    case 'username':
      patch.userName = requireString(value, 'userName');
      return;
    case 'externalid':
      patch.externalId = value === null ? null : requireString(value, path);
      return;
    case 'displayname':
      patch.displayName = requireString(value, 'displayName');
      return;
    case 'name.givenname':
      if (typeof value === 'string') patch.givenName = value;
      return;
    case 'name.familyname':
      if (typeof value === 'string') patch.familyName = value;
      return;
    case 'name':
      if (isObject(value)) {
        for (const [key, item] of Object.entries(value)) {
          applyPath(patch, op, `name.${key}`, item);
        }
      }
      return;
    default:
      // emails[type eq "work"].value, enterprise manager, etc.
      return;
  }
}

function setMember(patch: IScimPatch, id: string, add: boolean): void {
  const [target, other] = add
    ? [patch.addMembers, patch.removeMembers]
    : [patch.removeMembers, patch.addMembers];
  const index = other.indexOf(id);

  if (index >= 0) other.splice(index, 1);
  if (!target.includes(id)) target.push(id);
}

function requireString(value: unknown, attribute: string): string {
  if (typeof value !== 'string') {
    throw scimError(
      HttpStatus.BAD_REQUEST,
      `${attribute} must be a string`,
      'invalidValue',
    );
  }

  return value;
}

function unescapeQuoted(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
