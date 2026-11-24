/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- dynamically-typed Supabase rows via the generic partner repository */
/**
 * @fileoverview Sub-ticket 2 - partner leads. Partners create/submit/resubmit
 * leads (a global first-to-submit-wins unique index throws 23505 → 409). The
 * platform owner (super admin) accepts/rejects; accept links a customer record.
 * @module src/partner/partner-leads.service
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PartnerRepository } from './partner.repository';
import type {
  CreateLeadDto,
  LeadCommentDto,
  ReviewLeadDto,
  UpdateLeadDto,
} from './dto/partner.dto';

@Injectable()
export class PartnerLeadsService {
  constructor(private readonly repo: PartnerRepository) {}

  async list(
    organizationId: string,
    filters: {
      status?: string;
      search?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    return this.repo.list('partner_leads', {
      page: filters.page,
      pageSize: filters.pageSize,
      filters: {
        organization_id: organizationId,
        is_deleted: false,
        ...(filters.status ? { status: filters.status } : {}),
      },
      search: filters.search
        ? { column: 'customer_company_name', term: filters.search }
        : undefined,
    });
  }

  async get(organizationId: string, leadId: string) {
    const row = await this.repo.findById(
      'partner_leads',
      leadId,
      organizationId,
    );
    if (!row || row.is_deleted) {
      throw new NotFoundException('Lead not found');
    }

    return row;
  }

  async create(organizationId: string, userId: string, dto: CreateLeadDto) {
    return this.repo.insert('partner_leads', {
      ...dto,
      organization_id: organizationId,
      status: 'draft',
      created_by: userId,
      updated_by: userId,
    });
  }

  async update(
    organizationId: string,
    userId: string,
    leadId: string,
    dto: UpdateLeadDto,
  ) {
    const lead = await this.get(organizationId, leadId);
    if (!['draft', 'rejected'].includes(lead.status)) {
      throw new BadRequestException(
        'Only draft or rejected leads can be edited',
      );
    }

    return this.repo.updateById(
      'partner_leads',
      leadId,
      { ...dto, updated_by: userId },
      organizationId,
    );
  }

  /** Submit (or resubmit after a rejection). Maps the first-wins unique to 409. */
  async submit(organizationId: string, userId: string, leadId: string) {
    const lead = await this.get(organizationId, leadId);
    if (!['draft', 'rejected'].includes(lead.status)) {
      throw new BadRequestException(
        `Lead cannot be submitted from status '${lead.status}'`,
      );
    }

    const resubmitCount =
      (lead.resubmit_count ?? 0) + (lead.status === 'rejected' ? 1 : 0);

    const { data, error } = await this.repo.client
      .from('partner_leads')
      .update({
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        submitted_by: userId,
        resubmit_count: resubmitCount,
        reviewed_at: null,
        reviewed_by: null,
        updated_by: userId,
      })
      .eq('id', leadId)
      .eq('organization_id', organizationId)
      .select()
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException(
          'This customer company has already been submitted by another partner. Leads are first-come, first-served.',
        );
      }

      throw new BadRequestException(error.message);
    }

    return data;
  }

  async listComments(organizationId: string, leadId: string) {
    await this.get(organizationId, leadId);

    return this.repo.findMany('partner_lead_comments', { lead_id: leadId });
  }

  /**
   * Partner-facing comment write. MUST stay org-scoped.
   *
   * `leadId` comes straight off the route, and PartnerRepository uses the
   * service-role client (RLS bypassed), so this check IS the tenant boundary:
   * without it any partner could POST a comment onto another partner's lead -
   * and because the thread is read by lead_id, that row would render both in the
   * victim's thread and in the super-admin's lead-review panel, i.e. the exact
   * surface where the accept/reject C1 consent decision is made.
   *
   * Scoping the read (listComments) but not the write is the whole bug class;
   * mirror it here. It also collapses the FK-violation lead-existence oracle
   * into a uniform 404.
   */
  async addComment(
    organizationId: string,
    userId: string,
    leadId: string,
    dto: LeadCommentDto,
  ) {
    await this.get(organizationId, leadId);

    return this.insertComment(organizationId, userId, leadId, dto, false);
  }

  /**
   * Unscoped insert for the owner-review path only.
   *
   * review() resolves the lead via loadForOwner (super-admin, deliberately not
   * org-scoped) and passes the lead's OWN organization_id, so an ownership check
   * would be circular. It would also be actively harmful: get() rejects
   * soft-deleted leads, so reviewing one with a note would 404 AFTER the status
   * update had already committed, leaving a half-applied review.
   */
  private async insertComment(
    organizationId: string,
    userId: string,
    leadId: string,
    dto: LeadCommentDto,
    isOwnerComment: boolean,
  ) {
    return this.repo.insert('partner_lead_comments', {
      lead_id: leadId,
      organization_id: organizationId,
      author_user_id: userId,
      body: dto.body,
      is_owner_comment: isOwnerComment,
    });
  }

  // ── Owner-panel review (super admin; not org-scoped) ───────────────────────
  /** Bare fetch, no enrichment - the review path only needs the row itself. */
  private async loadForOwner(leadId: string) {
    const row = await this.repo.findById('partner_leads', leadId);
    if (!row) {
      throw new NotFoundException('Lead not found');
    }

    return row;
  }

  /**
   * Owner-panel lead detail. Enriched with the submitting partner's name and the
   * comment thread: the reviewer is adjudicating BETWEEN partners (so "which
   * partner" is decision-critical, not decoration), and the thread is the only
   * back-and-forth channel with the submitter before accept/reject.
   */
  async getForOwner(leadId: string) {
    const lead = await this.loadForOwner(leadId);

    const [partnerOrg, comments] = await Promise.all([
      this.repo.findOne(
        'organizations',
        { id: lead.organization_id },
        'id,name,slug',
      ),
      this.repo.findMany('partner_lead_comments', { lead_id: leadId }),
    ]);

    return {
      ...lead,
      partner_name: partnerOrg?.name ?? null,
      partner_slug: partnerOrg?.slug ?? null,
      // findMany cannot order; the thread is small and must read oldest-first.
      comments: [...comments].sort((a, b) =>
        String(a.created_at).localeCompare(String(b.created_at)),
      ),
    };
  }

  async review(leadId: string, reviewerUserId: string, dto: ReviewLeadDto) {
    const lead = await this.loadForOwner(leadId);
    if (lead.status !== 'submitted') {
      throw new BadRequestException(
        `Only submitted leads can be reviewed (status='${lead.status}')`,
      );
    }

    const nextStatus = dto.action === 'accept' ? 'accepted' : 'rejected';

    // Accepting the lead is what entitles the partner to its kickback, so the
    // rate is SNAPSHOTTED onto the lead here rather than read live from the
    // profile at payout time - a later profile change (or de-provisioning) must
    // not retroactively re-price a deal the owner already accepted.
    const kickbackPercent =
      dto.action === 'accept'
        ? await this.resolveKickbackPercent(lead.organization_id as string)
        : null;

    // Linking the org on accept is what authorises the partner to sell to it
    // (public.partner_can_sell_to reads exactly this trail), so it must be
    // committed BEFORE linkCustomerFromLead below inserts the customer -
    // otherwise the partner_customers trigger rejects the insert.
    const updated = await this.repo.updateById('partner_leads', leadId, {
      status: nextStatus,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewerUserId,
      review_note: dto.review_note ?? null,
      ...(dto.action === 'accept' && dto.customer_organization_id
        ? { customer_organization_id: dto.customer_organization_id }
        : {}),
      ...(dto.action === 'accept' ? { kickback_percent: kickbackPercent } : {}),
      updated_by: reviewerUserId,
    });

    if (dto.review_note) {
      // Owner path: the lead was resolved by loadForOwner (super-admin, not
      // org-scoped), so insert directly rather than through the org-scoped
      // addComment - see insertComment's note.
      await this.insertComment(
        lead.organization_id as string,
        reviewerUserId,
        leadId,
        { body: dto.review_note },
        true,
      );
    }

    if (nextStatus === 'accepted') {
      // SECURITY: the org link must come ONLY from the reviewer's DTO, never from
      // the persisted lead row. A partner cannot set customer_organization_id at
      // creation (stripped from CreateLeadDto), but a legacy/tampered row could
      // still carry one - trusting it would let a partner self-authorise a sale to
      // an arbitrary org. So we overlay the reviewer's value and otherwise force
      // it null, rather than falling back to whatever the lead carries.
      await this.linkCustomerFromLead(
        {
          ...lead,
          customer_organization_id: dto.customer_organization_id ?? null,
        },
        reviewerUserId,
      );
    }

    return updated;
  }

  /**
   * The partner's current commission rate. Falls back to 0 rather than throwing:
   * a missing profile must not block the owner from accepting a lead, and 0 is
   * the honest "no agreed kickback" value (provision() defaults it to 0 too).
   */
  private async resolveKickbackPercent(
    partnerOrganizationId: string,
  ): Promise<number> {
    const profile = await this.repo.findOne(
      'partner_profiles',
      { organization_id: partnerOrganizationId },
      'kickback_percent',
    );

    return Number(profile?.kickback_percent ?? 0);
  }

  /** Best-effort: create the partner's customer record from an accepted lead. */
  private async linkCustomerFromLead(lead: any, userId: string): Promise<void> {
    try {
      await this.repo.insert('partner_customers', {
        organization_id: lead.organization_id,
        customer_organization_id: lead.customer_organization_id ?? null,
        customer_name: lead.customer_company_name,
        source_lead_id: lead.id,
        status: lead.customer_organization_id ? 'active' : 'prospect',
        contact_name: lead.contact_name ?? null,
        contact_email: lead.contact_email ?? null,
        contact_phone: lead.contact_phone ?? null,
        created_by: userId,
        updated_by: userId,
      });
    } catch {
      // Customer may already exist / be owned - non-fatal for lead acceptance.
    }
  }
}
