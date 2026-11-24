/**
 * @fileoverview Smoke tests for ResolutionsController.
 * @module src/resolutions/resolutions.controller.spec
 * @author Rajbha Manek
 */
import { ResolutionsController } from './resolutions.controller';

const mockUser = { userId: 'user-1', organizationId: 'org-1' };
const mockResolution = {
  id: 'res-1',
  organization_id: 'org-1',
  name: 'Done',
  key: 'done',
  description: null,
  sort_order: 1,
  is_default: true,
  is_active: true,
  created_at: '',
  updated_at: '',
};

function createController() {
  const service = {
    getAll: jest.fn().mockResolvedValue([mockResolution]),
    getById: jest.fn().mockResolvedValue(mockResolution),
    create: jest.fn().mockResolvedValue(mockResolution),
    update: jest.fn().mockResolvedValue(mockResolution),
    delete: jest.fn().mockResolvedValue(undefined),
    setDefault: jest
      .fn()
      .mockResolvedValue({ ...mockResolution, is_default: true }),
  };

  return { controller: new ResolutionsController(service as never), service };
}

describe('ResolutionsController', () => {
  it('list() returns data array', async () => {
    const { controller } = createController();
    const result = await controller.list(mockUser as never);

    expect(result.data).toHaveLength(1);
    expect(result.count).toBe(1);
  });

  it('setDefault() calls service.setDefault and returns success', async () => {
    const { controller, service } = createController();
    const result = await controller.setDefault(mockUser as never, 'res-1');

    expect(result.success).toBe(true);
    expect(service.setDefault).toHaveBeenCalledWith('res-1', 'org-1', 'user-1');
  });

  it('remove() propagates service errors', async () => {
    const { controller, service } = createController();
    service.delete.mockRejectedValue(new Error('Not found'));

    await expect(controller.remove(mockUser as never, 'res-1')).rejects.toThrow(
      'Not found',
    );
  });
});
