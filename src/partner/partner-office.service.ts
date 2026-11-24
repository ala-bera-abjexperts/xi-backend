/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- dynamically-typed Supabase rows via the generic partner repository */
/**
 * @fileoverview Sub-ticket 3 - partner office (Backoffice) users. Lists the
 * partner org's members (flagging who holds the Backoffice role), invites new
 * Backoffice users restricted to the partner's configured office email domain,
 * and removes active office users. The invitation carries the partner's
 * Backoffice custom_role_id, which the existing accept_invitation flow assigns.
 * @module src/partner/partner-office.service
 */

import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PartnerRepository } from './partner.repository';
import type { InviteOfficeUserDto } from './dto/partner.dto';

const INVITE_TTL_DAYS = 7;

@Injectable()
export class PartnerOfficeService {
  constructor(private readonly repo: PartnerRepository) {}

  async listMembers(organizationId: string) {
    const { data, error } = await this.repo.client
      .from('organization_members')
      .select(
        'user_id, role, created_at, users(id, email, first_name, last_name, is_active)',
      )
      .eq('organization_id', organizationId);

    if (error) {
      throw new BadRequestException(error.message);
    }

    const members = data ?? [];
    const backofficeUserIds = await this.backofficeUserIds(organizationId);

    // organization_members.role is the BASE role ('member' for every Backoffice
    // invitee), so it cannot distinguish an office user from an ordinary member -
    // the partner scope lives in user_role_assignments. Surface it as a flag so the
    // UI can label office users and gate the remove action.
    return members.map((member) => ({
      ...member,
      is_backoffice: backofficeUserIds.has(member.user_id as string),
    }));
  }

  /**
   * user_id set holding this partner's Backoffice custom role. Kept as a separate
   * query because there is no FK between organization_members and
   * user_role_assignments, so PostgREST cannot embed the two.
   */
  private async backofficeUserIds(
    organizationId: string,
  ): Promise<Set<string>> {
    const profile = await this.repo.findOne('partner_profiles', {
      organization_id: organizationId,
    });
    if (!profile?.backoffice_role_id) {
      return new Set();
    }

    const { data, error } = await this.repo.client
      .from('user_role_assignments')
      .select('user_id')
      .eq('organization_id', organizationId)
      .eq('role_id', profile.backoffice_role_id);

    if (error) {
      throw new BadRequestException(error.message);
    }

    return new Set((data ?? []).map((row: { user_id: string }) => row.user_id));
  }

  async listPendingInvites(organizationId: string) {
    const { data, error } = await this.repo.client
      .from('invitations')
      .select('id, email, role, status, created_at, expires_at')
      .eq('organization_id', organizationId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) {
      throw new BadRequestException(error.message);
    }

    return data ?? [];
  }

  async inviteBackoffice(
    organizationId: string,
    inviterUserId: string,
    dto: InviteOfficeUserDto,
  ) {
    const profile = await this.repo.findOne('partner_profiles', {
      organization_id: organizationId,
    });
    if (!profile) {
      throw new NotFoundException('Partner profile not found');
    }

    const domain = (
      profile.office_email_domain as string | null
    )?.toLowerCase();
    if (!domain) {
      throw new BadRequestException(
        'Set the partner office email domain before inviting Backoffice users',
      );
    }
    if (!profile.backoffice_role_id) {
      throw new BadRequestException(
        'The Backoffice role has not been provisioned for this partner yet',
      );
    }

    const email = dto.email.trim().toLowerCase();
    const emailDomain = email.split('@')[1];
    if (!emailDomain || emailDomain !== domain) {
      throw new BadRequestException(
        `Only @${domain} email addresses can be invited as Backoffice users`,
      );
    }

    // Already a member?
    const existingMember = await this.repo.client
      .from('organization_members')
      .select('user_id, users!inner(email)')
      .eq('organization_id', organizationId)
      .eq('users.email', email)
      .maybeSingle();
    if (existingMember.data) {
      throw new ConflictException(
        'This user is already a member of the partner',
      );
    }

    // Existing pending invite?
    const existingInvite = await this.repo.client
      .from('invitations')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('email', email)
      .eq('status', 'pending')
      .maybeSingle();
    if (existingInvite.data) {
      throw new ConflictException(
        'A pending invitation already exists for this email',
      );
    }

    const token =
      randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const expiresAt = new Date(
      Date.now() + INVITE_TTL_DAYS * 86_400_000,
    ).toISOString();

    const invitation = await this.repo.insert('invitations', {
      organization_id: organizationId,
      email,
      // 'member', NOT 'admin'. accept_invitation_atomic writes this straight into
      // organization_members.role, and calculateEffectivePermissions starts from
      // DEFAULT_PERMISSIONS_BY_ROLE[role] before merging custom roles - so 'admin'
      // would hand a back-office/finance invitee full admin over the partner's
      // whole workspace. Worse, the sync_org_member_to_spaces trigger auto-adds
      // owners/admins to EVERY space in the org.
      //
      // The Backoffice partner permissions do not come from the base role: they
      // arrive via custom_role_id below, which accept_invitation_atomic applies as
      // a user_role_assignments row. So 'member' + Backoffice = exactly the
      // intended scope (licences, invoices, quotes) and nothing more.
      role: 'member',
      custom_role_id: profile.backoffice_role_id,
      first_name: dto.first_name ?? null,
      last_name: dto.last_name ?? null,
      invited_by: inviterUserId,
      token,
      expires_at: expiresAt,
    });

    return {
      invitation,
      accept_path: `/auth/accept-invitation?token=${token}`,
    };
  }

  async revokeInvite(organizationId: string, invitationId: string) {
    const { data, error } = await this.repo.client
      .from('invitations')
      .update({ status: 'revoked' })
      .eq('id', invitationId)
      .eq('organization_id', organizationId)
      .eq('status', 'pending')
      .select()
      .maybeSingle();

    if (error) {
      throw new BadRequestException(error.message);
    }
    if (!data) {
      throw new NotFoundException('Pending invitation not found');
    }

    return { success: true };
  }

  /**
   * Removes an active office user: drops the Backoffice role assignment AND the
   * organization_members row.
   *
   * Full eviction, not just un-assigning the role. A Backoffice user only exists in
   * the partner org because inviteBackoffice put them there; their base role is
   * 'member', so revoking the role alone would silently downgrade them to a plain
   * member who keeps workspace access (spaces, boards, tasks) while disappearing
   * from the office UI - access the partner believes they revoked. Conversely,
   * deleting only the membership would strand the user_role_assignments row (it has
   * no FK to organization_members, so nothing cascades), which would re-grant the
   * partner permissions the moment the user was re-invited. "Manage their office
   * users" means both rows go.
   */
  async removeMember(
    organizationId: string,
    actorUserId: string,
    userId: string,
  ) {
    if (userId === actorUserId) {
      throw new BadRequestException(
        'You cannot remove yourself from the partner office',
      );
    }

    // The repository uses the service-role client, so RLS is bypassed and this
    // organization_id filter IS the tenant boundary: a userId belonging to another
    // partner resolves to no row and 404s instead of touching that org's members.
    const { data: member, error } = await this.repo.client
      .from('organization_members')
      .select('user_id, role')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      throw new BadRequestException(error.message);
    }
    if (!member) {
      throw new NotFoundException('User is not a member of this partner');
    }

    // Owners are the partner's own principals, not office users: removing one here
    // would let a Backoffice user evict the account holder.
    if (member.role === 'owner') {
      throw new ForbiddenException(
        'Partner owners cannot be removed as office users',
      );
    }

    const profile = await this.repo.findOne('partner_profiles', {
      organization_id: organizationId,
    });

    // Role assignment first: if the membership delete then fails, the user is left a
    // plain member (retry-able) rather than evicted with a live partner grant.
    if (profile?.backoffice_role_id) {
      const { error: roleError } = await this.repo.client
        .from('user_role_assignments')
        .delete()
        .eq('organization_id', organizationId)
        .eq('user_id', userId)
        .eq('role_id', profile.backoffice_role_id);

      if (roleError) {
        throw new BadRequestException(roleError.message);
      }
    }

    const { error: memberError } = await this.repo.client
      .from('organization_members')
      .delete()
      .eq('organization_id', organizationId)
      .eq('user_id', userId);

    if (memberError) {
      throw new BadRequestException(memberError.message);
    }

    return { success: true };
  }
}
