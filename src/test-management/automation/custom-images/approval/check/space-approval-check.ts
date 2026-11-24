import type { SupabaseAdminService } from '../../../../../supabase/supabase-admin.service';
import {
  APPROVAL_SETTING_COLUMNS,
  APPROVALS_TABLE,
  APPROVER_GROUP_COLUMN,
  readApprovalSettings,
  type ApprovalSettings,
  type ApprovalSettingsRow,
  type ApprovalStatus,
} from '../rules/approval-rules';
import { MISSING_SCHEMA } from '../../shared/inputs/custom-image-inputs';

type Client = ReturnType<SupabaseAdminService['getClient']>;

export type SpaceApprovalCode =
  | 'IMAGE_AWAITING_APPROVAL'
  | 'IMAGE_REJECTED_HERE';

export class SpaceApprovalReadError extends Error {}

/** The space's approval choice; null when its columns aren't there yet. */
export async function approvalSettingsIfAvailable(
  client: Client,
  organizationId: string,
  spaceId: string,
): Promise<ApprovalSettings | null> {
  const read = (columns: string) =>
    client
      .from('test_management_space_settings')
      .select(columns)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();
  const first = await read(
    `${APPROVAL_SETTING_COLUMNS}, ${APPROVER_GROUP_COLUMN}`,
  );
  // Before the approver column exists, owners approve, as before.
  const approversColumn = !(
    first.error && MISSING_SCHEMA.has(first.error.code)
  );
  const { data, error } = approversColumn
    ? first
    : await read(APPROVAL_SETTING_COLUMNS);

  if (error) {
    if (MISSING_SCHEMA.has(error.code)) return null;

    throw new SpaceApprovalReadError(error.message);
  }

  return readApprovalSettings(
    data as unknown as ApprovalSettingsRow | null,
    approversColumn,
  );
}

export async function approvalSettingsOf(
  client: Client,
  organizationId: string,
  spaceId: string,
): Promise<ApprovalSettings> {
  return (
    (await approvalSettingsIfAvailable(client, organizationId, spaceId)) ??
    readApprovalSettings(null)
  );
}

/** This space's answer for an image; null when there is none yet. */
async function spaceApprovalStatus(
  client: Client,
  organizationId: string,
  spaceId: string,
  imageId: string,
): Promise<ApprovalStatus | null> {
  const { data, error } = await client
    .from(APPROVALS_TABLE)
    .select('status')
    .eq('space_id', spaceId)
    .eq('image_id', imageId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) {
    if (MISSING_SCHEMA.has(error.code)) return null;

    throw new SpaceApprovalReadError(error.message);
  }

  return (data as { status: ApprovalStatus } | null)?.status ?? null;
}

/** Why this space doesn't let the image run yet; null when it may run. Shared by the API and the runner. */
export async function spaceApprovalBlock(
  client: Client,
  organizationId: string,
  spaceId: string,
  imageId: string,
): Promise<SpaceApprovalCode | null> {
  const settings = await approvalSettingsOf(client, organizationId, spaceId);

  if (!settings.required) return null;

  const status = await spaceApprovalStatus(
    client,
    organizationId,
    spaceId,
    imageId,
  );

  if (status === 'approved') return null;

  return status === 'rejected'
    ? 'IMAGE_REJECTED_HERE'
    : 'IMAGE_AWAITING_APPROVAL';
}

export function isMissingSchema(code: string | undefined): boolean {
  return Boolean(code && MISSING_SCHEMA.has(code));
}
