// =============================================================================
// DOCUMENT DESIGNER — TEMPLATE DEFINITION CONTRACT (schemaVersion 1)
//
// SYNC RULE: the shapes in this file MUST stay semantically identical to the
// frontend contract in src/models/document-template.model.ts. The definition
// jsonb stored in document_templates.definition is produced by the frontend
// editor and consumed by the backend renderer — any divergence breaks WYSIWYG.
//
// Units: ALL geometry values are CSS px at 96 dpi (1in = 96px). The designer
// canvas, the preview iframe, and headless-Chromium PDF printing all interpret
// px identically, which is what guarantees pixel-perfect exports.
// =============================================================================

import type { IFilterRuleGroup } from '../../saved-filters/filter-query-engine';

export type DocumentTemplateMode = 'repeat_per_item' | 'fixed_document';
/** Space modules a template can export — `space_modules.module_type` labels. */
export type DocumentSourceEntity =
  | 'tasks'
  | 'processes'
  | 'wiki'
  | 'lists'
  | 'dashboards'
  | 'boards'
  | 'plans'
  | 'automations'
  | 'assets'
  | 'file_explorer'
  | 'form_builder';
export type DocumentPaperSize = 'A4' | 'Letter' | 'Legal' | 'A3' | 'A5';
export type DocumentPaperOrientation = 'portrait' | 'landscape';
export type DocumentExportFormat = 'pdf' | 'docx' | 'html';

export type DocElementType =
  | 'line'
  | 'rectangle'
  | 'ellipse'
  | 'text'
  | 'link'
  | 'image'
  | 'field'
  | 'loop_region'
  | 'variable_set';

/**
 * absolute — fixed at (x, y) on the page / inside its loop region.
 * relative — y offsets AFTER the preceding loop region's rendered height
 *            (reflows on export when regions grow).
 * anchored — repeats at (x, y) on EVERY page (fixed_document mode only).
 */
export type DocPositionMode = 'absolute' | 'relative' | 'anchored';

/**
 * items = the export scope list (fixed_document top-level regions only).
 * dynamic_query = queries `targetEntity` where `filterField` equals the
 * enclosing parent row's `comparisonField` value; nestable to
 * MAX_LOOP_REGION_DEPTH like subtasks/linked_tasks.
 */
export type DocLoopDataSource =
  | 'items'
  | 'subtasks'
  | 'linked_tasks'
  | 'dynamic_query'
  | TaskListSource;

/** A task's own lists, looped by a region placed directly under the exported task (tasks templates only). */
export type TaskListSource =
  | 'comments'
  | 'history'
  | 'attachments'
  | 'sla_history'
  | 'relations'
  | 'linked_wiki_pages'
  | 'linked_assets';

export type DocFieldBindingSource = 'system' | 'custom_field' | 'meta';

/** variable_set ops — see IDocVariableSetElement. */
export type DocVariableSetOp = 'assign' | 'increment' | 'decrement' | 'concat';

/** Whitelisted, renderer-safe style keys. Unknown keys are stripped by zod. */
export interface IDocElementStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: 400 | 500 | 600 | 700;
  lineHeight?: number;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  opacity?: number;
  padding?: number;
}

export interface IDocFieldFormat {
  /** date-fns format string, e.g. 'dd.MM.yyyy'. */
  dateFormat?: string;
  userDisplay?: 'name' | 'email';
  /** Render editor/HTML custom-field values as rich HTML (sanitized). */
  renderHtml?: boolean;
  numberFormat?: 'plain' | 'percent' | 'currency';
  currency?: string;
}

export interface IDocFieldBinding {
  source: DocFieldBindingSource;
  fieldKey: string;
  /** Optional label override rendered by label-showing layouts. */
  label?: string;
  format?: IDocFieldFormat;
}

/** Discriminated image source — the SSRF control surface (see pdf-render). */
export type DocImageSrc =
  | { kind: 'storage'; bucket: string; path: string }
  | { kind: 'data'; dataUri: string }
  | { kind: 'url'; url: string };

export interface IDocElementBase {
  id: string;
  type: DocElementType;
  /**
   * px; PAGE-ORIGIN — measured from the physical page's top-left corner
   * (page margins are guides only and never offset elements) — or relative
   * to the loop-region content origin when parentId is set.
   */
  x: number;
  y: number;
  width: number;
  height: number;
  /** degrees, clockwise, around the element center. */
  rotation: number;
  positionMode: DocPositionMode;
  zIndex: number;
  /** id of the containing loop_region, or null for page-level elements. */
  parentId?: string | null;
  /** Show/hide rule evaluated against the current data item (react-querybuilder shape). */
  condition?: IFilterRuleGroup | null;
  style: IDocElementStyle;
}

export interface IDocLineElement extends IDocElementBase {
  type: 'line';
}

export interface IDocRectangleElement extends IDocElementBase {
  type: 'rectangle';
}

export interface IDocEllipseElement extends IDocElementBase {
  type: 'ellipse';
}

export interface IDocTextElement extends IDocElementBase {
  type: 'text';
  /** TipTap HTML; may contain {{fieldKey}} tokens. Sanitized at render. */
  html: string;
}

export interface IDocLinkElement extends IDocElementBase {
  type: 'link';
  text: string;
  /** http(s) only; may contain {{fieldKey}} tokens. */
  href: string;
}

export interface IDocImageElement extends IDocElementBase {
  type: 'image';
  src: DocImageSrc;
  objectFit: 'contain' | 'cover' | 'fill';
}

export interface IDocFieldElement extends IDocElementBase {
  type: 'field';
  binding: IDocFieldBinding;
}

export interface IDocLoopRegionElement extends IDocElementBase {
  type: 'loop_region';
  dataSource: DocLoopDataSource;
  /** Restrict linked_tasks loops to one relation type; null = all. */
  relationTypeId?: string | null;
  /** Additional per-region filter over the looped items. */
  filter?: IFilterRuleGroup | null;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  maxItems?: number | null;
  /**
   * Bindable field keys (bare system key, or `cf_`-prefixed custom field key)
   * checked, in order, to drive Pass/Fail row styling for each row in this
   * region — the first configured field whose resolved value classifies as
   * Pass/Fail wins. Empty/unset = scan every bindable field (system +
   * active custom fields) for this region's source entity, in the same
   * order as the field-selection catalog.
   */
  passFailFieldKeys?: string[];
  /** Vertical gap between repeated item bands, px. */
  itemSpacing: number;
  /** Designed height of ONE item band, px (the region grows by this per item). */
  itemHeight: number;
  /** dataSource: 'dynamic_query' only — see DocLoopDataSource's doc. */
  targetEntity?: DocumentSourceEntity;
  filterField?: string;
  comparisonField?: string;
}

/**
 * Non-visual at export time: mutates a named runtime variable when
 * `condition` is true (reusing the same show/hide evaluator every other
 * element already uses — here "show" means "execute"). `value` is resolved
 * through the same {{token}} interpolation as text/field elements, including
 * {{var.x}} reads of another variable's current value. The designer shows it
 * as a small canvas badge for selection/editing; it never appears in the
 * rendered HTML/PDF/DOCX output regardless of its stored geometry.
 */
export interface IDocVariableSetElement extends IDocElementBase {
  type: 'variable_set';
  op: DocVariableSetOp;
  varName: string;
  value: string;
}

export type IDocElement =
  | IDocLineElement
  | IDocRectangleElement
  | IDocEllipseElement
  | IDocTextElement
  | IDocLinkElement
  | IDocImageElement
  | IDocFieldElement
  | IDocLoopRegionElement
  | IDocVariableSetElement;

export interface IDocumentPageSettings {
  size: DocumentPaperSize;
  orientation: DocumentPaperOrientation;
  /**
   * px. DESIGNER GUIDES ONLY — element coordinates are page-origin (relative
   * to the physical page corner, exactly as drawn on the canvas) and margins
   * never shift render output in any export format.
   */
  margins: { top: number; right: number; bottom: number; left: number };
  /**
   * repeat_per_item mode: every item starts a fresh page, and items 2..n are
   * pushed down by this many px — the clearance kept after each forced page
   * break. Identical semantics in HTML/PDF and DOCX. No effect in
   * fixed_document mode.
   */
  pageBreakMargin: number;
}

/** One authored page (fixed_document multi-page support). Order = page order. */
export interface IDocumentPage {
  id: string;
  name?: string;
}

export interface IDocumentTemplateDefinition {
  schemaVersion: 1;
  mode: DocumentTemplateMode;
  sourceEntity: DocumentSourceEntity;
  page: IDocumentPageSettings;
  /**
   * Authored pages in order (fixed_document mode only; repeat_per_item
   * ignores it). Page membership of elements is GEOMETRIC: page k covers
   * y ∈ [k*pageHeight, (k+1)*pageHeight) with the ONE global page size.
   * Absent = legacy free-flow pagination.
   */
  pages?: IDocumentPage[];
  /** Stamp "Page N of M" footers. Only meaningful with authored `pages`. */
  showPageNumbers?: boolean;
  /** Flat list; parentId links loop-region children; explicit zIndex ordering. */
  elements: IDocElement[];
  /**
   * Optional per-template cap on the number of items an export resolves.
   * Only ever LOWERS the effective limit below the org's configured default
   * (DocumentDataResolverService.getDefaultMaxItems) — never raises it; see
   * document-exports.service.ts's renderAndStore for the Math.min enforcement.
   */
  maxExportItems?: number | null;
}

/** Row shape of public.document_templates as returned by the API. */
export interface IDocumentTemplate {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  source_entity: DocumentSourceEntity;
  mode: DocumentTemplateMode;
  definition: IDocumentTemplateDefinition;
  is_archived: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export type DocumentExportSource = 'manual' | 'automation';
export type DocumentExportStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

/** Row shape of public.document_exports as returned by the API. */
export interface IDocumentExport {
  id: string;
  organization_id: string;
  template_id: string | null;
  template_name: string;
  requested_by: string | null;
  source: DocumentExportSource;
  automation_run_id: string | null;
  format: DocumentExportFormat;
  status: DocumentExportStatus;
  file_path: string | null;
  file_size_bytes: number | null;
  item_count: number | null;
  error: string | null;
  filter_snapshot: Record<string, unknown>;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One bindable field offered by the designer Fields panel. */
export interface IBindableField {
  key: string;
  label: { en: string; de: string };
  source: 'system' | 'custom_field' | 'meta';
  /** Rendering hint: custom_fields.field_type for custom fields, or a
   *  system hint ('string'|'text'|'date'|'user'|'status'|'priority'|'number'|'label[]'|'key'|'html'). */
  fieldType: string;
  options?: Array<{ value: string; label: string }>;
  /** For space-scoped custom fields: which spaces define this key. */
  scope?: 'organization' | 'space';
  /** Computed at export time (e.g. a list count), not a stored column. */
  virtual?: boolean;
  /** Set on list row fields: the task list source the field belongs to. */
  listSource?: TaskListSource;
}
