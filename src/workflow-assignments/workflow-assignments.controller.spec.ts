/**
 * @fileoverview Smoke tests for WorkflowAssignmentsController.
 * @module src/workflow-assignments/workflow-assignments.controller.spec
 * @author Rajbha Manek
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { WorkflowAssignmentsController } from './workflow-assignments.controller';

const mockUser = { userId: 'user-1', organizationId: 'org-1' };
const mockAssignment = {
  id: 'asgn-1',
  organization_id: 'org-1',
  space_id: 'space-1',
  task_type_level_id: '*',
  workflow_id: 'wf-1',
  is_default: true,
  created_at: '',
  updated_at: '',
};

function createController() {
  const service = {
    getBySpace: jest.fn().mockResolvedValue([mockAssignment]),
    create: jest.fn().mockResolvedValue(mockAssignment),
    update: jest.fn().mockResolvedValue(mockAssignment),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  return {
    controller: new WorkflowAssignmentsController(service as never),
    service,
  };
}

describe('WorkflowAssignmentsController', () => {
  it('list() throws BadRequestException when spaceId is missing', async () => {
    const { controller } = createController();

    await expect(
      controller.list(mockUser as never, undefined as unknown as string),
    ).rejects.toThrow(BadRequestException);
  });

  it('list() returns data array when spaceId is provided', async () => {
    const { controller } = createController();
    const result = await controller.list(mockUser as never, 'space-1');

    expect(result.data).toHaveLength(1);
    expect(result.count).toBe(1);
  });

  it('create() calls service.create and returns success', async () => {
    const { controller, service } = createController();
    const dto = {
      space_id: 'space-1',
      task_type_level_id: '*',
      workflow_id: 'wf-1',
    };
    const result = await controller.create(mockUser as never, dto as never);

    expect(result.success).toBe(true);
    expect(service.create).toHaveBeenCalledWith('org-1', dto, 'user-1');
  });

  it('remove() throws ConflictException when tasks exist without acknowledge', async () => {
    const { controller, service } = createController();
    service.delete.mockRejectedValue(
      new ConflictException({
        message: 'Tasks exist on this assignment',
        data: {
          affected_count: 5,
          orphan_statuses: ['status-1'],
          suggested_mappings: { 'status-1': null },
        },
      }),
    );

    await expect(
      controller.remove(mockUser as never, 'asgn-1', undefined),
    ).rejects.toThrow(ConflictException);
  });
});
