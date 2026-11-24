import { runControllerContractSuite } from '../test/controller-contract.helper';
import { AuditLogsController } from './audit-logs.controller';

runControllerContractSuite({
  controller: AuditLogsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('AuditLogsController manual behavior', () => {
  const user = {
    userId: 'user-1',
    organizationId: 'org-1',
  };

  function setup() {
    const service = {
      getRecentActivity: jest.fn(),
      getAuditStatistics: jest.fn(),
      getLogs: jest.fn(),
      createLog: jest.fn(),
    };
    const controller = new AuditLogsController(service as any);
    return { controller, service };
  }

  it('clamps recent activity limits to the supported range', async () => {
    const { controller, service } = setup();

    await controller.recent(user as any, '250');
    await controller.recent(user as any, '-5');
    await controller.recent(user as any, 'not-a-number');

    expect(service.getRecentActivity).toHaveBeenNthCalledWith(1, 'org-1', 100);
    expect(service.getRecentActivity).toHaveBeenNthCalledWith(2, 'org-1', 1);
    expect(service.getRecentActivity).toHaveBeenNthCalledWith(3, 'org-1', 20);
  });

  it('creates audit logs from authenticated organization and user context', async () => {
    const { controller, service } = setup();
    const dto = { action: 'created', entity_type: 'task' };

    await expect(controller.create(user as any, dto as any)).resolves.toEqual({
      message: 'Audit log created',
    });
    expect(service.createLog).toHaveBeenCalledWith('org-1', 'user-1', dto);
  });
});
