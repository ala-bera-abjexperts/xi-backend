import type { MailService } from '../../mail/mail.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { NormalizedUser } from '../model/normalized';
import { UserMapper } from './user.mapper';

/** users ilike lookup, then the org-membership check. */
function mapperFor(candidate: {
  id: string;
  email: string;
  auth_user_id: string | null;
}) {
  const chain = (result: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'ilike', 'eq']) q[m] = jest.fn(() => q);
    q.limit = jest.fn().mockResolvedValue(result);
    return q;
  };
  const from = jest.fn((table: string) =>
    table === 'users'
      ? chain({ data: [candidate], error: null })
      : chain({ data: [{ id: 'm-1' }], error: null }),
  );

  return new UserMapper(
    { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
    {} as MailService,
  );
}

const actor: NormalizedUser = {
  sourceType: 'jira',
  sourceId: 'jdoe',
  email: 'jdoe@example.com',
  displayName: 'J Doe',
  active: true,
};

describe('UserMapper.resolveUser email match', () => {
  it('maps to a member who can sign in', async () => {
    const mapper = mapperFor({
      id: 'u-1',
      email: 'jdoe@example.com',
      auth_user_id: 'auth-1',
    });

    await expect(
      mapper.resolveUser('org-1', 'conn-1', actor),
    ).resolves.toMatchObject({
      userId: 'u-1',
      matchMethod: 'email',
      isPlaceholder: false,
    });
  });

  it('reuses an earlier placeholder for the same email but keeps it a placeholder', async () => {
    const mapper = mapperFor({
      id: 'ph-1',
      email: 'jdoe@example.com',
      auth_user_id: null,
    });

    await expect(
      mapper.resolveUser('org-1', 'conn-1', actor),
    ).resolves.toMatchObject({
      userId: 'ph-1',
      matchMethod: 'email',
      isPlaceholder: true,
      metadata: { is_placeholder: true },
    });
  });
});
