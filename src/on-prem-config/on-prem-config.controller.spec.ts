import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../auth/decorators/require-roles.decorator';
import { IMPERSONATION_BLOCKED_KEY } from '../auth/decorators/impersonation-blocked.decorator';
import { OnPremUpdatesController } from '../on-prem-updates/on-prem-updates.controller';
import { OnPremConfigController } from './on-prem-config.controller';

describe('OnPremConfigController guards', () => {
  it.each([GUARDS_METADATA, ROLES_KEY, IMPERSONATION_BLOCKED_KEY])(
    'has the same %s metadata as /system-updates',
    (key) => {
      const ours: unknown = Reflect.getMetadata(key, OnPremConfigController);
      expect(ours).toBeDefined();
      expect(ours).toEqual(Reflect.getMetadata(key, OnPremUpdatesController));
    },
  );

  it('is restricted to owners and admins', () => {
    expect(Reflect.getMetadata(ROLES_KEY, OnPremConfigController)).toEqual([
      'owner',
      'admin',
    ]);
  });
});
