import { runControllerContractSuite } from '../test/controller-contract.helper';
import { PlansController } from './plans.controller';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePlanDto } from './dto/create-plan.dto';

runControllerContractSuite({
  controller: PlansController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('PlansController portfolio-facing endpoints', () => {
  const user = {
    userId: 'user-1',
    organizationId: 'org-1',
    role: 'admin',
    email: 'admin@example.com',
  } as unknown as import('../auth/interfaces/request-user.interface').RequestUser;

  const makeController = () => {
    const service = {
      listOrganizationPlans: jest.fn(),
      listPlans: jest.fn(),
      setRagManually: jest.fn(),
      clearManualRag: jest.fn(),
      grantPermission: jest.fn(),
      updatePermission: jest.fn(),
    };
    const aiService = {};

    return {
      controller: new PlansController(service as any, aiService as any),
      service,
    };
  };

  it('lists organization-wide plans for the portfolio picker', async () => {
    const { controller, service } = makeController();
    const response = {
      data: [{ id: 'plan-1', name: 'Client Delivery Plan' }],
      meta: { total: 1 },
    };
    service.listOrganizationPlans.mockResolvedValue(response);

    await expect(
      controller.listPlans(user, {
        organization_id: 'org-1',
        exclude_plan_ids: 'plan-2, plan-3',
        search: 'delivery',
        is_archived: false,
        page: 2,
        pageSize: 25,
      }),
    ).resolves.toBe(response);

    expect(service.listOrganizationPlans).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      {
        search: 'delivery',
        includeArchived: false,
        excludePlanIds: ['plan-2', 'plan-3'],
        page: 2,
        pageSize: 25,
      },
    );
    expect(service.listPlans).not.toHaveBeenCalled();
  });

  it('rejects organization-wide picker requests outside the current organization', () => {
    const { controller, service } = makeController();

    expect(() =>
      controller.listPlans(user, { organization_id: 'other-org' }),
    ).toThrow('organization_id mismatch');
    expect(service.listOrganizationPlans).not.toHaveBeenCalled();
  });

  it('keeps existing space-scoped plan list behavior when organization_id is absent', async () => {
    const { controller, service } = makeController();
    const response = { data: [{ id: 'plan-1', space_id: 'space-1' }] };
    service.listPlans.mockResolvedValue(response);

    await expect(
      controller.listPlans(user, {
        space_id: 'space-1',
        search: 'risk',
        plan_type: 'project',
        status: 'active',
        owner_id: 'owner-1',
        is_archived: true,
        page: 1,
        pageSize: 10,
      }),
    ).resolves.toBe(response);

    expect(service.listPlans).toHaveBeenCalledWith('org-1', 'user-1', {
      space_id: 'space-1',
      search: 'risk',
      plan_type: 'project',
      status: 'active',
      owner_id: 'owner-1',
      is_archived: true,
      page: 1,
      pageSize: 10,
    });
  });

  it('normalizes legacy spaceId query alias to the space-scoped plan list', async () => {
    const { controller, service } = makeController();
    const response = { data: [{ id: 'plan-1', space_id: 'space-1' }] };
    service.listPlans.mockResolvedValue(response);

    await expect(
      controller.listPlans(user, {
        search: 'risk',
        spaceId: 'space-1',
      }),
    ).resolves.toBe(response);

    expect(service.listPlans).toHaveBeenCalledWith('org-1', 'user-1', {
      space_id: 'space-1',
      search: 'risk',
      plan_type: undefined,
      status: undefined,
      owner_id: undefined,
      is_archived: undefined,
      page: undefined,
      pageSize: undefined,
    });
  });

  it('fails closed when space_id and legacy spaceId query values conflict', () => {
    const { controller, service } = makeController();

    expect(() =>
      controller.listPlans(user, { space_id: 'space-1', spaceId: 'space-2' }),
    ).toThrow('space_id mismatch');

    expect(service.listPlans).not.toHaveBeenCalled();
  });

  it('uses auth organization when accepting the legacy organizationId query alias', async () => {
    const { controller, service } = makeController();
    const response = { data: [{ id: 'plan-1' }], meta: { total: 1 } };
    service.listOrganizationPlans.mockResolvedValue(response);

    await expect(
      controller.listPlans(user, { organizationId: 'org-1' }),
    ).resolves.toBe(response);

    expect(service.listOrganizationPlans).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      {
        search: undefined,
        includeArchived: false,
        excludePlanIds: [],
        page: undefined,
        pageSize: undefined,
      },
    );
  });

  it('accepts legacy create-plan body aliases under strict validation', async () => {
    const dto = plainToInstance(CreatePlanDto, {
      spaceId: '53f4d965-0eff-43c1-9f4e-0cd28acbd189',
      organizationId: 'd31e8f83-2f0c-4008-9e59-fbbb53eb646d',
      name: 'Delivery Plan',
    });

    await expect(
      validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).resolves.toHaveLength(0);
  });

  it('sets manual RAG status through the service with edit context', async () => {
    const { controller, service } = makeController();
    const response = {
      id: 'plan-1',
      rag_status: 'amber',
      rag_set_manually: true,
    };
    service.setRagManually.mockResolvedValue(response);

    await expect(
      controller.setRag(user, 'plan-1', { rag_status: 'amber' } as any),
    ).resolves.toBe(response);

    expect(service.setRagManually).toHaveBeenCalledWith(
      'plan-1',
      'org-1',
      'user-1',
      'amber',
    );
  });

  it('clears manual RAG status through the service with edit context', async () => {
    const { controller, service } = makeController();
    const response = {
      id: 'plan-1',
      rag_status: 'unknown',
      rag_set_manually: false,
    };
    service.clearManualRag.mockResolvedValue(response);

    await expect(controller.clearRag(user, 'plan-1')).resolves.toBe(response);

    expect(service.clearManualRag).toHaveBeenCalledWith(
      'plan-1',
      'org-1',
      'user-1',
    );
  });

  it('wraps granted plan permissions once using the legacy data/success shape', async () => {
    const { controller, service } = makeController();
    const permission = {
      id: 'permission-1',
      user_id: 'user-2',
      permission_level: 'view',
    };
    service.grantPermission.mockResolvedValue(permission);

    await expect(
      controller.grantPermission(user, 'plan-1', {
        user_id: 'user-2',
        permission_level: 'view',
      } as any),
    ).resolves.toEqual({ data: permission, success: true });

    expect(service.grantPermission).toHaveBeenCalledWith(
      'plan-1',
      'org-1',
      {
        user_id: 'user-2',
        permission_level: 'view',
      },
      'user-1',
    );
  });

  it('wraps updated plan permissions once using the legacy data/success shape', async () => {
    const { controller, service } = makeController();
    const permission = {
      id: 'permission-1',
      user_id: 'user-2',
      permission_level: 'edit',
    };
    service.updatePermission.mockResolvedValue(permission);

    await expect(
      controller.updatePermission(user, 'plan-1', 'permission-1', {
        permission_level: 'edit',
      } as any),
    ).resolves.toEqual({ data: permission, success: true });

    expect(service.updatePermission).toHaveBeenCalledWith(
      'plan-1',
      'permission-1',
      'org-1',
      { permission_level: 'edit' },
      'user-1',
    );
  });
});
