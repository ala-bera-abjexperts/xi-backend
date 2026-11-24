import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  registerDecorator,
  ValidateNested,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { getFeatureByKey } from '../feature-catalog';

export const PLAN_STATUSES = ['draft', 'active', 'archived'] as const;
export const BILLING_PERIODS = [
  'monthly',
  'yearly',
  'one_time',
  'custom',
] as const;
export const FEATURE_TYPES = ['boolean', 'limit', 'text', 'json'] as const;
export const LICENSE_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'suspended',
  'cancelled',
  'expired',
] as const;
export const CHANGE_REQUEST_TYPES = [
  'new_license',
  'plan_change',
  'seat_change',
  'cancel',
  'reactivate',
] as const;
export const CHANGE_REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
] as const;

export type LicensePlanStatus = (typeof PLAN_STATUSES)[number];
export type BillingPeriod = (typeof BILLING_PERIODS)[number];
export type LicenseFeatureType = (typeof FEATURE_TYPES)[number];
export type OrganizationLicenseStatus = (typeof LICENSE_STATUSES)[number];
export type LicenseChangeRequestType = (typeof CHANGE_REQUEST_TYPES)[number];
export type LicenseChangeRequestStatus =
  (typeof CHANGE_REQUEST_STATUSES)[number];

/**
 * Rejects `undefined` (including an absent property) but ALLOWS `null`.
 *
 * `@IsDefined()` cannot be used on `entitlement_value`: it rejects `null` too,
 * and `null` is this platform's encoding of "unlimited" for `type: 'limit'`
 * features (see feature-catalog.ts and EntitlementsService.buildResolved). The
 * storage layer agrees — `entitlement_value` is `jsonb NOT NULL`, and a JSON
 * `null` is not a SQL NULL, so it stores fine; the Enterprise plan's five limit
 * rows are persisted exactly that way. `@IsDefined()` therefore made the only
 * plan that uses unlimited limits impossible to save through the SA editor.
 *
 * Deleting the decorator instead of replacing it would be worse than the bug it
 * fixes: the global pipe runs `whitelist: true`, which strips properties that
 * carry no validation metadata, and `bulk_sync_plan_features_atomic` resolves a
 * missing key as `coalesce(item->'entitlement_value', 'true')`. A stripped value
 * would therefore silently GRANT the feature. The property must keep a
 * decorator so it survives whitelisting.
 */
function IsNotUndefined(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'IsNotUndefined',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return value !== undefined;
        },
        defaultMessage(): string {
          return `${propertyName} is required (use null for "unlimited" on a limit feature)`;
        },
      },
    });
  };
}

/** True when `value` is a legal entitlement for `type`. */
function entitlementMatchesType(
  value: unknown,
  type: LicenseFeatureType,
): boolean {
  switch (type) {
    // null = unlimited. Anything finite must be a whole, non-negative count:
    // the bulk-sync UI already floors and clamps, and a fractional or negative
    // ceiling has no meaning for any of the limit_* keys.
    case 'limit':
      return (
        value === null ||
        (typeof value === 'number' &&
          Number.isInteger(value) &&
          value >= 0 &&
          Number.isSafeInteger(value))
      );

    // Strictly boolean. The resolver compares `value === true`, so the string
    // 'true' would read as DENIED while looking enabled in the editor.
    case 'boolean':
      return typeof value === 'boolean';

    // null is meaningful here — buildResolved treats null/'' as disabled.
    case 'text':
      return value === null || typeof value === 'string';

    // Free-form by definition; only `undefined` is rejected (by IsNotUndefined).
    case 'json':
      return true;
  }
}

/**
 * Type-aware validation of `entitlement_value`.
 *
 * This closes a fail-open in EntitlementsService.buildResolved: a `limit` whose
 * value is neither a number nor null is logged as a warning and then treated as
 * **unlimited**. So a malformed value (the string `'10'`, say) quietly grants
 * more than the plan intended. Rejecting it at the HTTP boundary is the only
 * layer that can tell the difference between "unlimited" and "malformed".
 *
 * How the feature type is resolved:
 *  - `'sibling'` — read `feature_type` off the same payload item. When it is
 *    absent (it is optional on CreateLicenseFeatureDto, where the DB applies its
 *    own 'boolean' default) validation is skipped rather than guessed, so this
 *    decorator can never reject a payload that works today.
 *  - `'catalog'` — the override DTO carries no `feature_type`, so the type comes
 *    from FEATURE_CATALOG via `feature_key`. Custom keys are not in the catalog
 *    and stay permissive.
 */
function IsEntitlementValue(
  typeSource: 'sibling' | 'catalog',
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'IsEntitlementValue',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          // `undefined` is IsNotUndefined's job; reporting it twice would emit
          // two messages for one mistake.
          if (value === undefined) return true;

          const item = args.object as {
            feature_type?: unknown;
            feature_key?: unknown;
          };

          let type: LicenseFeatureType | undefined;

          if (typeSource === 'sibling') {
            const declared = item.feature_type;

            type = FEATURE_TYPES.includes(declared as LicenseFeatureType)
              ? (declared as LicenseFeatureType)
              : undefined;
          } else if (typeof item.feature_key === 'string') {
            type = getFeatureByKey(item.feature_key)?.type;
          }

          // Unknown type: leave it alone rather than guess.
          if (type === undefined) return true;

          return entitlementMatchesType(value, type);
        },
        defaultMessage(args: ValidationArguments): string {
          const item = args.object as { feature_type?: unknown };
          const type =
            typeSource === 'sibling'
              ? String(item.feature_type)
              : 'the catalog type for this feature_key';

          return `${propertyName} is not valid for ${type} (limit: a non-negative integer or null for unlimited; boolean: true or false; text: a string or null)`;
        },
      },
    });
  };
}

export class ListLicensePlansQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: PLAN_STATUSES })
  @IsOptional()
  @IsIn(PLAN_STATUSES)
  status?: LicensePlanStatus;
}

export class CreateLicensePlanDto {
  @ApiProperty({
    example: 'enterprise',
    description: 'Stable lowercase plan key',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(/^[a-z][a-z0-9_]*$/)
  plan_key!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ enum: PLAN_STATUSES, default: 'draft' })
  @IsOptional()
  @IsIn(PLAN_STATUSES)
  status?: LicensePlanStatus;

  @ApiPropertyOptional({ enum: BILLING_PERIODS, default: 'monthly' })
  @IsOptional()
  @IsIn(BILLING_PERIODS)
  billing_period?: BillingPeriod;

  @ApiPropertyOptional({ example: 'EUR', default: 'EUR' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  price_cents?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  trial_days?: number;

  @ApiPropertyOptional({ minimum: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  included_seats?: number | null;

  @ApiPropertyOptional({ minimum: 0, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  max_seats?: number | null;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  limits?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateLicensePlanDto extends PartialType(CreateLicensePlanDto) {}

export class CreateLicenseFeatureDto {
  @ApiProperty({ example: 'advanced_reports' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(/^[a-z][a-z0-9_]*$/)
  feature_key!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  feature_name!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ enum: FEATURE_TYPES, default: 'boolean' })
  @IsOptional()
  @IsIn(FEATURE_TYPES)
  feature_type?: LicenseFeatureType;

  @ApiProperty({
    description:
      'JSON-compatible entitlement value. `null` on a limit feature means unlimited.',
    nullable: true,
  })
  @IsNotUndefined()
  @IsEntitlementValue('sibling')
  entitlement_value!: unknown;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_metered?: boolean;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  display_order?: number;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateLicenseFeatureDto extends PartialType(
  CreateLicenseFeatureDto,
) {}

/**
 * One row in a bulk-sync payload. Same shape as CreateLicenseFeatureDto but
 * `feature_type` is required (no row to inherit from when upserting blind).
 */
export class BulkSyncPlanFeatureItemDto {
  @ApiProperty({ example: 'module_portfolios' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(/^[a-z][a-z0-9_]*$/)
  feature_key!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  feature_name!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ enum: FEATURE_TYPES })
  @IsIn(FEATURE_TYPES)
  feature_type!: LicenseFeatureType;

  @ApiProperty({
    description:
      'JSON-compatible entitlement value. `null` on a limit feature means unlimited.',
    nullable: true,
  })
  @IsNotUndefined()
  @IsEntitlementValue('sibling')
  entitlement_value!: unknown;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_metered?: boolean;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  display_order?: number;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

/**
 * Transactional bulk-sync of all features on a plan. Calls
 * `bulk_sync_plan_features_atomic` Supabase RPC.
 *
 * Semantics:
 *  - `preserve_unknown_keys: true` (default) — features in the plan whose key
 *    is NOT in `features` AND NOT in the catalog are LEFT ALONE. Custom keys
 *    (created via the per-feature form) survive.
 *  - `preserve_unknown_keys: false` — every feature in the plan NOT in
 *    `features` is deleted. If this would delete any rows, `confirm_full_replace`
 *    MUST be true; otherwise the RPC raises CONFIRM_FULL_REPLACE_REQUIRED.
 */
export class BulkSyncPlanFeaturesDto {
  @ApiProperty({ type: [BulkSyncPlanFeatureItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkSyncPlanFeatureItemDto)
  features!: BulkSyncPlanFeatureItemDto[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  preserve_unknown_keys?: boolean;

  @ApiPropertyOptional({
    description:
      'Required when preserve_unknown_keys=false AND the diff would delete rows.',
  })
  @IsOptional()
  @IsBoolean()
  confirm_full_replace?: boolean;
}

export class UpsertOrganizationLicenseDto {
  @ApiProperty()
  // `'all'` instead of the default `'4'` because seeded baseline plans use
  // deterministic non-v4 UUIDs (`…f01/f02/f03`). The DB column is just `uuid`,
  // which accepts any 128-bit hex value regardless of RFC 4122 version.
  @IsUUID('all')
  plan_id!: string;

  @ApiPropertyOptional({ enum: LICENSE_STATUSES, default: 'active' })
  @IsOptional()
  @IsIn(LICENSE_STATUSES)
  status?: OrganizationLicenseStatus;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  seats_purchased?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  seats_used?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  starts_at?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateString()
  trial_ends_at?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateString()
  current_period_start?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateString()
  current_period_end?: string | null;

  /**
   * The licence's hard end. The entitlement resolver stops honouring the
   * licence after it, and the daily status sweep flips it to `expired`.
   * Null = open-ended.
   */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateString()
  ends_at?: string | null;

  /** 'onprem' licences can carry on-prem installations (Phase 2). */
  @ApiPropertyOptional({ enum: ['cloud', 'onprem'] })
  @IsOptional()
  @IsIn(['cloud', 'onprem'])
  deployment_type?: 'cloud' | 'onprem';

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  suspension_reason?: string | null;

  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  external_provider?: string | null;

  @ApiPropertyOptional({ maxLength: 255, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  external_customer_id?: string | null;

  @ApiPropertyOptional({ maxLength: 255, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  external_subscription_id?: string | null;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateOrganizationLicenseDto extends PartialType(
  UpsertOrganizationLicenseDto,
) {}

export class UpsertLicenseFeatureOverrideDto {
  @ApiProperty()
  @IsUUID()
  organization_license_id!: string;

  @ApiProperty({ example: 'advanced_reports' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(/^[a-z][a-z0-9_]*$/)
  feature_key!: string;

  @ApiProperty({
    description:
      'JSON-compatible entitlement override value. `null` on a limit feature means unlimited.',
    nullable: true,
  })
  @IsNotUndefined()
  @IsEntitlementValue('catalog')
  entitlement_value!: unknown;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateString()
  expires_at?: string | null;
}

export class ListUsageCountersQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  organization_license_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/)
  feature_key?: string;
}

export class UpsertUsageCounterDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  organization_license_id?: string | null;

  @ApiProperty()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/)
  feature_key!: string;

  @ApiProperty()
  @IsDateString()
  period_start!: string;

  @ApiProperty()
  @IsDateString()
  period_end!: string;

  @ApiProperty({ minimum: 0 })
  @IsNumber()
  @Min(0)
  quantity!: number;

  @ApiPropertyOptional({ minimum: 0, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  hard_limit?: number | null;

  @ApiPropertyOptional({ maxLength: 40, default: 'count' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  unit?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ListChangeRequestsQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @ApiPropertyOptional({ enum: CHANGE_REQUEST_STATUSES })
  @IsOptional()
  @IsIn(CHANGE_REQUEST_STATUSES)
  status?: LicenseChangeRequestStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  organization_id?: string;
}

export class CreateLicenseChangeRequestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  current_license_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  // See UpsertOrganizationLicenseDto.plan_id — `'all'` to accept the
  // seeded non-v4 baseline plan UUIDs (`…f01/f02/f03`).
  @IsUUID('all')
  requested_plan_id?: string | null;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  requested_seats?: number | null;

  @ApiProperty({ enum: CHANGE_REQUEST_TYPES })
  @IsIn(CHANGE_REQUEST_TYPES)
  request_type!: LicenseChangeRequestType;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  request_note?: string | null;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ReviewLicenseChangeRequestDto {
  @ApiProperty({ enum: ['approved', 'rejected'] })
  @IsIn(['approved', 'rejected'])
  status!: 'approved' | 'rejected';

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  review_note?: string | null;
}

export class ListLicenseAuditEventsQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  organization_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  organization_license_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/)
  event_type?: string;
}
