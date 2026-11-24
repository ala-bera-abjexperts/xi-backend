import { writeWorkflowTask } from './write-task';

describe('writeWorkflowTask', () => {
  it('carries the workflow fence token to the transactional writer', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: { id: 'task' }, error: null });
    await writeWorkflowTask({ taskId: 'task', organizationId: 'org', workflowToken: 'token', txn: { rpc } } as never, { assigned_to: null });
    expect(rpc).toHaveBeenCalledWith('sla_write_workflow_task', {
      p_task_id: 'task', p_token: 'token', p_patch: { assigned_to: null },
    });
  });
  it('fails a stale token rather than falling back to an unfenced write', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'Workflow token expired' } });
    await expect(writeWorkflowTask({ taskId: 'task', workflowToken: 'old', txn: { rpc } } as never, {})).rejects.toThrow('expired');
  });
});
