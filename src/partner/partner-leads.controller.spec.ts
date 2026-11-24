/**
 * @fileoverview Unit tests for PartnerLeadsController handler delegation. Written
 * manually (not via the generic contract helper) because the `get` handler
 * delegates to a service method also named `get`, which the helper special-cases.
 * @module src/partner/partner-leads.controller.spec
 */

import { PartnerLeadsController } from './partner-leads.controller';
import { PartnerLeadsService } from './partner-leads.service';

const user = { organizationId: 'org-1', userId: 'user-1' } as never;

function setup() {
  const service = {
    list: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    create: jest.fn().mockResolvedValue({ id: 'lead-1' }),
    get: jest.fn().mockResolvedValue({ id: 'lead-1' }),
    update: jest.fn().mockResolvedValue({ id: 'lead-1' }),
    submit: jest.fn().mockResolvedValue({ id: 'lead-1' }),
    listComments: jest.fn().mockResolvedValue([]),
    addComment: jest.fn().mockResolvedValue({ id: 'comment-1' }),
  } as unknown as PartnerLeadsService;

  return { service, controller: new PartnerLeadsController(service) };
}

describe('PartnerLeadsController', () => {
  it('list forwards filters scoped to the org', async () => {
    const { controller, service } = setup();

    await controller.list(user, 'submitted', 'Brightwater', 1, 20);

    expect(service.list).toHaveBeenCalledWith('org-1', {
      status: 'submitted',
      search: 'Brightwater',
      page: 1,
      pageSize: 20,
    });
  });

  it('create delegates org + author + body', async () => {
    const { controller, service } = setup();
    const dto = { customer_company_name: 'Brightwater Logistics AG' } as never;

    await controller.create(user, dto);

    expect(service.create).toHaveBeenCalledWith('org-1', 'user-1', dto);
  });

  it('get delegates org + lead id', async () => {
    const { controller, service } = setup();

    await controller.get(user, 'lead-1');

    expect(service.get).toHaveBeenCalledWith('org-1', 'lead-1');
  });

  it('update delegates org + author + lead id + body', async () => {
    const { controller, service } = setup();
    const dto = { contact_name: 'Petra Vogel' } as never;

    await controller.update(user, 'lead-1', dto);

    expect(service.update).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'lead-1',
      dto,
    );
  });

  it('submit delegates org + author + lead id', async () => {
    const { controller, service } = setup();

    await controller.submit(user, 'lead-1');

    expect(service.submit).toHaveBeenCalledWith('org-1', 'user-1', 'lead-1');
  });

  it('listComments delegates org + lead id', async () => {
    const { controller, service } = setup();

    await controller.listComments(user, 'lead-1');

    expect(service.listComments).toHaveBeenCalledWith('org-1', 'lead-1');
  });

  it('addComment delegates org + author + lead id + body', async () => {
    const { controller, service } = setup();
    const dto = { body: 'Following up next week.' } as never;

    await controller.addComment(user, 'lead-1', dto);

    expect(service.addComment).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'lead-1',
      dto,
    );
  });
});
