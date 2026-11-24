/**
 * @fileoverview Domain models for field groups, field-group membership, and
 * assignment permissions. Matches rows in `field_groups`, `field_group_fields`,
 * and the permission tables.
 * @module src/custom-fields/models/field-group.model
 * @author Prince Jadiya
 */

/**
 * Row contract for the `field_groups` table.
 */
export interface FieldGroup {
  id: string;
  organization_id: string;
  space_id: string | null;
  name: string;
  description: string | null;
  name_i18n: Record<string, string>;
  description_i18n: Record<string, string>;
  sort_order: number;
  is_collapsed_default: boolean;
  color: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
}

/**
 * Row contract for the `field_group_fields` join table.
 */
export interface FieldGroupField {
  id: string;
  field_group_id: string;
  custom_field_id: string;
  sort_order: number;
  is_required: boolean;
  is_hidden: boolean;
  column_span: number;
  default_value_override: unknown;
  created_at: string;
  custom_field?: {
    id: string;
    name: string;
    field_key: string;
    field_type: string;
    description: string | null;
    name_i18n: Record<string, string>;
    options: unknown[];
    validation_rules: Record<string, unknown>;
    default_value: unknown;
    space_id?: string | null;
    is_active?: boolean;
    is_deleted?: boolean;
  };
  is_enabled_in_space?: boolean;
}

/**
 * Polymorphic permission entry attached to group or field assignments.
 */
export interface AssignmentPermission {
  id?: string;
  target_type: 'user' | 'role' | 'group' | 'base_role';
  user_id?: string | null;
  role_id?: string | null;
  group_id?: string | null;
  base_role?: 'owner' | 'admin' | 'member' | 'viewer' | null;
  can_view: boolean;
  can_edit: boolean;
}
