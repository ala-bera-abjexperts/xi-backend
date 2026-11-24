/**
 * @fileoverview Regression tests for `entitlement_value` validation on the
 *   licensing DTOs.
 * @module src/licensing/dto/licensing.dto.spec
 *
 * Author: Prince Jadiya
 *
 * WHY THIS EXISTS
 * `entitlement_value` carried `@IsDefined()`, which rejects `null` as well as
 * `undefined`. But `null` is this platform's encoding of "unlimited" for
 * `type: 'limit'` features, agreed on by the catalog, the resolver, the DB
 * (`jsonb NOT NULL`, and a JSON null is not a SQL NULL) and the SA editor,
 * whose limit input is literally `placeholder='Unlimited'` and maps empty to
 * `null`. Saving any plan with an unlimited limit therefore 400'd with
 *
 *   features.24.entitlement_value should not be null or undefined
 *   features.25... .26... .27... .28...      (the five limit_* keys)
 *
 * and the Enterprise plan — whose five limit rows are all stored as JSON null —
 * could not be edited at all.
 *
 * These run the REAL global pipe from `main.ts` (`whitelist` + `transform` +
 * `forbidNonWhitelisted`), because the whitelist half matters as much as the
 * validation half: `bulk_sync_plan_features_atomic` resolves a missing key as
 * `coalesce(item->'entitlement_value', 'true')`, so a value stripped by
 * `whitelist` would silently GRANT the feature instead of denying it. The
 * "survives whitelisting" assertions below are what stop a future refactor from
 * "fixing" this by deleting the decorator.
 */

import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import {
  BulkSyncPlanFeaturesDto,
  CreateLicenseFeatureDto,
  UpsertLicenseFeatureOverrideDto,
} from './licensing.dto';

/** Identical to the global pipe registered in `main.ts`. */
const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

const meta = (metatype: new () => unknown): ArgumentMetadata => ({
  type: 'body',
  metatype,
});

async function run<T>(
  metatype: new () => unknown,
  payload: unknown,
): Promise<T> {
  return (await pipe.transform(payload, meta(metatype))) as T;
}

async function expectRejected(
  metatype: new () => unknown,
  payload: unknown,
): Promise<string> {
  try {
    await pipe.transform(payload, meta(metatype));
  } catch (error) {
    return JSON.stringify((error as { response?: unknown }).response ?? error);
  }

  throw new Error('expected the payload to be rejected, but it passed');
}

/**
 * The payload from the production 400, as [key, name, type, value] tuples.
 * Order and values are preserved, so `features[24..28]` here are the same five
 * limit keys the server named in its error.
 */
const PRODUCTION_ITEMS: Array<[string, string, string, unknown]> = [
  ['module_spaces', 'Spaces', 'boolean', true],
  ['module_portfolios', 'Portfolios', 'boolean', false],
  ['module_plans', 'Plans', 'boolean', true],
  ['module_tasks', 'Tasks', 'boolean', true],
  ['module_risk', 'Risk Management', 'boolean', false],
  ['module_wiki', 'Wiki', 'boolean', true],
  ['module_robot', 'Robot (Automations)', 'boolean', false],
  ['module_processes', 'Process Editor', 'boolean', false],
  ['module_gdpr', 'GDPR', 'boolean', false],
  ['module_site_studio', 'Site Studio', 'boolean', false],
  ['module_help_center', 'Help Center', 'boolean', true],
  ['module_dashboards', 'Dashboards', 'boolean', true],
  ['module_lists', 'Lists', 'boolean', true],
  ['module_assets', 'Assets', 'boolean', false],
  ['module_form_builder', 'Form Builder', 'boolean', false],
  ['module_boards', 'Boards', 'boolean', true],
  ['module_heatmap', 'Heatmap', 'boolean', false],
  ['module_filters', 'Saved Filters', 'boolean', true],
  ['module_automations', 'Automations', 'boolean', false],
  ['module_file_explorer', 'File Explorer', 'boolean', false],
  ['module_migration', 'Migration', 'boolean', false],
  ['module_resource_planning', 'Resource Planning', 'boolean', true],
  ['module_apps', 'Apps', 'boolean', false],
  ['module_partners', 'Partner Portal', 'boolean', false],
  // 24..28 — the five the server rejected.
  ['limit_spaces', 'Max Spaces', 'limit', null],
  ['limit_users', 'Max Users', 'limit', null],
  ['limit_storage_mb', 'Storage (MB)', 'limit', null],
  ['limit_custom_fields_per_space', 'Custom Fields per Space', 'limit', null],
  ['limit_automations', 'Max Automations', 'limit', null],
  ['feature_custom_roles', 'Custom Roles', 'boolean', false],
  ['feature_user_groups', 'User Groups', 'boolean', false],
  ['feature_advanced_permissions', 'Advanced Permissions', 'boolean', false],
  ['feature_audit_logs', 'Audit Logs', 'boolean', false],
  ['feature_ai_assist', 'AI Assist', 'boolean', false],
  ['feature_custom_branding', 'Custom Branding', 'boolean', false],
  ['feature_impersonation_target', 'Support Impersonation', 'boolean', true],
  ['feature_external_integrations', 'External Integrations', 'boolean', false],
];

const PRODUCTION_PAYLOAD = {
  features: PRODUCTION_ITEMS.map(([key, name, type, value], index) => ({
    feature_key: key,
    feature_name: name,
    description: 'irrelevant to validation',
    feature_type: type,
    entitlement_value: value,
    is_metered: false,
    display_order: index,
    metadata: {},
  })),
  preserve_unknown_keys: true,
};

/** A single bulk-sync item, overridable per test. */
const item = (over: Record<string, unknown> = {}) => ({
  feature_key: 'limit_spaces',
  feature_name: 'Max Spaces',
  feature_type: 'limit',
  entitlement_value: null,
  ...over,
});

describe('licensing DTOs under the real ValidationPipe', () => {
  describe('BulkSyncPlanFeaturesDto — the production regression', () => {
    it('accepts the exact payload that returned 400', async () => {
      const result = await run<BulkSyncPlanFeaturesDto>(
        BulkSyncPlanFeaturesDto,
        PRODUCTION_PAYLOAD,
      );

      expect(result.features).toHaveLength(37);
    });

    it('keeps the five limit values as null rather than stripping them', async () => {
      const result = await run<BulkSyncPlanFeaturesDto>(
        BulkSyncPlanFeaturesDto,
        PRODUCTION_PAYLOAD,
      );

      const limits = result.features.filter((f) => f.feature_type === 'limit');

      expect(limits).toHaveLength(5);

      for (const limit of limits) {
        // Both halves matter. `toBeNull` proves the value was not coerced;
        // `hasOwnProperty` proves `whitelist` did not drop the key, which the
        // RPC's `coalesce(..., 'true')` would have turned into a GRANT.
        expect(limit.entitlement_value).toBeNull();
        expect(
          Object.prototype.hasOwnProperty.call(limit, 'entitlement_value'),
        ).toBe(true);
      }
    });

    it('still rejects an item that omits entitlement_value entirely', async () => {
      // Guards the coalesce-to-true trap: a missing key must be a 400, never a
      // silently granted feature.
      const bare = item();

      delete (bare as { entitlement_value?: unknown }).entitlement_value;

      const message = await expectRejected(BulkSyncPlanFeaturesDto, {
        features: [bare],
      });

      expect(message).toContain('entitlement_value is required');
    });
  });

  describe('limit values', () => {
    it.each([
      ['null (unlimited)', null],
      ['zero', 0],
      ['a positive integer', 250],
    ])('accepts %s', async (_label, value) => {
      const result = await run<BulkSyncPlanFeaturesDto>(
        BulkSyncPlanFeaturesDto,
        { features: [item({ entitlement_value: value })] },
      );

      expect(result.features[0].entitlement_value).toEqual(value);
    });

    it.each([
      ['a negative ceiling', -1],
      ['a fractional ceiling', 1.5],
      ['a numeric string', '10'],
      ['a boolean', true],
    ])('rejects %s', async (_label, value) => {
      const message = await expectRejected(BulkSyncPlanFeaturesDto, {
        features: [item({ entitlement_value: value })],
      });

      expect(message).toContain('entitlement_value is not valid for limit');
    });
  });

  describe('boolean values', () => {
    const boolItem = (value: unknown) =>
      item({
        feature_key: 'module_tasks',
        feature_name: 'Tasks',
        feature_type: 'boolean',
        entitlement_value: value,
      });

    it.each([true, false])('accepts %s', async (value) => {
      const result = await run<BulkSyncPlanFeaturesDto>(
        BulkSyncPlanFeaturesDto,
        { features: [boolItem(value)] },
      );

      expect(result.features[0].entitlement_value).toBe(value);
    });

    it.each([
      ['the string "true"', 'true'],
      ['null', null],
      ['a number', 1],
    ])('rejects %s', async (_label, value) => {
      // The resolver compares `value === true`, so a truthy non-boolean reads
      // as DENIED while looking enabled in the SA editor.
      const message = await expectRejected(BulkSyncPlanFeaturesDto, {
        features: [boolItem(value)],
      });

      expect(message).toContain('entitlement_value is not valid for boolean');
    });
  });

  describe('permissive cases stay permissive', () => {
    it('accepts any JSON for a custom json feature', async () => {
      const result = await run<BulkSyncPlanFeaturesDto>(
        BulkSyncPlanFeaturesDto,
        {
          features: [
            item({
              feature_key: 'custom_thing',
              feature_name: 'Custom Thing',
              feature_type: 'json',
              entitlement_value: { nested: [1, 2, 3] },
            }),
          ],
        },
      );

      expect(result.features[0].entitlement_value).toEqual({
        nested: [1, 2, 3],
      });
    });

    it('accepts a string or null for a text feature', async () => {
      for (const value of ['hello', null]) {
        const result = await run<BulkSyncPlanFeaturesDto>(
          BulkSyncPlanFeaturesDto,
          {
            features: [
              item({
                feature_key: 'custom_text',
                feature_name: 'Custom Text',
                feature_type: 'text',
                entitlement_value: value,
              }),
            ],
          },
        );

        expect(result.features[0].entitlement_value).toEqual(value);
      }
    });
  });

  describe('CreateLicenseFeatureDto', () => {
    const base = {
      feature_key: 'limit_spaces',
      feature_name: 'Max Spaces',
      feature_type: 'limit',
    };

    it('accepts a null (unlimited) limit', async () => {
      const result = await run<CreateLicenseFeatureDto>(
        CreateLicenseFeatureDto,
        { ...base, entitlement_value: null },
      );

      expect(result.entitlement_value).toBeNull();
    });

    it('rejects a missing entitlement_value', async () => {
      const message = await expectRejected(CreateLicenseFeatureDto, base);

      expect(message).toContain('entitlement_value is required');
    });

    it('does not guess a type when feature_type is omitted', async () => {
      // feature_type is optional here (the DB applies its own default), so the
      // type-aware check must stand down rather than assume 'boolean' and start
      // rejecting payloads that work today.
      const result = await run<CreateLicenseFeatureDto>(
        CreateLicenseFeatureDto,
        {
          feature_key: 'something_custom',
          feature_name: 'Something Custom',
          entitlement_value: 42,
        },
      );

      expect(result.entitlement_value).toBe(42);
    });
  });

  describe('UpsertLicenseFeatureOverrideDto — type comes from the catalog', () => {
    const base = {
      organization_license_id: '00000000-0000-4000-8000-000000000001',
      feature_key: 'limit_users',
    };

    it('accepts a null (unlimited) override', async () => {
      const result = await run<UpsertLicenseFeatureOverrideDto>(
        UpsertLicenseFeatureOverrideDto,
        { ...base, entitlement_value: null },
      );

      expect(result.entitlement_value).toBeNull();
    });

    it('rejects a malformed limit override using the catalog type', async () => {
      // This DTO carries no feature_type, so the only way to know limit_users is
      // a limit is FEATURE_CATALOG.
      const message = await expectRejected(UpsertLicenseFeatureOverrideDto, {
        ...base,
        entitlement_value: '25',
      });

      expect(message).toContain('entitlement_value is not valid');
    });

    it('stays permissive for a custom key that is not in the catalog', async () => {
      const result = await run<UpsertLicenseFeatureOverrideDto>(
        UpsertLicenseFeatureOverrideDto,
        { ...base, feature_key: 'not_in_catalog', entitlement_value: 'any' },
      );

      expect(result.entitlement_value).toBe('any');
    });

    it('rejects a missing entitlement_value', async () => {
      const message = await expectRejected(
        UpsertLicenseFeatureOverrideDto,
        base,
      );

      expect(message).toContain('entitlement_value is required');
    });
  });
});
