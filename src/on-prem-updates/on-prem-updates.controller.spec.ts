import { ROLES_KEY } from '../auth/decorators/require-roles.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import { OnPremUpdatesController } from './on-prem-updates.controller';
import type { OnPremUpdatesService } from './on-prem-updates.service';

describe('OnPremUpdatesController reinstall', () => {
  const reinstall = jest.fn();
  const logAction = jest.fn();
  const controller = new OnPremUpdatesController(
    { reinstall } as unknown as OnPremUpdatesService,
    { logAction } as unknown as AuditLogsService,
  );
  const user = {
    organizationId: 'org-1',
    userId: 'user-1',
  } as RequestUser;

  beforeEach(() => {
    reinstall.mockReset();
    logAction.mockReset();
  });

  it('remains restricted to organization owners and admins', () => {
    expect(Reflect.getMetadata(ROLES_KEY, OnPremUpdatesController)).toEqual([
      'owner',
      'admin',
    ]);
  });

  it('starts and audits a reinstall request', async () => {
    reinstall.mockResolvedValue({ accepted: true });

    await expect(controller.reinstall(user)).resolves.toEqual({
      accepted: true,
    });
    expect(logAction).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'system_update',
      'reinstall',
      'update',
      { accepted: true },
    );
  });
});
