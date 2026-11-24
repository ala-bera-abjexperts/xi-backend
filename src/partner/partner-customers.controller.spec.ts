/**
 * @fileoverview Unit tests for PartnerCustomersController handler delegation.
 * Written manually (not via the generic contract helper) because the `get`
 * handler delegates to a service method also named `get`.
 * @module src/partner/partner-customers.controller.spec
 */

import { PartnerCustomersController } from './partner-customers.controller';
import { PartnerCustomersService } from './partner-customers.service';

const user = { organizationId: 'org-1', userId: 'user-1' } as never;

function setup() {
  const service = {
    list: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    listAllLicenses: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'cust-1' }),
    get: jest.fn().mockResolvedValue({ id: 'cust-1' }),
    update: jest.fn().mockResolvedValue({ id: 'cust-1' }),
    remove: jest.fn().mockResolvedValue({ success: true }),
    listCustomerLicenses: jest.fn().mockResolvedValue([]),
    getDetail: jest.fn().mockResolvedValue({ id: 'cust-1' }),
  } as unknown as PartnerCustomersService;

  return { service, controller: new PartnerCustomersController(service) };
}

describe('PartnerCustomersController', () => {
  it('list forwards filters scoped to the org', async () => {
    const { controller, service } = setup();

    await controller.list(user, 'active', 'Helena', 1, 20);

    expect(service.list).toHaveBeenCalledWith('org-1', {
      status: 'active',
      search: 'Helena',
      page: 1,
      pageSize: 20,
    });
  });

  it('listAllLicenses maps the active flag', async () => {
    const { controller, service } = setup();

    await controller.listAllLicenses(user, true);

    expect(service.listAllLicenses).toHaveBeenCalledWith('org-1', {
      activeOnly: true,
    });
  });

  it('create delegates org + author + body', async () => {
    const { controller, service } = setup();
    const dto = { customer_name: 'Helena Inc' } as never;

    await controller.create(user, dto);

    expect(service.create).toHaveBeenCalledWith('org-1', 'user-1', dto);
  });

  it('get returns the detail view (XE-T737) for org + customer id', async () => {
    const { controller, service } = setup();

    await controller.get(user, 'cust-1');

    expect(service.getDetail).toHaveBeenCalledWith('org-1', 'cust-1');
  });

  it('update delegates org + author + customer id + body', async () => {
    const { controller, service } = setup();
    const dto = { contact_name: 'Marlene Hoffmann' } as never;

    await controller.update(user, 'cust-1', dto);

    expect(service.update).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'cust-1',
      dto,
    );
  });

  it('remove delegates org + author + customer id', async () => {
    const { controller, service } = setup();

    await controller.remove(user, 'cust-1');

    expect(service.remove).toHaveBeenCalledWith('org-1', 'user-1', 'cust-1');
  });

  it('listCustomerLicenses delegates org + customer id', async () => {
    const { controller, service } = setup();

    await controller.listCustomerLicenses(user, 'cust-1');

    expect(service.listCustomerLicenses).toHaveBeenCalledWith(
      'org-1',
      'cust-1',
    );
  });
});
