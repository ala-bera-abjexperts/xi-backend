/** Who approves a custom image in a space, and how many of them must approve. */

// Any one approver approves, or all of them must.
export const APPROVAL_RULES = ['any', 'all'] as const;

export type ApprovalRule = (typeof APPROVAL_RULES)[number];

// Who is asked: the owners, or the owners and admins; an admin's own image always goes to the owners.
export const APPROVER_GROUPS = ['owners', 'owners_admins'] as const;

export type ApproverGroup = (typeof APPROVER_GROUPS)[number];

// Read apart, so a database without it still works with owners as approvers.
export const APPROVER_GROUP_COLUMN = 'image_approval_approvers';

export const APPROVALS_TABLE = 'test_automation_user_image_approvals';

export const VOTES_TABLE = 'test_automation_user_image_approval_votes';

export const APPROVAL_SETTING_COLUMNS =
  'image_approval_required, image_approval_rule';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalSettings {
  required: boolean;
  rule: ApprovalRule;
  approvers: ApproverGroup;
  // False until the approver column exists.
  approversColumn: boolean;
}

const APPROVAL_OFF: ApprovalSettings = {
  required: false,
  rule: 'any',
  approvers: 'owners',
  approversColumn: false,
};

export interface ApprovalSettingsRow {
  image_approval_required?: boolean | null;
  image_approval_rule?: string | null;
  image_approval_approvers?: string | null;
}

export function readApprovalSettings(
  row: ApprovalSettingsRow | null | undefined,
  approversColumn = false,
): ApprovalSettings {
  if (!row) return { ...APPROVAL_OFF, approversColumn };

  return {
    required: row.image_approval_required === true,
    rule: row.image_approval_rule === 'all' ? 'all' : 'any',
    approvers:
      row.image_approval_approvers === 'owners_admins'
        ? 'owners_admins'
        : 'owners',
    approversColumn,
  };
}

// A stored "space_admin" is an admin too, as in the permissions service.
export function isSpaceAdminRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'space_admin';
}

/** Every approver has approved; with nobody left to ask it is never met. */
export function ruleMet(approvers: string[], approvedBy: Set<string>): boolean {
  if (approvers.length === 0) return false;

  return approvers.every((id) => approvedBy.has(id));
}
