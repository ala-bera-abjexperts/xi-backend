/**
 * @fileoverview Unit tests for the anonymous PartnerPublicController. It reads
 * published listings straight from the repository, so it is exercised with a
 * mocked PartnerRepository rather than the generic controller-contract helper.
 * @module src/partner/partner-public.controller.spec
 */

import { NotFoundException } from '@nestjs/common';
import { PartnerPublicController } from './partner-public.controller';
import { PartnerRepository } from './partner.repository';

function buildChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, jest.Mock> & {
    then: (r: (v: unknown) => unknown) => Promise<unknown>;
  } = {} as never;
  const self = () => chain;

  chain.select = jest.fn(self);
  chain.eq = jest.fn(self);
  chain.order = jest.fn(self);
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);

  return chain;
}

describe('PartnerPublicController', () => {
  /** A raw row as the DB holds it - public fields plus internal bookkeeping. */
  const rawListing = {
    id: 'listing-1',
    slug: 'abj-experts',
    headline: 'We build things',
    organization_id: 'org-1',
    partner_profile_id: 'profile-1',
    created_by: 'user-uuid-1',
    updated_by: 'user-uuid-1',
    metadata: {},
    is_deleted: false,
    deleted_at: null,
    deleted_by: null,
  };

  /** Internal columns that must NEVER reach an anonymous caller. */
  const INTERNAL_KEYS = [
    'id',
    'organization_id',
    'partner_profile_id',
    'created_by',
    'updated_by',
    'metadata',
    'is_deleted',
    'deleted_at',
    'deleted_by',
  ];

  it('lists only published, non-deleted listings, projected to public columns', async () => {
    const chain = buildChain({ data: [rawListing], error: null });
    const repo = {
      client: { from: jest.fn(() => chain) },
      findOne: jest.fn(),
    } as unknown as PartnerRepository;
    const controller = new PartnerPublicController(repo);

    const result = await controller.listPublished();

    expect(repo.client.from).toHaveBeenCalledWith('partner_public_listings');
    expect(chain.eq).toHaveBeenCalledWith('is_published', true);
    expect(chain.eq).toHaveBeenCalledWith('is_deleted', false);
    // XE-T734: only partners who opted in to the directory are listed.
    expect(chain.eq).toHaveBeenCalledWith('show_in_directory', true);
    expect(result).toEqual([
      { slug: 'abj-experts', headline: 'We build things' },
    ]);
  });

  it('never leaks internal identifiers to anonymous callers (list)', async () => {
    const chain = buildChain({ data: [rawListing], error: null });
    const repo = {
      client: { from: jest.fn(() => chain) },
      findOne: jest.fn(),
    } as unknown as PartnerRepository;
    const controller = new PartnerPublicController(repo);

    const [row] = await controller.listPublished();

    for (const key of INTERNAL_KEYS) {
      expect(row).not.toHaveProperty(key);
    }
  });

  it('resolves a published listing by slug, with offerings, projected', async () => {
    const repo = {
      client: { from: jest.fn() },
      findOne: jest.fn().mockResolvedValue(rawListing),
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'off-2',
          title: 'Second',
          sort_order: 2,
          organization_id: 'org-1',
          created_by: 'user-uuid-1',
        },
        {
          id: 'off-1',
          title: 'First',
          sort_order: 1,
          organization_id: 'org-1',
          created_by: 'user-uuid-1',
        },
      ]),
    } as unknown as PartnerRepository;
    const controller = new PartnerPublicController(repo);

    const result = await controller.getBySlug('abj-experts');

    expect(repo.findOne).toHaveBeenCalledWith('partner_public_listings', {
      slug: 'abj-experts',
      is_published: true,
      is_deleted: false,
    });
    expect(result).toMatchObject({ slug: 'abj-experts' });

    // The listing id is needed internally to fetch offerings but must not ship.
    for (const key of INTERNAL_KEYS) {
      expect(result).not.toHaveProperty(key);
    }

    // Offerings are ordered by sort_order and carry no internal columns.
    expect(result.offerings).toEqual([
      { title: 'First', sort_order: 1 },
      { title: 'Second', sort_order: 2 },
    ]);
  });

  it('throws NotFound for an unknown or unpublished slug', async () => {
    const repo = {
      client: { from: jest.fn() },
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as PartnerRepository;
    const controller = new PartnerPublicController(repo);

    await expect(controller.getBySlug('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
