import { DomainsController } from './domains.controller';
import { PERMISSIONS_KEY } from '../../auth/decorators/require-permissions.decorator';

const user = {
  userId: 'user-1',
  organizationId: 'org-1',
};

describe('DomainsController', () => {
  let service: Record<string, jest.Mock>;
  let controller: DomainsController;

  beforeEach(() => {
    service = {
      getDomains: jest.fn().mockResolvedValue([{ id: 'domain-1' }]),
      addDomain: jest.fn().mockResolvedValue({ id: 'domain-1' }),
      removeDomain: jest.fn().mockResolvedValue(undefined),
      verifyDomain: jest
        .fn()
        .mockResolvedValue({ id: 'domain-1', verified: true }),
    };
    controller = new DomainsController(service as any);
  });

  it('wraps domain lists in a data envelope', async () => {
    await expect(
      controller.getDomains(user as any, 'funnel-1'),
    ).resolves.toEqual({
      data: [{ id: 'domain-1' }],
    });
    expect(service.getDomains).toHaveBeenCalledWith('funnel-1', 'org-1');
  });

  it('adds domains with funnel and organization scope', async () => {
    const dto = { hostname: 'example.test' };

    await expect(
      controller.addDomain(user as any, 'funnel-1', dto as any),
    ).resolves.toEqual({ data: { id: 'domain-1' } });
    expect(service.addDomain).toHaveBeenCalledWith(
      'funnel-1',
      'org-1',
      'user-1',
      dto,
    );
  });

  it('returns undefined for no-content remove after delegating', async () => {
    await expect(
      controller.removeDomain(user as any, 'funnel-1', 'domain-1'),
    ).resolves.toBeUndefined();
    expect(service.removeDomain).toHaveBeenCalledWith(
      'funnel-1',
      'domain-1',
      'org-1',
      'user-1',
    );
  });

  it('requires delete permission to remove a custom domain', () => {
    const removeDomain = Object.getOwnPropertyDescriptor(
      DomainsController.prototype,
      'removeDomain',
    )?.value as unknown;
    expect(Reflect.getMetadata(PERMISSIONS_KEY, removeDomain)).toEqual({
      permissions: ['can_delete_site_studio'],
      any: false,
    });
  });

  it('wraps verified domain results in a data envelope', async () => {
    await expect(
      controller.verifyDomain(user as any, 'funnel-1', 'domain-1'),
    ).resolves.toEqual({ data: { id: 'domain-1', verified: true } });
    expect(service.verifyDomain).toHaveBeenCalledWith(
      'funnel-1',
      'domain-1',
      'org-1',
      'user-1',
    );
  });
});
