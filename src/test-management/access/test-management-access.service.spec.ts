import {
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';

import type { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TestManagementAccessService } from './test-management-access.service';

const ORG = 'org-1';
const SPACE = 'space-1';

interface Resolved {
  data: unknown;
  error: { code?: string; message: string } | null;
}

type Chain = Record<string, jest.Mock>;

function buildChain(resolved: Resolved): Chain {
  const chain = {} as Chain;

  chain.select = jest.fn(() => chain);
  chain.eq = jest.fn(() => chain);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);

  return chain;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('Expected the call to fail');
}

function errorCode(error: unknown): unknown {
  return ((error as ForbiddenException).getResponse() as { code?: string })
    .code;
}

describe('TestManagementAccessService', () => {
  let service: TestManagementAccessService;
  let from: jest.Mock;
  let isEnabled: jest.Mock;
  let isSpaceModuleEnabled: jest.Mock;

  const space = (row: unknown, error: Resolved['error'] = null) => {
    const chain = buildChain({ data: row, error });

    from.mockReturnValueOnce(chain);

    return chain;
  };

  beforeEach(() => {
    from = jest.fn();
    isEnabled = jest.fn().mockResolvedValue(true);
    isSpaceModuleEnabled = jest.fn().mockResolvedValue(true);

    service = new TestManagementAccessService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {
        isEnabled,
        isSpaceModuleEnabled,
      } as unknown as OrganizationModulesService,
    );
  });

  describe('assertAvailable', () => {
    it('passes for an active space with the module on, scoped to the org', async () => {
      const chain = space({ is_archived: false, deleting_at: null });

      await expect(
        service.assertAvailable(ORG, SPACE),
      ).resolves.toBeUndefined();

      expect(from).toHaveBeenCalledWith('spaces');
      expect(chain.eq).toHaveBeenCalledWith('id', SPACE);
      expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(isEnabled).toHaveBeenCalledWith(ORG, 'test_management');
      expect(isSpaceModuleEnabled).toHaveBeenCalledWith(
        ORG,
        SPACE,
        'test_management',
      );
    });

    it('answers a missing or foreign space with MODULE_DISABLED', async () => {
      space(null);

      const error = await caught(service.assertAvailable(ORG, SPACE));

      expect(error).toBeInstanceOf(ForbiddenException);
      expect(errorCode(error)).toBe('MODULE_DISABLED');
      expect(isEnabled).not.toHaveBeenCalled();
    });

    it.each([
      ['a read', {}],
      ['a write', { write: true }],
    ])('refuses %s in an archived space', async (_label, options) => {
      space({ is_archived: true, deleting_at: null });

      const error = await caught(service.assertAvailable(ORG, SPACE, options));

      expect(errorCode(error)).toBe('SPACE_READ_ONLY');
    });

    it('allows a read but refuses a write while the space is being deleted', async () => {
      space({ is_archived: false, deleting_at: '2026-10-20T10:00:00Z' });
      await expect(
        service.assertAvailable(ORG, SPACE),
      ).resolves.toBeUndefined();

      space({ is_archived: false, deleting_at: '2026-10-20T10:00:00Z' });
      const error = await caught(
        service.assertAvailable(ORG, SPACE, { write: true }),
      );

      expect(errorCode(error)).toBe('SPACE_READ_ONLY');
    });

    it.each([
      ['the tenant module', true],
      ['the space module', false],
    ])('answers MODULE_DISABLED when %s is off', async (_label, tenantOff) => {
      space({ is_archived: false, deleting_at: null });

      if (tenantOff) isEnabled.mockResolvedValueOnce(false);
      else isSpaceModuleEnabled.mockResolvedValueOnce(false);

      const error = await caught(service.assertAvailable(ORG, SPACE));

      expect(errorCode(error)).toBe('MODULE_DISABLED');
    });

    it('turns a database error into a 500', async () => {
      space(null, { code: 'XX000', message: 'boom' });

      await expect(service.assertAvailable(ORG, SPACE)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });
  });

  describe('assertTenantEnabled', () => {
    it('passes when the tenant module is on', async () => {
      await expect(service.assertTenantEnabled(ORG)).resolves.toBeUndefined();
      expect(isEnabled).toHaveBeenCalledWith(ORG, 'test_management');
    });

    it('answers MODULE_DISABLED when the tenant module is off', async () => {
      isEnabled.mockResolvedValueOnce(false);

      const error = await caught(service.assertTenantEnabled(ORG));

      expect(errorCode(error)).toBe('MODULE_DISABLED');
    });
  });
});
