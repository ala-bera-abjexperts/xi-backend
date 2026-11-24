/**
 * @fileoverview All request DTOs for the Partner Portal module. Money is integer
 * cents; currency is a 3-letter ISO code; dates are ISO (YYYY-MM-DD) strings.
 * @module src/partner/dto/partner.dto
 */

import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
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
  ValidateIf,
  ValidateNested,
  registerDecorator,
} from 'class-validator';

const CURRENCY = /^[A-Z]{3}$/;

/**
 * Optional on PATCH, but never null: for NOT NULL columns. `@IsOptional()` lets
 * null through, which the DB then rejects with a 500. This only skips
 * validation when the key is absent, so `null`/`''` fail the rules below → 400.
 * Nullable columns keep `@IsOptional()` so a cleared field saves as NULL.
 */
const OptionalNotNull = () => ValidateIf((_o, v) => v !== undefined);
/** Mirrors the DB CHECK partner_feature_key_is_resellable. */
export const RESELLABLE_FEATURE_KEY =
  /^(?!module_partners$)(module|limit)_[a-z0-9_]+$/;
const MAX_INT4 = 2_147_483_647; // partner_resellable_items.default_unit_price_cents is integer
const MAX_CENTS = 1_000_000_000_000; // 10 billion currency units - overflow guard
const MAX_QTY = 10_000_000;

// ── Profile & contacts ──────────────────────────────────────────────────────
export class UpdatePartnerProfileDto {
  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  company_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  legal_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vat_number?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  registration_number?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  website?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  address_line1?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  address_line2?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  postal_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  state?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  logo_url?: string;

  // NOTE: kickback_percent, status and office_email_domain are deliberately NOT
  // accepted here. This DTO is partner-self-serve, and each of those is a
  // privilege the partner must not grant itself: kickback_percent is the
  // commission the platform owes it, status is its lifecycle (an inactive
  // partner could reactivate itself), and office_email_domain is the lock that
  // constrains who it can invite as a Backoffice user - a self-editable domain
  // makes that lock meaningless. All three stay super-admin-only via
  // ProvisionPartnerDto. The global ValidationPipe runs forbidNonWhitelisted,
  // so a client that sends them anyway gets a 400 rather than a silent strip,
  // and PartnerProfileService re-whitelists the columns it writes regardless.
}

export class CreatePartnerContactDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  first_name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  last_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  role_title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_primary?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpdatePartnerContactDto extends PartialType(
  CreatePartnerContactDto,
) {}

// ── Public listing & offerings ──────────────────────────────────────────────
export class UpsertPartnerListingDto {
  @ApiProperty()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,80}$/)
  slug!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  headline?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  summary?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  logo_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  banner_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  contact_phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  website_url?: string;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsObject()
  social_links?: Record<string, unknown>;

  // XE-T734: illustration images (public URLs from /uploads/images), max 6.
  @ApiPropertyOptional({ type: [String], maxItems: 6 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  @Matches(/^https?:\/\//, {
    each: true,
    message: 'gallery_urls must be http(s) URLs',
  })
  gallery_urls?: string[];

  // XE-T734: opt in to the public XISUITE partner directory.
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  show_in_directory?: boolean;
}

export class CreatePartnerOfferingDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  icon?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}

export class UpdatePartnerOfferingDto extends PartialType(
  CreatePartnerOfferingDto,
) {}

// ── Leads ───────────────────────────────────────────────────────────────────
export class CreateLeadDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  customer_company_name!: string;

  // NOTE: customer_organization_id is deliberately NOT accepted here. It is the
  // consent anchor for partner_can_sell_to() - a partner that could set it at
  // lead creation could self-authorise a licence injection onto ANY org by
  // naming it and getting the lead accepted. Only the super-admin reviewer sets
  // it, via ReviewLeadDto on accept. `whitelist: true` on the global
  // ValidationPipe strips it from the request body if a client sends it anyway.

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  contact_phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_QTY)
  expected_users?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CENTS)
  expected_value_cents?: number;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @Matches(CURRENCY)
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  request_note?: string;
}

// PartialType re-adds @IsOptional (which lets null through) to every field, so
// the two NOT NULL columns are omitted and redeclared as optional-but-not-null.
export class UpdateLeadDto extends PartialType(
  OmitType(CreateLeadDto, ['customer_company_name', 'currency'] as const),
) {
  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  customer_company_name?: string;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @Matches(CURRENCY)
  currency?: string;
}

export class LeadCommentDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}

export class ReviewLeadDto {
  @ApiProperty({ enum: ['accept', 'reject'] })
  @IsIn(['accept', 'reject'])
  action!: 'accept' | 'reject';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  review_note?: string;

  /**
   * The tenant org this lead resolves to, set by the reviewer when accepting.
   *
   * This is the consent point of the whole partner->customer relationship: it is
   * the ONLY thing that authorises the partner to add that org as a customer and
   * later install a licence on it (see public.partner_can_sell_to). Accepting
   * without it leaves the customer a prospect with no org link, and any quote
   * conversion against it is rejected.
   */
  @ApiPropertyOptional({
    description:
      'Organization the lead resolves to. Setting this on accept authorises the partner to sell to that org.',
  })
  @IsOptional()
  @IsUUID()
  customer_organization_id?: string;
}

// ── Office users (Backoffice) ───────────────────────────────────────────────
export class InviteOfficeUserDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  email!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  first_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  last_name?: string;
}

// ── Customers ───────────────────────────────────────────────────────────────
// ── Customer addresses (XE-T732 follow-up) ──────────────────────────────────
export class CustomerAddressDto {
  @ApiProperty({ enum: ['billing', 'shipping', 'hq', 'other'] })
  @IsIn(['billing', 'shipping', 'hq', 'other'])
  address_type!: 'billing' | 'shipping' | 'hq' | 'other';

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  address_line1!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  address_line2?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  city!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  postal_code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  state?: string;

  @ApiProperty({ description: 'ISO 3166-1 alpha-2, e.g. AT' })
  @Matches(/^[A-Z]{2}$/, {
    message: 'country must be a two-letter ISO code, e.g. AT',
  })
  country!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_primary?: boolean;
}

/** At most one address may be primary (mirrors the partial unique index). */
function AtMostOnePrimary(): PropertyDecorator {
  return (target, propertyKey) =>
    registerDecorator({
      name: 'atMostOnePrimary',
      target: target.constructor,
      propertyName: propertyKey as string,
      validator: {
        validate: (value: unknown) =>
          !Array.isArray(value) ||
          value.filter((a: { is_primary?: boolean }) => a?.is_primary === true)
            .length <= 1,
        defaultMessage: () => 'Only one address can be the primary address',
      },
    });
}

export class CreateCustomerDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  customer_name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customer_organization_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  source_lead_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  contact_phone?: string;

  @ApiPropertyOptional({ enum: ['prospect', 'active', 'inactive'] })
  @IsOptional()
  @IsIn(['prospect', 'active', 'inactive'])
  status?: 'prospect' | 'active' | 'inactive';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  vat_number?: string;

  /** Absent = leave addresses untouched; [] = remove all; otherwise replace the set. */
  @ApiPropertyOptional({ type: [CustomerAddressDto], maxItems: 10 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CustomerAddressDto)
  @AtMostOnePrimary()
  addresses?: CustomerAddressDto[];
}

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}

// ── License packages ────────────────────────────────────────────────────────
export class PackageItemDto {
  @ApiProperty({ enum: ['module', 'user_seat', 'addon'] })
  @IsIn(['module', 'user_seat', 'addon'])
  item_type!: 'module' | 'user_seat' | 'addon';

  // Mirrors the DB CHECK partner_feature_key_is_resellable (XE-T740): only
  // module_* / limit_* keys, never module_partners. Rejecting here returns a
  // readable 400 instead of a raw check-violation from Postgres.
  @ApiPropertyOptional({ example: 'module_tasks' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Matches(RESELLABLE_FEATURE_KEY, {
    message:
      'feature_key must be a resellable module or limit key, e.g. module_tasks',
  })
  feature_key?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  quantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CENTS)
  unit_price_cents?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  per_period?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}

export class CreatePackageDto {
  @ApiProperty()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9_-]{1,80}$/)
  package_key!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({ enum: ['cloud', 'onprem'] })
  @IsOptional()
  @IsIn(['cloud', 'onprem'])
  deployment_type?: 'cloud' | 'onprem';

  @ApiPropertyOptional({ enum: ['monthly', 'yearly', 'one_time', 'custom'] })
  @IsOptional()
  @IsIn(['monthly', 'yearly', 'one_time', 'custom'])
  billing_period?: 'monthly' | 'yearly' | 'one_time' | 'custom';

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(CURRENCY)
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_QTY)
  included_users?: number;

  @ApiPropertyOptional({ enum: ['draft', 'active', 'archived'] })
  @IsOptional()
  @IsIn(['draft', 'active', 'archived'])
  status?: 'draft' | 'active' | 'archived';

  @ApiPropertyOptional({ type: [PackageItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PackageItemDto)
  items?: PackageItemDto[];
}

export class UpdatePackageDto extends PartialType(CreatePackageDto) {}

// ── Global module price list (super admin, XE-T738) ─────────────────────────
export class CreateResellableItemDto {
  @ApiProperty({ enum: ['module', 'user_seat', 'addon'] })
  @IsIn(['module', 'user_seat', 'addon'])
  item_type!: 'module' | 'user_seat' | 'addon';

  @ApiProperty({ example: 'module_tasks' })
  @IsString()
  @Matches(RESELLABLE_FEATURE_KEY, {
    message:
      'feature_key must be a resellable module or limit key, e.g. module_tasks',
  })
  feature_key!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ description: 'Net default unit price in cents' })
  @IsInt()
  @Min(0)
  @Max(MAX_INT4)
  default_unit_price_cents!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  default_per_period?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}

export class UpdateResellableItemDto extends PartialType(
  CreateResellableItemDto,
) {}

// ── Quotes ──────────────────────────────────────────────────────────────────
export class QuoteItemDto {
  @ApiProperty({ enum: ['module', 'user_seat', 'addon', 'discount'] })
  @IsIn(['module', 'user_seat', 'addon', 'discount'])
  item_type!: 'module' | 'user_seat' | 'addon' | 'discount';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  feature_key?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(MAX_QTY)
  quantity!: number;

  @ApiProperty({
    description: 'Cents; may be negative only for discount lines.',
  })
  @IsInt()
  @Min(-MAX_CENTS)
  @Max(MAX_CENTS)
  unit_price_cents!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  per_period?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  start_date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  end_date?: string;

  @ApiPropertyOptional({ enum: ['cloud', 'onprem'] })
  @IsOptional()
  @IsIn(['cloud', 'onprem'])
  deployment_type?: 'cloud' | 'onprem';

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}

export class CreateQuoteDto {
  @ApiProperty()
  @IsUUID()
  customer_id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  package_id?: string;

  @ApiPropertyOptional({ enum: ['cloud', 'onprem'] })
  @IsOptional()
  @IsIn(['cloud', 'onprem'])
  deployment_type?: 'cloud' | 'onprem';

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(CURRENCY)
  currency?: string;

  @ApiProperty({ description: 'ISO date YYYY-MM-DD' })
  @IsISO8601()
  start_date!: string;

  @ApiProperty({ description: 'ISO date YYYY-MM-DD' })
  @IsISO8601()
  end_date!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_QTY)
  included_users?: number;

  @ApiPropertyOptional({ enum: ['monthly', 'yearly', 'one_time', 'custom'] })
  @IsOptional()
  @IsIn(['monthly', 'yearly', 'one_time', 'custom'])
  billing_period?: 'monthly' | 'yearly' | 'one_time' | 'custom';

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CENTS)
  tax_cents?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CENTS)
  discount_cents?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  valid_until?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @ApiProperty({ type: [QuoteItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuoteItemDto)
  items!: QuoteItemDto[];
}

export class UpdateQuoteDto extends PartialType(CreateQuoteDto) {}

// ── Invoices ────────────────────────────────────────────────────────────────
export class UpdateInvoiceDto {
  @ApiPropertyOptional({
    enum: ['draft', 'issued', 'paid', 'overdue', 'cancelled'],
  })
  @IsOptional()
  @IsIn(['draft', 'issued', 'paid', 'overdue', 'cancelled'])
  status?: 'draft' | 'issued' | 'paid' | 'overdue' | 'cancelled';

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  due_date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  payment_method?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  external_invoice_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

// ── Onboard a new customer org (audit P5) ──────────────────────────────────
export class ProvisionCustomerOrgDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  org_name!: string;

  @ApiProperty({
    description: 'Workspace subdomain: lowercase letters, digits, hyphens.',
  })
  @Matches(/^[a-z0-9][a-z0-9-]{1,62}$/)
  slug!: string;

  @ApiProperty()
  @IsEmail()
  @MaxLength(255)
  owner_email!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  owner_first_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  owner_last_name?: string;
}

// ── Licence lifecycle (renew / upgrade / cancel) ───────────────────────────
export class CancelLicenceDto {
  @ApiProperty({ enum: ['now', 'not_renewing', 'renew_again'] })
  @IsIn(['now', 'not_renewing', 'renew_again'])
  mode!: 'now' | 'not_renewing' | 'renew_again';
}

// ── Admin provisioning ──────────────────────────────────────────────────────
export class ProvisionPartnerDto {
  @ApiProperty({ description: 'Organization to convert into a partner.' })
  @IsUUID()
  organization_id!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  company_name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  office_email_domain?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  kickback_percent?: number;
}
