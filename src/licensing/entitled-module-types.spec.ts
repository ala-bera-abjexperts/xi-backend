/**
 * @fileoverview The space_modules entitlement filter.
 * @module licensing/entitled-module-types.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * `space_modules` was the one module registry licensing never consulted. Rows
 * are seeded per space by the `create_default_space_modules` trigger and were
 * read back verbatim into the sidebar payload, the MCP space payloads and the
 * support-request module picker. A tenant with no `module_file_explorer`
 * entitlement was therefore told the module was enabled, clicked it, and got a
 * 403 from `@RequireFeature`.
 *
 * The filter closes the gap between what is LISTED and what is ENFORCED. It is
 * explicitly not a security boundary — the controller decorators are — so the
 * tests below pin the two directions that matter: it must not hide a module the
 * tenant is entitled to, and it must not invent an entitlement for a module type
 * the catalog does not map.
 */

import { EntitlementsService } from './entitlements.service';
import { MODULE_TYPE_TO_FEATURE_KEY } from '../organization-modules/module-feature-map';
import { ACTIVE_SPACE_MODULE_TYPES } from '../spaces/space-module-types';

/** Entitled to everything. */
const allowAll = () => true;

/** Entitled to nothing. */
const denyAll = () => false;

describe('EntitlementsService.filterModuleTypesBy', () => {
  it('keeps every module when the tenant is entitled to everything', () => {
    const input = [...ACTIVE_SPACE_MODULE_TYPES];

    expect(EntitlementsService.filterModuleTypesBy(input, allowAll)).toEqual(
      input,
    );
  });

  it('drops every mapped module when the tenant is entitled to nothing', () => {
    const input = [...ACTIVE_SPACE_MODULE_TYPES];
    const kept = EntitlementsService.filterModuleTypesBy(input, denyAll);

    // Every active space module type has a catalog key, so nothing survives.
    // If this ever stops being true the assertion below tells you which.
    expect(kept).toEqual([]);
  });

  it('maps every active space module type to a catalog key', () => {
    // The filter keeps unmapped types (see next test). That fallback must not
    // become the normal path — an unmapped type is silently unlicensable.
    const unmapped = ACTIVE_SPACE_MODULE_TYPES.filter(
      (type) =>
        !MODULE_TYPE_TO_FEATURE_KEY[
          type as keyof typeof MODULE_TYPE_TO_FEATURE_KEY
        ],
    );

    expect(unmapped).toEqual([]);
  });

  it('keeps a module type the catalog does not map', () => {
    // Matches OrganizationModulesService.isEnabled, where an unmapped type falls
    // through to the legacy toggle instead of being denied. Denying here would
    // make an unrecognised row disappear from the sidebar with no diagnostic.
    expect(
      EntitlementsService.filterModuleTypesBy(['not_a_real_module'], denyAll),
    ).toEqual(['not_a_real_module']);
  });

  it('filters per module rather than all-or-nothing', () => {
    const entitled = new Set(['module_wiki', 'module_tasks']);
    const kept = EntitlementsService.filterModuleTypesBy(
      ['wiki', 'tasks', 'file_explorer', 'form_builder'],
      (key) => entitled.has(key),
    );

    expect(kept).toEqual(['wiki', 'tasks']);
  });

  it('preserves input order', () => {
    // The caller passes rows already ordered by sort_order; reordering here
    // would silently reshuffle the sidebar.
    const kept = EntitlementsService.filterModuleTypesBy(
      ['plans', 'wiki', 'boards'],
      allowAll,
    );

    expect(kept).toEqual(['plans', 'wiki', 'boards']);
  });

  it('returns a new array rather than mutating the input', () => {
    const input = ['wiki', 'file_explorer'];

    EntitlementsService.filterModuleTypesBy(input, denyAll);

    expect(input).toEqual(['wiki', 'file_explorer']);
  });
});

describe('EntitlementsService.filterEntitledModuleTypes', () => {
  /**
   * A real instance (so the method under test is the real one) with only the
   * dependency it actually touches stubbed. Built via Object.create rather than
   * `new` because the constructor wants the repository and logger, neither of
   * which this path uses.
   */
  function serviceWith(resolveEntitlements: () => Promise<unknown>) {
    const service = Object.create(
      EntitlementsService.prototype,
    ) as EntitlementsService;

    Object.assign(service, { getEffectiveEntitlements: resolveEntitlements });

    return service;
  }

  it('short-circuits an empty list without resolving entitlements', async () => {
    let resolved = false;
    const service = serviceWith(() => {
      resolved = true;

      return Promise.resolve(null);
    });

    await expect(
      service.filterEntitledModuleTypes('org-1', []),
    ).resolves.toEqual([]);
    expect(resolved).toBe(false);
  });

  it('keeps everything for a grandfathered tenant', async () => {
    // A grandfathered tenant has has()===true for every key, which is what makes
    // introducing licensing safe for tenants that never held a licence.
    const service = serviceWith(() =>
      Promise.resolve({ grandfathered: true, has: allowAll }),
    );

    await expect(
      service.filterEntitledModuleTypes('org-1', [
        'wiki',
        'file_explorer',
        'form_builder',
      ]),
    ).resolves.toEqual(['wiki', 'file_explorer', 'form_builder']);
  });

  it('drops unentitled modules for a locked tenant', async () => {
    const free = new Set(['module_wiki', 'module_tasks']);
    const service = serviceWith(() =>
      Promise.resolve({
        grandfathered: false,
        has: (key: string) => free.has(key),
      }),
    );

    await expect(
      service.filterEntitledModuleTypes('org-1', [
        'wiki',
        'tasks',
        'file_explorer',
      ]),
    ).resolves.toEqual(['wiki', 'tasks']);
  });
});
