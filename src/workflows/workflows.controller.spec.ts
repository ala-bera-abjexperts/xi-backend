/**
 * @fileoverview Smoke tests for WorkflowsController.
 * @module src/workflows/workflows.controller.spec
 * @author Rajbha Manek
 */
import { ConflictException } from '@nestjs/common';
import { WorkflowsController } from './workflows.controller';

const mockUser = { userId: 'user-1', organizationId: 'org-1' };
const mockWorkflow = {
  id: 'wf-1',
  organization_id: 'org-1',
  space_id: null,
  name: 'Default',
  description: null,
  is_active: false,
  is_draft: false,
  parent_workflow_id: null,
  is_archived: false,
  archived_at: null,
  initial_status_id: null,
  layout: {},
  version: 1,
  lock_token: null,
  lock_user_id: null,
  lock_acquired_at: null,
  created_by: null,
  updated_by: null,
  created_at: '',
  updated_at: '',
};
const mockDetail = {
  ...mockWorkflow,
  nodes: [],
  transitions: [],
  sources: [],
  branches: [],
};

function createController() {
  const service = {
    getAll: jest.fn().mockResolvedValue([mockWorkflow]),
    getDetail: jest.fn().mockResolvedValue(mockDetail),
    create: jest.fn().mockResolvedValue(mockWorkflow),
    update: jest.fn().mockResolvedValue(mockWorkflow),
    archive: jest.fn().mockResolvedValue(undefined),
    duplicate: jest.fn().mockResolvedValue(mockDetail),
  };

  return {
    controller: new WorkflowsController(
      service as never,
      {} as never,
      {} as never,
    ),
    service,
  };
}

describe('WorkflowsController', () => {
  it('list() returns data array and count', async () => {
    const { controller } = createController();
    const result = await controller.list(mockUser as never);

    expect(result.data).toHaveLength(1);
    expect(result.count).toBe(1);
  });

  it('create() calls service.create and returns data', async () => {
    const { controller, service } = createController();
    const dto = { name: 'Default' };
    const result = await controller.create(mockUser as never, dto as never);

    expect(result.success).toBe(true);
    expect(service.create).toHaveBeenCalledWith('org-1', dto, 'user-1');
  });

  it('remove() throws ConflictException when workflow is active', async () => {
    const { controller, service } = createController();
    service.archive.mockRejectedValue(
      new ConflictException('Cannot archive an active workflow'),
    );

    await expect(controller.remove(mockUser as never, 'wf-1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('getById() delegates to service.getDetail', async () => {
    const { controller, service } = createController();
    const result = await controller.getById(mockUser as never, 'wf-1');

    expect(result.data).toEqual(mockDetail);
    expect(service.getDetail).toHaveBeenCalledWith('wf-1', 'org-1');
  });
});
