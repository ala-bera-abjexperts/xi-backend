/**
 * @fileoverview "Request more information with a form" (XE-T546). Staff attach a published
 * Form Builder form to a support-linked task; the customer fills it on the portal and the
 * answers land on that task through Form Builder's existing task-attached submission path.
 *
 * Staff routes are gated exactly like customer-reply publishing (`publish_customer_replies`
 * on the task's space via {@link SlaAccessService.authorizeTask}). The customer methods do NO
 * authorization themselves — callers must pass `HelpCenterRepository.findVisible` first.
 * @module src/sla/sla-form-requests.service
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { SlaAccessService } from './sla-access.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { FormBuilderSubmissionsService } from '../form-builder/form-builder-submissions.service';
import {
  PUBLIC_UPLOAD_FIELD_TYPES,
  PublicFormBuilderService,
} from '../form-builder/public/public-form-builder.service';
import { findPubliclyUnsafeTypes } from '../form-builder/public/public-form-safety.util';

const TABLE = 'support_request_form_requests';
const STAFF_SELECT =
  'id,status,created_at,completed_at,submission_id,form:form_id(id,name)';

type FieldLike = {
  field_type: string;
  validation_rules?: unknown;
  options?: unknown;
};

/**
 * Field types a customer may not be sent: everything the public-form gate rejects, plus
 * upload types (`file_upload`/`audio`) — the portal has no upload endpoint for them — even
 * when nested in a `layout` cell.
 */
function unsafeTypes(fields: FieldLike[]): string[] {
  const cellTypes = fields
    .filter((f) => f.field_type === 'layout')
    .flatMap((f) => {
      const cells = (f.options as { cells?: unknown } | null)?.cells;
      return Array.isArray(cells)
        ? cells
            .filter(Array.isArray)
            .flat()
            .map((cell) => (cell as { type?: unknown } | null)?.type)
        : [];
    });
  const uploads = [...fields.map((f) => f.field_type), ...cellTypes].filter(
    (t): t is string =>
      typeof t === 'string' && PUBLIC_UPLOAD_FIELD_TYPES.has(t),
  );
  return [...new Set([...findPubliclyUnsafeTypes(fields), ...uploads])].sort();
}

@Injectable()
export class SlaFormRequestsService {
  private readonly logger = new Logger(SlaFormRequestsService.name);

  constructor(
    private readonly admin: SupabaseAdminService,
    private readonly access: SlaAccessService,
    private readonly submissions: FormBuilderSubmissionsService,
    private readonly publicForms: PublicFormBuilderService,
  ) {}

  private get db() {
    return this.admin.getClient();
  }

  private check(error: { message?: string } | null): void {
    if (error)
      throw new InternalServerErrorException('Unable to process form request');
  }

  private assertSafe(fields: FieldLike[]): void {
    const unsafe = unsafeTypes(fields);
    if (unsafe.length)
      throw new BadRequestException(
        `This form cannot be sent to a customer because it contains: ${unsafe.join(', ')}`,
      );
  }

  // ── Staff ──────────────────────────────────────────────────────────────────

  async listForTask(user: RequestUser, taskId: string) {
    const task = await this.access.authorizeTask(
      user,
      taskId,
      'publish_customer_replies',
    );
    const { data, error } = await this.db
      .from(TABLE)
      .select(STAFF_SELECT)
      .eq('task_id', taskId)
      .eq('organization_id', task.organization_id)
      .order('created_at', { ascending: true });
    this.check(error);
    return data ?? [];
  }

  async createForTask(user: RequestUser, taskId: string, formId: string) {
    const task = await this.access.authorizeTask(
      user,
      taskId,
      'publish_customer_replies',
    );

    const { data: request, error: requestError } = await this.db
      .from('support_requests')
      .select('id')
      .eq('task_id', taskId)
      .eq('organization_id', task.organization_id)
      .maybeSingle();
    this.check(requestError);
    if (!request) throw new BadRequestException('Link a support request first');

    const { data: form, error: formError } = await this.db
      .from('form_builder')
      .select('id,status,space_id,organization_id,is_deleted')
      .eq('id', formId)
      .maybeSingle();
    this.check(formError);
    // One message for missing / other-org / other-space / unpublished, so a foreign form id
    // is indistinguishable from a nonexistent one.
    if (
      !form ||
      form.is_deleted === true ||
      form.status !== 'published' ||
      form.organization_id !== task.organization_id ||
      form.space_id !== task.space_id
    )
      throw new BadRequestException(
        "The form must be a published form in this task's space",
      );

    const { data: fields, error: fieldsError } = await this.db
      .from('form_builder_fields')
      .select('field_type,validation_rules,options')
      .eq('form_id', formId);
    this.check(fieldsError);
    this.assertSafe((fields ?? []) as FieldLike[]);

    const { data, error } = await this.db
      .from(TABLE)
      .insert({
        organization_id: task.organization_id,
        request_id: (request as { id: string }).id,
        task_id: taskId,
        form_id: formId,
        requested_by: user.userId,
      })
      .select(STAFF_SELECT)
      .single();
    this.check(error);
    return data;
  }

  /** Pending → cancelled. 404 if not on this task, 409 if no longer pending. */
  async cancel(user: RequestUser, taskId: string, id: string): Promise<void> {
    const task = await this.access.authorizeTask(
      user,
      taskId,
      'publish_customer_replies',
    );
    const { data: row, error } = await this.db
      .from(TABLE)
      .select('id,status')
      .eq('id', id)
      .eq('task_id', taskId)
      .eq('organization_id', task.organization_id)
      .maybeSingle();
    this.check(error);
    if (!row) throw new NotFoundException('Form request not found');
    if (row.status !== 'pending')
      throw new ConflictException(
        'Only a pending form request can be cancelled',
      );

    const { data: updated, error: updateError } = await this.db
      .from(TABLE)
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id');
    this.check(updateError);
    if (!updated?.length)
      throw new ConflictException(
        'Only a pending form request can be cancelled',
      );
  }

  // ── Customer (caller has already passed findVisible for requestId) ────────

  /** Field definitions exactly as the public form renderer receives them. */
  private async publicFields(form: {
    id: string;
    space_id: string | null;
    organization_id: string;
  }) {
    // Same loader + sanitizer as the anonymous public-form path — one field shape, no copy.
    const rows = await this.publicForms.loadFields(form.id);
    if (unsafeTypes(rows).length) return { rows, fields: [] };
    const assetOptions = await this.publicForms.resolveAssetOptions(form, rows);
    return {
      rows,
      fields: rows.map((row) =>
        this.publicForms.toPublicField(row, assetOptions),
      ),
    };
  }

  async listForRequest(requestId: string) {
    const { data, error } = await this.db
      .from(TABLE)
      .select(
        'id,status,created_at,completed_at,form:form_id(id,name,description,space_id,organization_id)',
      )
      .eq('request_id', requestId)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: true });
    this.check(error);

    const rows = (data ?? []) as unknown as Array<{
      id: string;
      status: 'pending' | 'completed';
      created_at: string;
      completed_at: string | null;
      form: {
        id: string;
        name: string;
        description: string | null;
        space_id: string | null;
        organization_id: string;
      };
    }>;

    const fieldsByForm = new Map<string, Promise<unknown[]>>();
    return Promise.all(
      rows.map(async (row) => {
        let fields: unknown[] = [];
        if (row.status === 'pending' && row.form) {
          if (!fieldsByForm.has(row.form.id))
            fieldsByForm.set(
              row.form.id,
              this.publicFields(row.form).then((r) => r.fields),
            );
          fields = await fieldsByForm.get(row.form.id)!;
        }
        return {
          id: row.id,
          status: row.status,
          created_at: row.created_at,
          completed_at: row.completed_at,
          form: {
            id: row.form?.id,
            name: row.form?.name,
            description: row.form?.description ?? null,
            fields,
          },
        };
      }),
    );
  }

  /**
   * Submit the customer's answers onto the task. The submission itself is recorded with NO
   * submitter (an out-of-tenant customer is not a tenant-scoped `submitted_by`, precedent:
   * the anonymous public-form path); the customer is recorded on the form-request row.
   */
  async submitForRequest(
    requestId: string,
    formRequestId: string,
    userId: string,
    data: Record<string, unknown>,
    meta: { ip?: string | null; userAgent?: string | null },
  ): Promise<{ id: string; status: 'completed' }> {
    const { data: row, error } = await this.db
      .from(TABLE)
      .select(
        'id,status,task_id,organization_id,form:form_id(id,space_id,organization_id)',
      )
      .eq('id', formRequestId)
      .eq('request_id', requestId)
      .maybeSingle();
    this.check(error);
    if (!row) throw new NotFoundException('Form request not found');

    const fr = row as unknown as {
      status: string;
      task_id: string | null;
      organization_id: string;
      form: { id: string; space_id: string; organization_id: string } | null;
    };
    if (fr.status !== 'pending')
      throw new ConflictException('This form request is no longer pending');
    if (!fr.task_id || !fr.form)
      throw new ConflictException(
        'This form request is no longer linked to a task',
      );

    // Re-checked at submit: the form may have gained an unsafe/upload field since it was sent.
    const { rows } = await this.publicFields(fr.form);
    this.assertSafe(rows);

    // Claim BEFORE creating the submission: exactly one concurrent submit flips the row out of
    // `pending`; the loser gets 409 before any submission exists. The claim state is
    // `completed` with submission_id still null (the CHECK allows no transient status).
    const { data: claimed, error: claimError } = await this.db
      .from(TABLE)
      .update({
        status: 'completed',
        submitted_by: userId,
        completed_at: new Date().toISOString(),
      })
      .eq('id', formRequestId)
      .eq('request_id', requestId)
      .eq('status', 'pending')
      .select('id');
    this.check(claimError);
    if (!claimed?.length)
      throw new ConflictException('This form request is no longer pending');

    const { form, task_id: taskId } = fr;
    let submission: { id: string };
    try {
      submission = (await this.submissions.create(
        form.id,
        { data, task_id: taskId },
        form.space_id,
        fr.organization_id,
        null,
        meta,
      )) as { id: string };
    } catch (err) {
      // Release the claim so the customer can retry; they see the ORIGINAL error (e.g. a 400
      // from Form Builder's answer validation), never the revert's.
      const { error: revertError } = await this.db
        .from(TABLE)
        .update({ status: 'pending', submitted_by: null, completed_at: null })
        .eq('id', formRequestId)
        .is('submission_id', null);
      if (revertError)
        this.logger.error(
          `Failed to release claim on form request ${formRequestId}: ${revertError.message}`,
        );
      throw err;
    }

    // The submission was created successfully — the claim must stay `completed` regardless of
    // what happens next. Reverting here would let a retry create a second submission (no 409)
    // while the first one is orphaned. Log and move on; the link can be repaired out of band.
    const { error: linkError } = await this.db
      .from(TABLE)
      .update({ submission_id: submission.id })
      .eq('id', formRequestId);
    if (linkError)
      this.logger.error(
        `Failed to link submission ${submission.id} to form request ${formRequestId}: ${linkError.message}`,
      );

    return { id: formRequestId, status: 'completed' };
  }
}
