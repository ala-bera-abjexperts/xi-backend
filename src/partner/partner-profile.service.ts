/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- dynamically-typed Supabase rows via the generic partner repository */
/**
 * @fileoverview Sub-ticket 1 - partner company profile, contact persons, and the
 * public website listing + offerings. All reads/writes are scoped to the caller's
 * partner organization in code (the service-role client bypasses RLS).
 * @module src/partner/partner-profile.service
 */

import { randomBytes } from 'crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PartnerRepository } from './partner.repository';
import type {
  CreatePartnerContactDto,
  CreatePartnerOfferingDto,
  UpdatePartnerContactDto,
  UpdatePartnerOfferingDto,
  UpdatePartnerProfileDto,
  UpsertPartnerListingDto,
} from './dto/partner.dto';

/**
 * Columns a partner may set on its own profile. kickback_percent, status and
 * office_email_domain are absent by design - see UpdatePartnerProfileDto.
 */
const SELF_SERVE_PROFILE_FIELDS = [
  'company_name',
  'legal_name',
  'vat_number',
  'registration_number',
  'phone',
  'email',
  'website',
  'address_line1',
  'address_line2',
  'city',
  'postal_code',
  'state',
  'country',
  'logo_url',
] as const satisfies readonly (keyof UpdatePartnerProfileDto)[];

/**
 * Re-whitelists the profile patch in the service rather than trusting the DTO.
 * The ValidationPipe already strips unknown keys, but this keeps a privileged
 * column unwritable even if someone later re-adds it to UpdatePartnerProfileDto
 * - the escalation this guards against is silent, so it gets two locks.
 */
function pickSelfServeFields(
  dto: UpdatePartnerProfileDto,
): Partial<UpdatePartnerProfileDto> {
  const patch: Partial<UpdatePartnerProfileDto> = {};

  for (const key of SELF_SERVE_PROFILE_FIELDS) {
    if (dto[key] !== undefined) {
      patch[key] = dto[key];
    }
  }

  return patch;
}

/**
 * Company name → listing slug that satisfies UpsertPartnerListingDto's
 * `^[a-z0-9][a-z0-9-]{1,80}$` ("Müller & Söhne GmbH" → "muller-sohne-gmbh").
 */
export function slugifyListing(name: string): string {
  const slug = (name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');

  return slug.length >= 2 ? slug : `partner-${slug || 'listing'}`;
}

@Injectable()
export class PartnerProfileService {
  constructor(private readonly repo: PartnerRepository) {}

  // ── Profile ──────────────────────────────────────────────────────────────
  async getProfile(organizationId: string) {
    const row = await this.repo.findOne('partner_profiles', {
      organization_id: organizationId,
    });
    if (!row) {
      throw new NotFoundException('Partner profile not found');
    }

    return row;
  }

  private async profileId(organizationId: string): Promise<string> {
    const profile = await this.getProfile(organizationId);

    return profile.id as string;
  }

  async updateProfile(
    organizationId: string,
    userId: string,
    dto: UpdatePartnerProfileDto,
  ) {
    const patch = pickSelfServeFields(dto);
    const existing = await this.repo.findOne('partner_profiles', {
      organization_id: organizationId,
    });

    if (existing) {
      return this.repo.updateById(
        'partner_profiles',
        existing.id as string,
        { ...patch, updated_by: userId },
        organizationId,
      );
    }

    return this.repo.insert('partner_profiles', {
      ...patch,
      organization_id: organizationId,
      company_name: dto.company_name ?? 'Partner',
      created_by: userId,
      updated_by: userId,
    });
  }

  // ── Contacts ─────────────────────────────────────────────────────────────
  async listContacts(organizationId: string) {
    return this.repo.findMany('partner_contacts', {
      organization_id: organizationId,
    });
  }

  async createContact(
    organizationId: string,
    userId: string,
    dto: CreatePartnerContactDto,
  ) {
    const partnerProfileId = await this.profileId(organizationId);

    return this.repo.insert('partner_contacts', {
      ...dto,
      organization_id: organizationId,
      partner_profile_id: partnerProfileId,
      created_by: userId,
      updated_by: userId,
    });
  }

  async updateContact(
    organizationId: string,
    userId: string,
    contactId: string,
    dto: UpdatePartnerContactDto,
  ) {
    await this.ensureOwned('partner_contacts', contactId, organizationId);

    return this.repo.updateById(
      'partner_contacts',
      contactId,
      { ...dto, updated_by: userId },
      organizationId,
    );
  }

  async deleteContact(organizationId: string, contactId: string) {
    await this.ensureOwned('partner_contacts', contactId, organizationId);
    await this.repo.deleteById('partner_contacts', contactId, organizationId);

    return { success: true };
  }

  // ── Public listing + offerings ───────────────────────────────────────────
  async getListing(organizationId: string) {
    return this.repo.findOne('partner_public_listings', {
      organization_id: organizationId,
    });
  }

  /**
   * XE-T736: offerings hang off the listing, so a partner that has never saved
   * its listing could not add an offering at all. Create an unpublished draft
   * listing on demand instead. The slug comes from the company name; the slug
   * index is global, so a taken slug gets a short random suffix. A conflict can
   * also mean a concurrent request just created this org's listing - re-read it.
   */
  private async ensureListing(organizationId: string, userId: string) {
    const existing = await this.getListing(organizationId);
    if (existing) {
      return existing;
    }

    const profile = await this.getProfile(organizationId);
    const base = slugifyListing(profile.company_name as string);

    for (let attempt = 0; attempt < 5; attempt++) {
      const slug =
        attempt === 0
          ? base
          : `${base.slice(0, 75)}-${randomBytes(2).toString('hex')}`;
      try {
        return await this.repo.insert('partner_public_listings', {
          slug,
          organization_id: organizationId,
          partner_profile_id: profile.id as string,
          is_published: false,
          created_by: userId,
          updated_by: userId,
        });
      } catch (err) {
        if (!(err instanceof ConflictException)) {
          throw err;
        }
        const raced = await this.getListing(organizationId);
        if (raced) {
          return raced;
        }
      }
    }

    throw new ConflictException(
      'Could not create a listing; please save the listing first',
    );
  }

  async upsertListing(
    organizationId: string,
    userId: string,
    dto: UpsertPartnerListingDto,
  ) {
    const partnerProfileId = await this.profileId(organizationId);
    const existing = await this.repo.findOne('partner_public_listings', {
      organization_id: organizationId,
    });

    if (existing) {
      return this.repo.updateById(
        'partner_public_listings',
        existing.id as string,
        { ...dto, updated_by: userId },
        organizationId,
      );
    }

    return this.repo.insert('partner_public_listings', {
      ...dto,
      organization_id: organizationId,
      partner_profile_id: partnerProfileId,
      created_by: userId,
      updated_by: userId,
    });
  }

  async setPublished(organizationId: string, userId: string, publish: boolean) {
    const listing = await this.getListing(organizationId);
    if (!listing) {
      throw new NotFoundException('Create a listing before publishing');
    }

    return this.repo.updateById(
      'partner_public_listings',
      listing.id as string,
      {
        is_published: publish,
        published_at: publish ? new Date().toISOString() : null,
        updated_by: userId,
      },
      organizationId,
    );
  }

  async listOfferings(organizationId: string) {
    const listing = await this.getListing(organizationId);
    if (!listing) {
      return [];
    }

    return this.repo.findMany('partner_offerings', {
      listing_id: listing.id as string,
    });
  }

  async createOffering(
    organizationId: string,
    userId: string,
    dto: CreatePartnerOfferingDto,
  ) {
    const listing = await this.ensureListing(organizationId, userId);

    return this.repo.insert('partner_offerings', {
      ...dto,
      organization_id: organizationId,
      listing_id: listing.id as string,
      created_by: userId,
      updated_by: userId,
    });
  }

  async updateOffering(
    organizationId: string,
    userId: string,
    offeringId: string,
    dto: UpdatePartnerOfferingDto,
  ) {
    await this.ensureOwned('partner_offerings', offeringId, organizationId);

    return this.repo.updateById(
      'partner_offerings',
      offeringId,
      { ...dto, updated_by: userId },
      organizationId,
    );
  }

  async deleteOffering(organizationId: string, offeringId: string) {
    await this.ensureOwned('partner_offerings', offeringId, organizationId);
    await this.repo.deleteById('partner_offerings', offeringId, organizationId);

    return { success: true };
  }

  private async ensureOwned(table: string, id: string, organizationId: string) {
    const row = await this.repo.findById(table, id, organizationId);
    if (!row) {
      throw new NotFoundException('Resource not found');
    }

    return row;
  }
}
