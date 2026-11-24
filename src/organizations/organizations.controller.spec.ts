import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { runControllerContractSuite } from '../test/controller-contract.helper';
import { OrganizationsController } from './organizations.controller';

runControllerContractSuite({
  controller: OrganizationsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('OrganizationsController manual behavior', () => {
  const user = {
    userId: 'user-1',
    organizationId: 'org-1',
  };

  function setup() {
    const service = {
      createOrganization: jest.fn(),
      getBranding: jest.fn(),
      upsertBranding: jest.fn(),
      uploadLogo: jest.fn(),
      deleteLogo: jest.fn(),
      getOrganizationById: jest.fn(),
      updateOrganization: jest.fn(),
    };
    const controller = new OrganizationsController(service as any);
    return { controller, service };
  }

  it('wraps organization creation in the onboarding response shape', async () => {
    const { controller, service } = setup();
    service.createOrganization.mockResolvedValue({
      id: 'org-1',
      name: 'Acme',
      slug: 'acme',
      ignored: true,
    });

    await expect(
      controller.createOrganization(user as any, { name: 'Acme' } as any),
    ).resolves.toEqual({
      message: 'Organization created successfully',
      organization: { id: 'org-1', name: 'Acme', slug: 'acme' },
    });
    expect(service.createOrganization).toHaveBeenCalledWith('user-1', {
      name: 'Acme',
    });
  });

  it('requires file and slot for logo uploads', async () => {
    const { controller, service } = setup();
    const file = { originalname: 'logo.png', mimetype: 'image/png' };

    await expect(
      controller.uploadLogo(user as any, undefined as any, 'logo_light'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.uploadLogo(user as any, file as any, ''),
    ).rejects.toThrow(BadRequestException);
    expect(service.uploadLogo).not.toHaveBeenCalled();
  });

  it('requires the slot query parameter before deleting a logo', async () => {
    const { controller, service } = setup();

    await expect(controller.deleteLogo(user as any, '')).rejects.toThrow(
      BadRequestException,
    );
    expect(service.deleteLogo).not.toHaveBeenCalled();
  });

  it('blocks organization reads and updates for a different organization id', async () => {
    const { controller, service } = setup();

    await expect(
      controller.getOrganization(user as any, 'other-org'),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      controller.updateOrganization(user as any, 'other-org', {} as any),
    ).rejects.toThrow(ForbiddenException);
    expect(service.getOrganizationById).not.toHaveBeenCalled();
    expect(service.updateOrganization).not.toHaveBeenCalled();
  });
});
