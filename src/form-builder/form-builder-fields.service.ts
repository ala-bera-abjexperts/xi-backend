import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { ReplaceFormBuilderFieldsDto } from './dto/replace-form-builder-fields.dto';
import { sanitizeRichText } from '../common/utils/sanitize-rich-text';
import { compileExpression, extractRefs } from './logic/expression-engine';
import { topoSortCalcs, CalcCycleError, CalcNode } from './logic/calc-graph';
import { FormBuilderPaymentConfigService } from './form-builder-payment-config.service';
import {
  findPubliclyUnsafeTypes,
  isPaymentConfigOnlyBlocker,
} from './public/public-form-safety.util';

const FIELDS_TABLE = 'form_builder_fields';
const FORMS_TABLE = 'form_builder';

// Reject validation patterns that are too long or exhibit the classic nested-
// quantifier ReDoS shape `(…+)+` / `(…*)*` — `safe-regex` isn't available here,
// so this is a dependency-free heuristic applied at save time.
const NESTED_QUANTIFIER = /\([^()]*[+*]\)[+*?]/;

type FieldInput = ReplaceFormBuilderFieldsDto['fields'][number];

/** Neither `label` nor `validation_rules` has a length cap, and HTML makes bloat easy. */
const PARAGRAPH_HTML_MAX_LENGTH = 20_000;

// One element nested in a Layout field's `options.cells`. Mirrors ILayoutCell on the client.
interface LayoutCellInput {
  type?: string;
  label?: string;
  fieldKey?: string;
  conditionalLogic?: unknown;
}

@Injectable()
export class FormBuilderFieldsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,

    // Optional so a wiring gap degrades to "payments not configured" — which only ever makes the
    // public-safety check stricter — rather than breaking field saves outright.
    @Optional()
    private readonly paymentConfig?: FormBuilderPaymentConfigService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async list(formId: string, spaceId: string, organizationId: string) {
    const { data, error } = await this.client
      .from(FIELDS_TABLE)
      .select('*')
      .eq('form_id', formId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    return data ?? [];
  }

  // replace all of a form's fields at once, via the replace_form_builder_fields RPC
  async replaceAll(
    formId: string,
    dto: ReplaceFormBuilderFieldsDto,
    spaceId: string,
    organizationId: string,
    userId: string,
  ) {
    this.validateFieldLogic(dto.fields);
    await this.assertPublicSafeIfShared(
      formId,
      dto.fields,
      spaceId,
      organizationId,
    );

    const fields = dto.fields.map((f) => this.withSanitizedParagraph(f));

    const { data, error } = await this.client.rpc(
      'replace_form_builder_fields',
      {
        p_form_id: formId,
        p_space_id: spaceId,
        p_organization_id: organizationId,
        p_user_id: userId,
        p_expected_version: dto.version,
        p_fields: fields,
      },
    );

    if (error) {
      if (error.code === 'P0001' || /version/i.test(error.message))
        throw new ConflictException(
          'Stale version — reload the builder and retry',
        );
      if (error.code === '23505')
        throw new BadRequestException('Duplicate field_key within the form');
      if (error.code === 'PGRST116')
        throw new NotFoundException('Form not found');
      throw new BadRequestException(error.message);
    }

    return data;
  }

  /**
   * A paragraph's formatted body is author-written HTML that renders on ANONYMOUS pages (paragraph
   * is in PUBLIC_DISPLAY_TYPES), so it is sanitised here, on the way in. The read side sanitises
   * too, but this is the boundary that holds even if a future renderer forgets.
   *
   * Tables are not allowed: the paragraph editor has no table nodes, so one would be dropped on
   * open and destroyed on the next save.
   */
  private withSanitizedParagraph(field: FieldInput): FieldInput {
    if (field.field_type !== 'paragraph') return field;

    const rules = field.validation_rules;
    const raw = rules?.paragraph_html;

    if (typeof raw !== 'string') return field;

    const clean =
      sanitizeRichText(raw.slice(0, PARAGRAPH_HTML_MAX_LENGTH), {
        allowTables: false,
      }) ?? '';

    return { ...field, validation_rules: { ...rules, paragraph_html: clean } };
  }

  /**
   * Keeps a live public link honest: `updatePublicLink` only checks at enable time, so adding an
   * unservable field afterwards used to kill the link with an opaque 404 and no explanation.
   * Guarded on `is_public`, so private forms take their previous path unchanged.
   */
  private async assertPublicSafeIfShared(
    formId: string,
    fields: FieldInput[],
    spaceId: string,
    organizationId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from(FORMS_TABLE)
      .select('is_public')
      .eq('id', formId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    // Missing row is not this method's failure to report — the RPC below raises the canonical
    // "Form not found" for it.
    if (!(data as { is_public?: boolean } | null)?.is_public) return;

    const paymentConfigured = fields.some((f) => f.field_type === 'products')
      ? await this.hasUsablePaymentConfig(organizationId, spaceId)
      : false;

    const unsafe = findPubliclyUnsafeTypes(fields, { paymentConfigured });

    if (!unsafe.length) return;

    // Payments are the one blocker with a fix other than "delete your work", so say what that fix is.
    if (isPaymentConfigOnlyBlocker(unsafe)) {
      throw new BadRequestException(
        'This form is shared publicly and contains a Products field, but no payment gateway is connected for this space. Connect Stripe in the payment settings to sell on a public form, or turn the public link off.',
      );
    }

    throw new BadRequestException(
      `This form is shared publicly, so it cannot contain: ${unsafe.join(', ')}. Remove these fields, or turn the public link off first.`,
    );
  }

  /** Mirrors the fill page's `enabled` rule, so publish-time and fill-time can never disagree. */
  private async hasUsablePaymentConfig(
    orgId: string,
    spaceId: string,
  ): Promise<boolean> {
    if (!this.paymentConfig) return false;

    try {
      const config = await this.paymentConfig.getFillConfig({ orgId, spaceId });

      return config.enabled === true;
    } catch {
      return false;
    }
  }

  // Every element nested in a Layout field's `options.cells`, paired with the answer key it will submit
  // under. Layout children are not rows, so without this they are invisible to logic validation: a rule
  // pointing at a cell would be rejected as an unknown field, and a rule ON a cell would never be checked
  // at all (saving cleanly, then failing closed at runtime with nothing to explain it).
  private collectCellRefs(
    fields: FieldInput[],
  ): { key: string; ownerKey: string; logic: unknown }[] {
    const out: { key: string; ownerKey: string; logic: unknown }[] = [];

    for (const f of fields) {
      if (f.field_type !== 'layout') continue;

      const cells =
        ((f.options as { cells?: unknown } | null)?.cells as
          | Array<Array<LayoutCellInput>>
          | undefined) ?? [];

      cells.forEach((row, r) =>
        (row ?? []).forEach((cell, c) => {
          if (!cell?.type) return;

          const key = cell.fieldKey || `${f.field_key}__cell_r${r}_c${c}`;

          out.push({
            key,
            ownerKey: `${f.field_key} › ${cell.label || cell.type}`,
            logic: cell.conditionalLogic,
          });
        }),
      );
    }

    return out;
  }

  private validateFieldLogic(fields: FieldInput[]) {
    const cellRefs = this.collectCellRefs(fields);

    // Cell keys join the known-key set so a top-level rule may target a layout child, and vice versa.
    const keys = new Set([
      ...fields.map((f) => f.field_key),
      ...cellRefs.map((c) => c.key),
    ]);

    const calcNodes: CalcNode[] = [];

    // Validate rules authored ON a cell with the same strictness as a top-level field's.
    for (const cell of cellRefs) {
      const logic = cell.logic as { ruleGroup?: unknown } | undefined;

      if (!logic?.ruleGroup) continue;

      for (const ref of this.collectRuleFields(logic.ruleGroup)) {
        if (!keys.has(ref))
          throw new BadRequestException(
            `Condition on "${cell.ownerKey}" references unknown field "${ref}"`,
          );

        if (ref === cell.key)
          throw new BadRequestException(
            `Condition on "${cell.ownerKey}" cannot reference itself`,
          );
      }
    }

    for (const f of fields) {
      const pattern = f.validation_rules?.pattern;

      if (typeof pattern === 'string') {
        if (pattern.length > 200)
          throw new BadRequestException(
            `Validation pattern on "${f.field_key}" is too long`,
          );
        if (NESTED_QUANTIFIER.test(pattern))
          throw new BadRequestException(
            `Validation pattern on "${f.field_key}" is not allowed`,
          );
      }

      const logic = f.conditional_logic as { ruleGroup?: unknown } | undefined;

      if (logic && logic.ruleGroup) {
        for (const ref of this.collectRuleFields(logic.ruleGroup)) {
          if (!keys.has(ref))
            throw new BadRequestException(
              `Condition on "${f.field_key}" references unknown field "${ref}"`,
            );
        }
      }

      const calc = f.calculation as { expression?: string } | undefined;

      if (f.field_type === 'calculated' && calc?.expression) {
        let refs: string[];

        try {
          compileExpression(calc.expression);
          refs = extractRefs(calc.expression);
        } catch (e) {
          throw new BadRequestException(
            `Calculation on "${f.field_key}" is invalid: ${(e as Error).message}`,
          );
        }

        for (const ref of refs) {
          if (!keys.has(ref))
            throw new BadRequestException(
              `Calculation on "${f.field_key}" references unknown field "${ref}"`,
            );
        }

        calcNodes.push({ fieldKey: f.field_key, refs });
      }
    }

    try {
      topoSortCalcs(calcNodes);
    } catch (e) {
      if (e instanceof CalcCycleError)
        throw new BadRequestException({
          message: 'Calculated fields form a dependency cycle',
          cycle: e.cycle,
        });

      throw e;
    }
  }

  private collectRuleFields(group: unknown): string[] {
    const out: string[] = [];
    const g = group as { rules?: unknown[] };

    if (!g || !Array.isArray(g.rules)) return out;

    for (const node of g.rules) {
      const n = node as { rules?: unknown[]; field?: unknown };

      if (n && Array.isArray(n.rules)) out.push(...this.collectRuleFields(n));
      else if (n && typeof n.field === 'string') out.push(n.field);
    }

    return out;
  }
}
