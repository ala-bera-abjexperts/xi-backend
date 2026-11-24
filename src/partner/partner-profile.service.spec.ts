/**
 * @fileoverview Unit tests for PartnerProfileService, focused on the self-serve
 * write boundary: a partner may edit its own company details but must never
 * write the columns that decide its commission, lifecycle or Backoffice domain
 * lock - on update or on first-write insert.
 * @module src/partner/partner-profile.service.spec
 */

import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  PartnerProfileService,
  slugifyListing,
} from './partner-profile.service';
import { PartnerRepository } from './partner.repository';

const ORG = 'org-1';
const USER = 'user-1';
const PROFILE = 'profile-1';

/** A payload a malicious partner would send; only company_name is legitimate. */
const PRIVILEGED_PAYLOAD = {
  company_name: 'Port Partner Co',
  kickback_percent: 100,
  status: 'inactive',
  office_email_domain: 'gmail.com',
} as never;

function setup() {
  const repo = {
    insert: jest.fn().mockResolvedValue({ id: PROFILE }),
    updateById: jest.fn().mockResolvedValue({ id: PROFILE }),
    findOne: jest.fn().mockResolvedValue({ id: PROFILE }),
    findById: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    deleteById: jest.fn().mockResolvedValue(undefined),
  } as unknown as PartnerRepository;
  const service = new PartnerProfileService(repo);

  return { service, repo };
}

describe('PartnerProfileService', () => {
  describe('getProfile', () => {
    it('throws NotFound when the org has no partner profile', async () => {
      const { service, repo } = setup();
      (repo.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.getProfile(ORG)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('updateProfile', () => {
    it('writes the self-serve fields and stamps the editor', async () => {
      const { service, repo } = setup();

      await service.updateProfile(ORG, USER, {
        company_name: 'Port Partner Co',
        city: 'Rotterdam',
      });

      expect(repo.updateById).toHaveBeenCalledWith(
        'partner_profiles',
        PROFILE,
        {
          company_name: 'Port Partner Co',
          city: 'Rotterdam',
          updated_by: USER,
        },
        ORG,
      );
    });

    it('does not write kickback_percent, status or office_email_domain', async () => {
      const { service, repo } = setup();

      await service.updateProfile(ORG, USER, PRIVILEGED_PAYLOAD);

      const patch = (repo.updateById as jest.Mock).mock.calls[0][2] as Record<
        string,
        unknown
      >;

      expect(patch).not.toHaveProperty('kickback_percent');
      expect(patch).not.toHaveProperty('status');
      expect(patch).not.toHaveProperty('office_email_domain');
      expect(patch).toEqual({
        company_name: 'Port Partner Co',
        updated_by: USER,
      });
    });

    it('does not write privileged fields when creating the profile', async () => {
      const { service, repo } = setup();
      (repo.findOne as jest.Mock).mockResolvedValue(null);

      await service.updateProfile(ORG, USER, PRIVILEGED_PAYLOAD);

      const row = (repo.insert as jest.Mock).mock.calls[0][1] as Record<
        string,
        unknown
      >;

      expect(row).not.toHaveProperty('kickback_percent');
      expect(row).not.toHaveProperty('status');
      expect(row).not.toHaveProperty('office_email_domain');
      expect(row).toMatchObject({
        organization_id: ORG,
        company_name: 'Port Partner Co',
        created_by: USER,
      });
    });

    it('omits absent fields rather than nulling them', async () => {
      const { service, repo } = setup();

      await service.updateProfile(ORG, USER, { city: 'Rotterdam' });

      expect(repo.updateById).toHaveBeenCalledWith(
        'partner_profiles',
        PROFILE,
        { city: 'Rotterdam', updated_by: USER },
        ORG,
      );
    });
  });

  // XE-T736: a partner with no listing yet could never save an offering.
  describe('createOffering', () => {
    const OFFER = { title: 'Consulting', icon: 'bx-briefcase', sort_order: 0 };

    function mockFindOne(
      repo: PartnerRepository,
      listings: Array<Record<string, unknown> | null>,
    ) {
      (repo.findOne as jest.Mock).mockImplementation((table: string) =>
        Promise.resolve(
          table === 'partner_public_listings'
            ? (listings.shift() ?? null)
            : { id: PROFILE, company_name: 'Müller & Söhne GmbH' },
        ),
      );
    }

    it('uses the existing listing and creates no new one', async () => {
      const { service, repo } = setup();
      mockFindOne(repo, [{ id: 'listing-1' }]);

      await service.createOffering(ORG, USER, OFFER);

      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(repo.insert).toHaveBeenCalledWith(
        'partner_offerings',
        expect.objectContaining({
          listing_id: 'listing-1',
          organization_id: ORG,
        }),
      );
    });

    it('creates an unpublished draft listing when none exists', async () => {
      const { service, repo } = setup();
      mockFindOne(repo, [null]);
      (repo.insert as jest.Mock)
        .mockResolvedValueOnce({ id: 'listing-new' })
        .mockResolvedValueOnce({ id: 'offer-1' });

      await service.createOffering(ORG, USER, OFFER);

      expect(repo.insert).toHaveBeenNthCalledWith(
        1,
        'partner_public_listings',
        {
          slug: 'muller-sohne-gmbh',
          organization_id: ORG,
          partner_profile_id: PROFILE,
          is_published: false,
          created_by: USER,
          updated_by: USER,
        },
      );
      expect(repo.insert).toHaveBeenNthCalledWith(
        2,
        'partner_offerings',
        expect.objectContaining({ listing_id: 'listing-new' }),
      );
    });

    it('retries with a suffixed slug when the slug is taken', async () => {
      const { service, repo } = setup();
      mockFindOne(repo, [null, null]);
      (repo.insert as jest.Mock)
        .mockRejectedValueOnce(new ConflictException('slug taken'))
        .mockResolvedValueOnce({ id: 'listing-new' })
        .mockResolvedValueOnce({ id: 'offer-1' });

      await service.createOffering(ORG, USER, OFFER);

      const retrySlug = (repo.insert as jest.Mock).mock.calls[1][1].slug;
      expect(retrySlug).toMatch(/^muller-sohne-gmbh-[0-9a-f]{4}$/);
    });

    it('reuses a listing created concurrently instead of failing', async () => {
      const { service, repo } = setup();
      mockFindOne(repo, [null, { id: 'listing-raced' }]);
      (repo.insert as jest.Mock)
        .mockRejectedValueOnce(new ConflictException('org already has one'))
        .mockResolvedValueOnce({ id: 'offer-1' });

      await service.createOffering(ORG, USER, OFFER);

      expect(repo.insert).toHaveBeenLastCalledWith(
        'partner_offerings',
        expect.objectContaining({ listing_id: 'listing-raced' }),
      );
    });
  });

  describe('slugifyListing', () => {
    it.each([
      ['ABJ Experts', 'abj-experts'],
      ['  --Müller & Söhne GmbH--  ', 'muller-sohne-gmbh'],
      ['X', 'partner-x'],
      ['!!!', 'partner-listing'],
    ])('%s → %s', (name, slug) => {
      expect(slugifyListing(name)).toBe(slug);
      expect(slugifyListing(name)).toMatch(/^[a-z0-9][a-z0-9-]{1,80}$/);
    });
  });
});
