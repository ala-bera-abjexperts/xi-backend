/**
 * @fileoverview Smoke tests for AssetObjectHistoryController.
 * @module src/assets-objects/asset-object-history.controller.spec
 */
import { AssetObjectHistoryController } from './asset-object-history.controller';

const mockUser = { userId: 'user-1', organizationId: 'org-1' };

const mockHistoryEntries = [
  {
    id: 'hist-1',
    object_id: 'obj-1',
    schema_id: 'schema-1',
    change_type: 'object_create',
    changed_by: 'user-1',
    payload: null,
    created_at: '2026-06-01T00:00:00Z',
  },
  {
    id: 'hist-2',
    object_id: 'obj-1',
    schema_id: 'schema-1',
    change_type: 'attribute_update',
    changed_by: 'user-1',
    payload: { field: 'ip_address', old: '10.0.0.1', new: '10.0.0.15' },
    created_at: '2026-06-02T00:00:00Z',
  },
];

function createController() {
  const service = {
    getHistory: jest.fn().mockResolvedValue(mockHistoryEntries),
    logChange: jest.fn().mockResolvedValue(undefined),
  };

  return {
    controller: new AssetObjectHistoryController(service as never),
    service,
  };
}

describe('AssetObjectHistoryController', () => {
  it('getHistory() returns change log', async () => {
    const { controller } = createController();
    const result = await controller.getHistory(
      'space-1',
      'obj-1',
      mockUser as never,
    );

    expect(result).toHaveLength(2);
    expect(result[0].change_type).toBe('object_create');
    expect(result[1].change_type).toBe('attribute_update');
  });

  it('getHistory() calls service with correct args', async () => {
    const { controller, service } = createController();
    await controller.getHistory('space-1', 'obj-1', mockUser as never);

    expect(service.getHistory).toHaveBeenCalledWith(
      'obj-1',
      'space-1',
      'org-1',
    );
  });

  it('getHistory() returns empty array when object has no history', async () => {
    const { controller, service } = createController();
    service.getHistory.mockResolvedValue([]);
    const result = await controller.getHistory(
      'space-1',
      'obj-new',
      mockUser as never,
    );

    expect(result).toHaveLength(0);
  });

  it('getHistory() propagates service errors', async () => {
    const { controller, service } = createController();
    service.getHistory.mockRejectedValue(new Error('Object not found'));

    await expect(
      controller.getHistory('space-1', 'obj-99', mockUser as never),
    ).rejects.toThrow('Object not found');
  });
});
