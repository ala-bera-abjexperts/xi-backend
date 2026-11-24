/**
 * @fileoverview Show/hide condition evaluation for document elements.
 * Wraps the automation module's in-memory {@link FilterEvaluator} so document
 * templates reuse the exact same react-querybuilder rule semantics that
 * automations use, evaluated against the raw entity row of the current item.
 *
 * Field-name mapping performed before delegation:
 *  - `cf_<key>` → `custom_field_values[<key>]` (flattened onto the eval object)
 *  - `<key>`    → bare custom-field keys ALSO resolve from custom_field_values
 *                 when they do not collide with a real row column (the designer
 *                 UI stores custom fields under their bare field_key).
 *  - `title`    → aliased by FilterEvaluator itself ('summary' for tasks,
 *                 'name' for processes; we additionally bridge `name` → `title`
 *                 for process rows because `business_processes` stores `title`).
 *  - `space_name` → bridged from the nested `space` join when present.
 *
 * NO-ITEM CONTEXT (documented decision): in fixed_document mode, statics,
 * anchored elements and the items region itself have no single item row. Their
 * conditions are evaluated against a META-ONLY context ({@link buildMetaData}:
 * exportDate/exportedBy/itemIndex/itemCount) — rules on meta fields are
 * meaningful, while rules referencing item fields resolve `undefined` and are
 * therefore treated as NON-MATCHING, with a warning naming the fields so the
 * author learns why the element behaves that way.
 *
 * Fail-open: any unexpected error yields `{ show: true, warning }` so a broken
 * condition never blanks an export silently.
 * @module src/document-designer/rendering/element-condition-evaluator
 */

import { FilterEvaluator } from '../../automations/utils/filter-evaluator';
import type { IFilterRuleGroup as IAutomationRuleGroup } from '../../automations/utils/filter-evaluator';
import type { IFilterRuleGroup } from '../../saved-filters/filter-query-engine';
import type { IDocumentMetaContext } from './field-formatter';

export interface IConditionResult {
  show: boolean;
  warning?: string;
}

export class ElementConditionEvaluator {
  private readonly evaluator: FilterEvaluator;

  constructor(private readonly entityType: string) {
    this.evaluator = new FilterEvaluator(entityType);
  }

  /**
   * Evaluate a rule group against a raw entity row.
   * `null`/empty conditions always show; errors fail open with a warning.
   * When `itemRaw` is null/undefined (fixed_document statics/anchored/items
   * region), evaluation runs against a meta-only context — see module header.
   * `variables` (runtime template variables, see document-render.service's
   * `var.` token support) is optional and flattened in as `var.<name>` keys —
   * a rule can test a variable's value AS OF THIS POINT in render walk order.
   */
  evaluate(
    condition: IFilterRuleGroup | null | undefined,
    itemRaw: Record<string, unknown> | null | undefined,
    meta?: IDocumentMetaContext,
    variables?: Map<string, unknown>,
  ): IConditionResult {
    if (!condition || !Array.isArray(condition.rules)) {
      return { show: true };
    }
    if (condition.rules.length === 0) {
      return { show: true };
    }

    try {
      if (itemRaw === null || itemRaw === undefined) {
        return this.evaluateWithoutItem(condition, meta, variables);
      }

      const data = this.buildEvaluationData(itemRaw, variables);
      const show = this.evaluator.evaluate(
        condition as unknown as IAutomationRuleGroup,
        data,
      );
      return { show };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        show: true,
        warning: `Condition evaluation failed (element shown): ${message}`,
      };
    }
  }

  /**
   * Meta-only evaluation for elements with no item context (fixed_document
   * statics/anchored). Item-field references resolve `undefined` — never
   * matching — and are surfaced in a warning (documented decision).
   */
  private evaluateWithoutItem(
    condition: IFilterRuleGroup,
    meta: IDocumentMetaContext | undefined,
    variables: Map<string, unknown> | undefined,
  ): IConditionResult {
    const data = this.buildMetaData(meta, variables);

    const referenced = new Set<string>();
    collectRuleFields(condition, referenced);
    const unresolvable = Array.from(referenced).filter(
      (field) => !(field in data),
    );

    const show = this.evaluator.evaluate(
      condition as unknown as IAutomationRuleGroup,
      data,
    );

    if (unresolvable.length > 0) {
      return {
        show,
        warning: `Condition references item field(s) ${unresolvable.join(', ')} with no item context (fixed_document); treated as non-matching`,
      };
    }
    return { show };
  }

  /** Meta context exposed to no-item-context conditions. */
  private buildMetaData(
    meta: IDocumentMetaContext | undefined,
    variables: Map<string, unknown> | undefined,
  ): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    if (meta) {
      if (meta.exportDate) data['exportDate'] = meta.exportDate.toISOString();
      if (meta.exportedByUserId != null)
        data['exportedBy'] = meta.exportedByUserId;
      if (meta.itemIndex != null) data['itemIndex'] = meta.itemIndex;
      if (meta.itemCount != null) data['itemCount'] = meta.itemCount;
    }
    this.flattenVariables(data, variables);
    return data;
  }

  /** Flatten runtime variables as `var.<name>` keys — see `evaluate`'s doc. */
  private flattenVariables(
    data: Record<string, unknown>,
    variables: Map<string, unknown> | undefined,
  ): void {
    if (!variables) return;
    for (const [name, value] of variables) {
      data[`var.${name}`] = value;
    }
  }

  /**
   * Flatten custom field values as `cf_<key>` AND (collision-free) bare-key
   * properties, and bridge entity naming differences so rules built by the
   * designer/filter UI resolve correctly.
   */
  private buildEvaluationData(
    raw: Record<string, unknown>,
    variables: Map<string, unknown> | undefined,
  ): Record<string, unknown> {
    const data: Record<string, unknown> = { ...raw };

    const customValues = raw['custom_field_values'];
    if (customValues && typeof customValues === 'object') {
      for (const [key, value] of Object.entries(
        customValues as Record<string, unknown>,
      )) {
        data[`cf_${key}`] = value;

        // The designer's bindable-fields catalog exposes custom fields under
        // their BARE field_key — expose it too, without shadowing real columns.
        if (!(key in data)) data[key] = value;
      }
    }

    // FilterEvaluator aliases process 'title' → 'name', but business_processes
    // rows actually store 'title'; expose both so either resolves.
    if (this.entityType === 'process' && data['name'] === undefined) {
      data['name'] = data['title'];
    }

    // 'space_name' is offered in the condition dropdown but lives on the
    // nested space join, not the row itself — bridge it when available.
    if (data['space_name'] === undefined) {
      const space = raw['space'];
      if (space && typeof space === 'object') {
        data['space_name'] = (space as Record<string, unknown>)['name'];
      }
    }

    this.flattenVariables(data, variables);

    return data;
  }
}

/** Recursively collect every rule's field name from a rule group. */
function collectRuleFields(group: IFilterRuleGroup, acc: Set<string>): void {
  if (!Array.isArray(group.rules)) return;
  for (const rule of group.rules) {
    if ('combinator' in rule) {
      collectRuleFields(rule, acc);
    } else if (typeof rule.field === 'string') {
      acc.add(rule.field);
    }
  }
}
