/**
 * @fileoverview Unit tests for PartnerLeadsService: lead lifecycle (draft →
 * submitted → accepted/rejected), the global first-wins 23505 → 409 mapping on
 * submit, resubmit counting, and customer linking on owner acceptance.
 * @module src/partner/partner-leads.service.spec
 */

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PartnerLeadsService } from './partner-leads.service';
import { PartnerRepository } from './partner.repository';

const ORG = 'org-1';
const USER = 'user-1';

/** Chainable Supabase builder mock that is also awaitable (resolves to result). */
function buildChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, jest.Mock> & {
    then?: (r: (v: unknown) => unknown) => Promise<unknown>;
  } = {} as never;
  const self = () => chain;

  chain.select = jest.fn(self);
  chain.eq = jest.fn(self);
  chain.update = jest.fn(self);
  chain.maybeSingle = jest.fn(() => Promise.resolve(result));
  chain.single = jest.fn(() => Promise.resolve(result));

  return chain;
}

function mockRepo(clientResult: { data: unknown; error: unknown }) {
  const chain = buildChain(clientResult);

  return {
    repo: {
      insert: jest.fn().mockResolvedValue({ id: 'inserted-1' }),
      insertMany: jest.fn().mockResolvedValue([]),
      updateById: jest.fn().mockResolvedValue({ id: 'updated-1' }),
      findById: jest.fn(),
      findOne: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      list: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      deleteById: jest.fn(),
      rpc: jest.fn(),
      client: { from: jest.fn(() => chain) },
    } as unknown as PartnerRepository,
    chain,
  };
}

describe('PartnerLeadsService', () => {
  describe('create', () => {
    it('inserts a draft lead scoped to the org and author', async () => {
      const { repo } = mockRepo({ data: null, error: null });
      const service = new PartnerLeadsService(repo);

      await service.create(ORG, USER, {
        customer_company_name: 'Brightwater Logistics AG',
        contact_name: 'Petra Vogel',
        contact_email: 'p.vogel@brightwater-logistics.de',
      } as never);

      expect(repo.insert).toHaveBeenCalledWith(
        'partner_leads',
        expect.objectContaining({
          customer_company_name: 'Brightwater Logistics AG',
          organization_id: ORG,
          status: 'draft',
          created_by: USER,
          updated_by: USER,
        }),
      );
    });
  });

  describe('get', () => {
    it('throws NotFound when the lead is missing', async () => {
      const { repo } = mockRepo({ data: null, error: null });
      (repo.findById as jest.Mock).mockResolvedValue(null);
      const service = new PartnerLeadsService(repo);

      await expect(service.get(ORG, 'lead-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws NotFound when the lead is soft-deleted', async () => {
      const { repo } = mockRepo({ data: null, error: null });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        is_deleted: true,
      });
      const service = new PartnerLeadsService(repo);

      await expect(service.get(ORG, 'lead-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('rejects editing a submitted lead', async () => {
      const { repo } = mockRepo({ data: null, error: null });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        status: 'submitted',
        is_deleted: false,
      });
      const service = new PartnerLeadsService(repo);

      await expect(
        service.update(ORG, USER, 'lead-1', { contact_name: 'x' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.updateById).not.toHaveBeenCalled();
    });

    it('updates a draft lead', async () => {
      const { repo } = mockRepo({ data: null, error: null });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        status: 'draft',
        is_deleted: false,
      });
      const service = new PartnerLeadsService(repo);

      await service.update(ORG, USER, 'lead-1', {
        contact_name: 'Petra Vogel',
      } as never);

      expect(repo.updateById).toHaveBeenCalledWith(
        'partner_leads',
        'lead-1',
        expect.objectContaining({
          contact_name: 'Petra Vogel',
          updated_by: USER,
        }),
        ORG,
      );
    });
  });

  describe('submit', () => {
    it('maps the first-wins unique violation (23505) to 409 Conflict', async () => {
      const { repo } = mockRepo({
        data: null,
        error: { code: '23505', message: 'duplicate key' },
      });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        status: 'draft',
        is_deleted: false,
      });
      const service = new PartnerLeadsService(repo);

      await expect(service.submit(ORG, USER, 'lead-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects submitting from a non-draft, non-rejected status', async () => {
      const { repo } = mockRepo({ data: null, error: null });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        status: 'accepted',
        is_deleted: false,
      });
      const service = new PartnerLeadsService(repo);

      await expect(service.submit(ORG, USER, 'lead-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('increments resubmit_count when resubmitting a rejected lead', async () => {
      const { repo, chain } = mockRepo({
        data: { id: 'lead-1', status: 'submitted' },
        error: null,
      });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        status: 'rejected',
        resubmit_count: 1,
        is_deleted: false,
      });
      const service = new PartnerLeadsService(repo);

      const result = await service.submit(ORG, USER, 'lead-1');

      expect(chain.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'submitted', resubmit_count: 2 }),
      );
      expect(result).toEqual({ id: 'lead-1', status: 'submitted' });
    });
  });

  describe('addComment', () => {
    it("SECURITY: refuses to write a comment onto another partner's lead", async () => {
      // The repo is service-role (RLS bypassed), so this scope check IS the
      // tenant boundary. Without it any partner could POST onto any lead, and
      // the row would render in both the victim's thread and the super-admin's
      // lead-review panel - the surface where C1 consent is decided.
      const { repo } = mockRepo({ data: null, error: null });

      // findById is org-scoped, so another org's lead resolves to null.
      (repo.findById as jest.Mock).mockResolvedValue(null);
      const service = new PartnerLeadsService(repo);

      await expect(
        service.addComment(ORG, USER, 'someone-elses-lead', {
          body: 'PWNED',
        } as never),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Must not have inserted anything - the 404 has to precede the write, or
      // the FK violation becomes a lead-existence oracle.
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('writes a partner comment on a lead the caller owns', async () => {
      const { repo } = mockRepo({ data: null, error: null });

      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        status: 'submitted',
        is_deleted: false,
      });
      const service = new PartnerLeadsService(repo);

      await service.addComment(ORG, USER, 'lead-1', { body: 'hello' } as never);

      expect(repo.insert).toHaveBeenCalledWith(
        'partner_lead_comments',
        expect.objectContaining({
          lead_id: 'lead-1',
          organization_id: ORG,
          author_user_id: USER,
          body: 'hello',
          // A partner can never author an owner comment.
          is_owner_comment: false,
        }),
      );
    });
  });

  describe('review', () => {
    it('rejects reviewing a lead that is not submitted', async () => {
      const { repo } = mockRepo({ data: null, error: null });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        status: 'draft',
      });
      const service = new PartnerLeadsService(repo);

      await expect(
        service.review('lead-1', 'reviewer-1', { action: 'accept' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a submitted lead and links a customer using the REVIEWER-supplied org', async () => {
      const { repo } = mockRepo({ data: null, error: null });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        status: 'submitted',
        organization_id: ORG,
        customer_company_name: 'Helena Inc',
        customer_organization_id: null,
      });
      (repo.findOne as jest.Mock).mockResolvedValue({ kickback_percent: 12.5 });
      const service = new PartnerLeadsService(repo);

      await service.review('lead-1', 'reviewer-1', {
        action: 'accept',
        customer_organization_id: 'reviewer-org',
      } as never);

      expect(repo.updateById).toHaveBeenCalledWith(
        'partner_leads',
        'lead-1',
        expect.objectContaining({
          status: 'accepted',
          reviewed_by: 'reviewer-1',
          customer_organization_id: 'reviewer-org',
          // Accepting is what earns the kickback, so the partner's current rate
          // is snapshotted onto the lead at accept time.
          kickback_percent: 12.5,
        }),
      );
      expect(repo.insert).toHaveBeenCalledWith(
        'partner_customers',
        expect.objectContaining({
          customer_name: 'Helena Inc',
          source_lead_id: 'lead-1',
          customer_organization_id: 'reviewer-org',
          status: 'active',
        }),
      );
    });

    it('SECURITY: ignores a persisted customer_organization_id the reviewer did not supply', async () => {
      // A tampered/legacy lead carries an org the partner never should have set.
      // Accepting WITHOUT a reviewer-supplied org must NOT link to it - the
      // customer stays an unlinked prospect (which cannot be converted).
      const { repo } = mockRepo({ data: null, error: null });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        status: 'submitted',
        organization_id: ORG,
        customer_company_name: 'Evil Inc',
        customer_organization_id: 'victim-org-partner-set',
      });
      const service = new PartnerLeadsService(repo);

      await service.review('lead-1', 'reviewer-1', {
        action: 'accept',
      } as never);

      // The update must NOT persist the partner-set org...
      const updateCall = (repo.updateById as jest.Mock).mock.calls.find(
        ([table]) => table === 'partner_leads',
      );
      expect(updateCall?.[2]?.customer_organization_id).toBeUndefined();

      // ...and the customer must be created UNLINKED (null org, prospect).
      expect(repo.insert).toHaveBeenCalledWith(
        'partner_customers',
        expect.objectContaining({
          customer_organization_id: null,
          status: 'prospect',
        }),
      );
    });

    it('rejects a submitted lead without creating a customer', async () => {
      const { repo } = mockRepo({ data: null, error: null });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        status: 'submitted',
        organization_id: ORG,
        customer_company_name: 'Helena Inc',
      });
      const service = new PartnerLeadsService(repo);

      await service.review('lead-1', 'reviewer-1', {
        action: 'reject',
        review_note: 'Out of region',
      } as never);

      expect(repo.updateById).toHaveBeenCalledWith(
        'partner_leads',
        'lead-1',
        expect.objectContaining({ status: 'rejected' }),
      );
      expect(repo.insert).not.toHaveBeenCalledWith(
        'partner_customers',
        expect.anything(),
      );
    });

    it('snapshots the kickback from the SUBMITTING partner profile on accept', async () => {
      const { repo } = mockRepo({ data: null, error: null });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        status: 'submitted',
        organization_id: ORG,
        customer_company_name: 'Helena Inc',
      });
      (repo.findOne as jest.Mock).mockResolvedValue({ kickback_percent: 7.5 });
      const service = new PartnerLeadsService(repo);

      await service.review('lead-1', 'reviewer-1', {
        action: 'accept',
        customer_organization_id: 'reviewer-org',
      } as never);

      expect(repo.findOne).toHaveBeenCalledWith(
        'partner_profiles',
        { organization_id: ORG },
        'kickback_percent',
      );
    });

    it('snapshots kickback 0 when the partner has no profile rather than failing the accept', async () => {
      const { repo } = mockRepo({ data: null, error: null });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        status: 'submitted',
        organization_id: ORG,
        customer_company_name: 'Helena Inc',
      });
      (repo.findOne as jest.Mock).mockResolvedValue(null);
      const service = new PartnerLeadsService(repo);

      await service.review('lead-1', 'reviewer-1', {
        action: 'accept',
        customer_organization_id: 'reviewer-org',
      } as never);

      expect(repo.updateById).toHaveBeenCalledWith(
        'partner_leads',
        'lead-1',
        expect.objectContaining({ status: 'accepted', kickback_percent: 0 }),
      );
    });

    it('does not touch kickback_percent on reject (nothing was earned)', async () => {
      const { repo } = mockRepo({ data: null, error: null });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        status: 'submitted',
        organization_id: ORG,
        customer_company_name: 'Helena Inc',
      });
      (repo.findOne as jest.Mock).mockResolvedValue({ kickback_percent: 12.5 });
      const service = new PartnerLeadsService(repo);

      await service.review('lead-1', 'reviewer-1', {
        action: 'reject',
      } as never);

      const patch = (repo.updateById as jest.Mock).mock.calls.find(
        ([table]) => table === 'partner_leads',
      )?.[2];

      expect(patch).not.toHaveProperty('kickback_percent');
    });
  });

  describe('getForOwner', () => {
    it('enriches the lead with the submitting partner name and an oldest-first thread', async () => {
      const { repo } = mockRepo({ data: null, error: null });
      (repo.findById as jest.Mock).mockResolvedValue({
        id: 'lead-1',
        status: 'submitted',
        organization_id: ORG,
      });
      (repo.findOne as jest.Mock).mockResolvedValue({
        id: ORG,
        name: 'Port Partner',
        slug: 'portpartner',
      });
      (repo.findMany as jest.Mock).mockResolvedValue([
        { id: 'c2', body: 'second', created_at: '2026-07-02T00:00:00Z' },
        { id: 'c1', body: 'first', created_at: '2026-07-01T00:00:00Z' },
      ]);
      const service = new PartnerLeadsService(repo);

      const result = await service.getForOwner('lead-1');

      expect(result.partner_name).toBe('Port Partner');
      expect(result.partner_slug).toBe('portpartner');
      expect(result.comments.map((c: { id: string }) => c.id)).toEqual([
        'c1',
        'c2',
      ]);
    });

    it('throws NotFound when the lead is missing', async () => {
      const { repo } = mockRepo({ data: null, error: null });
      (repo.findById as jest.Mock).mockResolvedValue(null);
      const service = new PartnerLeadsService(repo);

      await expect(service.getForOwner('lead-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
