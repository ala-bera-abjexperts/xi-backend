import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { MailService } from '../mail/mail.service';
import type { AssignFormDto } from './dto/assign-form.dto';

const TABLE = 'form_builder_assignments';
const FORMS_TABLE = 'form_builder';

interface ResolvedTargets {
  ids: Set<string>;
  // for each snapshotted user, the space role they were expanded from (audit only)
  sourceRole: Map<string, string | null>;
}

// Jotform-style per-assignee distribution. Assigning to a role snapshots that role's
// current members into one user row each; assigning to specific users creates a row per
// user. Re-assigning is idempotent via the (form_id, assignee_user_id) unique constraint.
// The backend uses the service-role client (RLS bypassed), so every query is scoped by
// organization_id + space_id in app code.
@Injectable()
export class FormBuilderAssignmentsService {
  private readonly logger = new Logger(FormBuilderAssignmentsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly broadcast: NotificationsBroadcastService,
    private readonly mail: MailService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async assign(
    formId: string,
    dto: AssignFormDto,
    spaceId: string,
    organizationId: string,
    assignedByUserId: string,
  ) {
    // IDOR guard — the form must live in this space/org, else 404 (not 403)
    await this.getForm(formId, spaceId, organizationId);

    const targets = await this.resolveTargets(spaceId, dto);

    if (!targets.ids.size)
      throw new BadRequestException(
        'No assignees resolved from the provided users/roles',
      );

    const dueAt = dto.dueAt ?? null;
    const rows = Array.from(targets.ids).map((uid) => ({
      organization_id: organizationId,
      space_id: spaceId,
      form_id: formId,
      assignee_user_id: uid,
      source_role: targets.sourceRole.get(uid) ?? null,
      due_at: dueAt,
      assigned_by: assignedByUserId,
    }));

    // ON CONFLICT DO NOTHING — RETURNING yields ONLY the newly-inserted rows, so we
    // notify exactly the fresh assignees and never re-notify existing ones. Does not
    // reset an already-`completed` row.
    const { data: inserted, error } = await this.client
      .from(TABLE)
      .upsert(rows, {
        onConflict: 'form_id,assignee_user_id',
        ignoreDuplicates: true,
      })
      .select('id, assignee_user_id');

    if (error) throw new BadRequestException(error.message);

    const insertedRows = inserted ?? [];
    const insertedUserIds = insertedRows
      .map((r) => (r as { assignee_user_id: string | null }).assignee_user_id)
      .filter((id): id is string => Boolean(id));

    // best-effort nudge — a failure here must never roll back the assignment
    await this.notifyAssignees(
      insertedUserIds,
      formId,
      spaceId,
      organizationId,
      assignedByUserId,
    );

    const cannotSubmitCount = await this.countCannotSubmit(
      spaceId,
      Array.from(targets.ids),
    );

    return {
      assignedCount: insertedUserIds.length,
      alreadyAssignedCount: targets.ids.size - insertedUserIds.length,
      cannotSubmitCount,
    };
  }

  // Remove a single assignment. Scoped by form/space/org (service-role bypasses RLS), so a mismatched
  // id can never delete another form's or org's row; a non-existent id is a 404.
  async remove(
    formId: string,
    assignmentId: string,
    spaceId: string,
    organizationId: string,
  ) {
    // IDOR guard — the form must live in this space/org.
    await this.getForm(formId, spaceId, organizationId);

    const { data, error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', assignmentId)
      .eq('form_id', formId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .select('id');

    if (error) throw new BadRequestException(error.message);
    if (!data?.length) throw new NotFoundException('Assignment not found');

    return { removed: true };
  }

  async listForForm(formId: string, spaceId: string, organizationId: string) {
    await this.getForm(formId, spaceId, organizationId);

    const { data, error } = await this.client
      .from(TABLE)
      .select(
        '*, assignee:users!assignee_user_id(id, first_name, last_name, email)',
      )
      .eq('form_id', formId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    return data ?? [];
  }

  async listMine(spaceId: string, organizationId: string, userId: string) {
    const { data, error } = await this.client
      .from(TABLE)
      .select(
        '*, form:form_builder!form_id(id, name, icon, status, is_deleted)',
      )
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('assignee_user_id', userId)
      // pending before completed ('pending' > 'completed' so descending lists it first)
      .order('status', { ascending: false })
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    // drop assignments whose form was soft-deleted after the assignment was made
    return (data ?? []).filter(
      (r) => !(r.form && (r.form as { is_deleted?: boolean }).is_deleted),
    );
  }

  // Org-wide "assigned to me" — every form assigned to the caller across ALL spaces in their org
  // (backs the /approvals "Assigned to me" tab). Same as listMine minus the space filter; each row
  // carries its own space_id for client-side space grouping. Tenant-safe via organization_id +
  // assignee_user_id (the RLS-bypassing service-role client relies on these). Capped.
  async listMineOrgWide(organizationId: string, userId: string) {
    const { data, error } = await this.client
      .from(TABLE)
      .select(
        '*, form:form_builder!form_id(id, name, icon, status, is_deleted)',
      )
      .eq('organization_id', organizationId)
      .eq('assignee_user_id', userId)
      // pending before completed ('pending' > 'completed' so descending lists it first)
      .order('status', { ascending: false })
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      .limit(500);

    if (error) throw new BadRequestException(error.message);

    // drop assignments whose form was soft-deleted after the assignment was made
    const rows = (data ?? []) as Array<{
      form?: { is_deleted?: boolean } | null;
    }>;

    return rows.filter((r) => !r.form?.is_deleted);
  }

  // Flip an assignee's pending row to completed when they submit. Best-effort: never
  // throws (a completion-tracking failure must not fail the submission). No-op when the
  // submitter is anonymous (userId null).
  async markCompletedOnSubmit(
    formId: string,
    submittedByUserId: string | null,
    submissionId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<void> {
    if (!submittedByUserId) return;

    const { error } = await this.client
      .from(TABLE)
      .update({
        status: 'completed',
        completed_submission_id: submissionId,
      })
      .eq('form_id', formId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('assignee_user_id', submittedByUserId)
      .eq('status', 'pending');

    if (error)
      this.logger.warn(`markCompletedOnSubmit failed: ${error.message}`);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async getForm(
    formId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<{ id: string; name: string }> {
    const { data, error } = await this.client
      .from(FORMS_TABLE)
      .select('id, name')
      .eq('id', formId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Form not found');

    return data as { id: string; name: string };
  }

  // Explicit userIds ∪ role-expanded members. Role expansion mirrors is_space_member:
  // direct users + group members + role members, filtered to the requested space roles.
  // A bare space_role filter would miss group/role-typed member rows, so we expand those.
  private async resolveTargets(
    spaceId: string,
    dto: AssignFormDto,
  ): Promise<ResolvedTargets> {
    const ids = new Set<string>();
    const sourceRole = new Map<string, string | null>();

    for (const uid of dto.userIds ?? []) ids.add(uid);

    const roles = dto.roles ?? [];

    if (roles.length) {
      const { data, error } = await this.client
        .from('space_members')
        .select('member_type, user_id, group_id, role_id, space_role')
        .eq('space_id', spaceId)
        .eq('is_active', true)
        .in('space_role', roles);

      if (error) throw new BadRequestException(error.message);

      const memberRows = (data ?? []) as Array<{
        member_type: string;
        user_id: string | null;
        group_id: string | null;
        role_id: string | null;
        space_role: string | null;
      }>;

      const roleByGroup = new Map<string, string | null>();
      const roleByRole = new Map<string, string | null>();
      const groupIds: string[] = [];
      const roleIds: string[] = [];

      for (const r of memberRows) {
        if (r.member_type === 'user' && r.user_id) {
          ids.add(r.user_id);
          if (!sourceRole.has(r.user_id))
            sourceRole.set(r.user_id, r.space_role);
        } else if (r.member_type === 'group' && r.group_id) {
          groupIds.push(r.group_id);
          roleByGroup.set(r.group_id, r.space_role);
        } else if (r.member_type === 'role' && r.role_id) {
          roleIds.push(r.role_id);
          roleByRole.set(r.role_id, r.space_role);
        }
      }

      if (groupIds.length) {
        const { data: gm, error: gErr } = await this.client
          .from('user_group_members')
          .select('user_id, group_id')
          .in('group_id', groupIds);

        if (gErr) throw new BadRequestException(gErr.message);

        for (const row of (gm ?? []) as Array<{
          user_id: string | null;
          group_id: string;
        }>) {
          if (!row.user_id) continue;
          ids.add(row.user_id);
          if (!sourceRole.has(row.user_id))
            sourceRole.set(row.user_id, roleByGroup.get(row.group_id) ?? null);
        }
      }

      if (roleIds.length) {
        const { data: rm, error: rErr } = await this.client
          .from('user_role_assignments')
          .select('user_id, role_id')
          .in('role_id', roleIds);

        if (rErr) throw new BadRequestException(rErr.message);

        for (const row of (rm ?? []) as Array<{
          user_id: string | null;
          role_id: string;
        }>) {
          if (!row.user_id) continue;
          ids.add(row.user_id);
          if (!sourceRole.has(row.user_id))
            sourceRole.set(row.user_id, roleByRole.get(row.role_id) ?? null);
        }
      }
    }

    return { ids, sourceRole };
  }

  // Best-effort warning count: assignees who (per their direct space_members row) lack
  // submit_forms. A `viewer` base role can't submit unless a permissions override grants
  // it; users with no direct space_members row (e.g. org admins with implicit access) are
  // assumed able. Not a hard gate — the fill endpoint enforces submit_forms.
  private async countCannotSubmit(
    spaceId: string,
    userIds: string[],
  ): Promise<number> {
    if (!userIds.length) return 0;

    const { data, error } = await this.client
      .from('space_members')
      .select('user_id, space_role, permissions')
      .eq('space_id', spaceId)
      .eq('is_active', true)
      .eq('member_type', 'user')
      .in('user_id', userIds);

    if (error) {
      this.logger.warn(`countCannotSubmit failed: ${error.message}`);

      return 0;
    }

    const rows = (data ?? []) as Array<{
      user_id: string;
      space_role: string | null;
      permissions: Record<string, unknown> | null;
    }>;
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    let count = 0;

    for (const uid of userIds) {
      const row = byUser.get(uid);

      // no direct row → implicit / org-level access, assume they can submit
      if (!row) continue;

      const perms = row.permissions ?? {};
      const override = perms.submit_forms ?? perms.can_submit_forms;

      if (override === true) continue;
      if (override === false) {
        count++;

        continue;
      }

      // no override — fall back to the base role
      if (row.space_role === 'viewer') count++;
    }

    return count;
  }

  private async notifyAssignees(
    userIds: string[],
    formId: string,
    spaceId: string,
    organizationId: string,
    assignedByUserId: string,
  ): Promise<void> {
    if (!userIds.length) return;

    try {
      const [{ data: form }, { data: space }, { data: assigner }] =
        await Promise.all([
          this.client
            .from(FORMS_TABLE)
            .select('name')
            .eq('id', formId)
            .maybeSingle(),
          this.client
            .from('spaces')
            .select('key')
            .eq('id', spaceId)
            .maybeSingle(),
          this.client
            .from('users')
            .select('first_name, last_name')
            .eq('id', assignedByUserId)
            .maybeSingle(),
        ]);

      const formName = (form as { name?: string } | null)?.name ?? 'a form';
      const spaceKey = (space as { key?: string } | null)?.key ?? null;
      const assignerName =
        `${(assigner as { first_name?: string } | null)?.first_name ?? ''} ${
          (assigner as { last_name?: string } | null)?.last_name ?? ''
        }`.trim() || 'Someone';
      const link = spaceKey
        ? `/spaces/${spaceKey}/form-builder/${formId}/fill`
        : null;

      // in-app notifications. action_status:'none' → non-actionable (no accept/decline UI)
      const { data: notifs, error: notifErr } = await this.client
        .from('notifications')
        .insert(
          userIds.map((uid) => ({
            organization_id: organizationId,
            user_id: uid,
            type: 'form_assignment',
            title: `${assignerName} assigned you the form "${formName}"`,
            body: null,
            is_read: false,
            action_status: 'none',
            reference_type: 'form_builder',
            reference_id: formId,
            metadata: {
              form_id: formId,
              form_name: formName,
              assigned_by_user_id: assignedByUserId,
              ...(spaceKey && { space_key: spaceKey }),
            },
          })),
        )
        .select();

      if (notifErr) {
        this.logger.warn(
          `assignment notifications insert failed: ${notifErr.message}`,
        );
      } else {
        for (const n of notifs ?? [])
          void this.broadcast?.broadcastNotification(
            n as Record<string, unknown>,
          );
      }

      // best-effort emails
      const { data: users } = await this.client
        .from('users')
        .select('id, email')
        .in('id', userIds);

      for (const u of (users ?? []) as Array<{
        id: string;
        email: string | null;
      }>) {
        if (!u.email) continue;

        const body =
          `${assignerName} assigned you the form "${formName}".` +
          (link ? `\n\nOpen it in the app: ${link}` : '');

        void this.mail
          .sendNotificationEmail(
            u.email,
            `You've been assigned a form: ${formName}`,
            body,
          )
          .catch((err) =>
            this.logger.warn(
              `assignment email failed for ${u.id}: ${
                (err as Error)?.message ?? err
              }`,
            ),
          );
      }
    } catch (err) {
      this.logger.warn(
        `notifyAssignees failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }
}
