import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { TaskAttachmentsService } from './tasks-attachments.service';
import { TasksService, type Task } from './tasks.service';

type Result = { data: unknown; error: { message: string } | null };

function chain(result: Result) {
  const value: Record<string, unknown> = {};
  const self = () => value;
  for (const method of [
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'in',
    'order',
    'limit',
  ]) {
    value[method] = jest.fn(self);
  }
  value['single'] = jest.fn().mockResolvedValue(result);
  value['maybeSingle'] = jest.fn().mockResolvedValue(result);
  value['then'] = (fn: (resolved: Result) => unknown) =>
    Promise.resolve(result).then(fn);
  return value;
}

const ORG = 'org-1';
const SPACE = 'space-1';
const USER = 'user-1';
const TASK = 'task-1';
const task = {
  id: TASK,
  organization_id: ORG,
  space_id: SPACE,
  key: 'OPS-1',
  summary: 'Fix watcher delivery',
  status: 'open',
  priority: 'medium',
  assigned_to: null,
} as Task;

describe('task watcher mutation seams', () => {
  it('notifies once after comment creation and not after a failed insert', async () => {
    const watchers = { notifyTaskWatchers: jest.fn() };
    const commentWrite = chain({
      data: { id: 'comment-1', content: 'Hi' },
      error: null,
    });
    const failedWrite = chain({
      data: null,
      error: { message: 'write failed' },
    });
    const from = jest
      .fn()
      .mockReturnValueOnce(commentWrite)
      .mockReturnValueOnce(failedWrite);
    const service = new TasksService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      watchers as never,
    );
    jest.spyOn(service, 'getById').mockResolvedValue(task);
    jest
      .spyOn(service as never, 'logTaskHistory' as never)
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(service as never, 'logAudit' as never)
      .mockResolvedValue(undefined as never);
    await service.createComment(TASK, ORG, USER, 'Hi');

    expect(watchers.notifyTaskWatchers).toHaveBeenCalledTimes(1);
    expect(watchers.notifyTaskWatchers).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK, changeKind: 'comment_added' }),
    );

    await expect(
      service.createComment(TASK, ORG, USER, 'Fail'),
    ).rejects.toThrow('write failed');
    expect(watchers.notifyTaskWatchers).toHaveBeenCalledTimes(1);
  });

  it('notifies once after task attachment add and remove, never on failed add', async () => {
    const watchers = { notifyTaskWatchers: jest.fn() };
    const attachment = {
      id: 'attachment-1',
      task_id: TASK,
      organization_id: ORG,
      file_name: 'note.txt',
      file_path: 'org/tasks/file',
      file_size: 3,
      mime_type: 'text/plain',
    };
    const responses: Record<string, ReturnType<typeof chain>[]> = {
      task_attachments: [
        chain({ data: attachment, error: null }),
        chain({ data: null, error: { message: 'insert failed' } }),
        chain({ data: attachment, error: null }),
        chain({ data: null, error: null }),
      ],
      tasks: [
        chain({ data: task, error: null }),
        chain({ data: task, error: null }),
      ],
    };
    const storage = {
      from: jest.fn().mockReturnValue({
        upload: jest.fn().mockResolvedValue({ error: null }),
        remove: jest.fn().mockResolvedValue({ error: null }),
      }),
    };
    const from = jest.fn((table: string) => responses[table].shift());
    const service = new TaskAttachmentsService(
      {
        getClient: () => ({ from, storage }),
      } as unknown as SupabaseAdminService,
      undefined,
      watchers as never,
    );
    jest
      .spyOn(service as never, 'logTaskHistory' as never)
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(service as never, 'logAudit' as never)
      .mockResolvedValue(undefined as never);
    const file = {
      originalname: 'note.txt',
      mimetype: 'text/plain',
      size: 3,
      buffer: Buffer.from('abc'),
    } as Express.Multer.File;

    await service.uploadAttachment(TASK, ORG, USER, file);
    await new Promise((resolve) => setImmediate(resolve));
    expect(watchers.notifyTaskWatchers).toHaveBeenCalledTimes(1);
    expect(watchers.notifyTaskWatchers).toHaveBeenLastCalledWith(
      expect.objectContaining({ changeKind: 'attachment_added' }),
    );

    await expect(
      service.uploadAttachment(TASK, ORG, USER, file),
    ).rejects.toThrow('Failed to save attachment record');
    expect(watchers.notifyTaskWatchers).toHaveBeenCalledTimes(1);

    await service.deleteAttachment(TASK, attachment.id, ORG, USER);
    await new Promise((resolve) => setImmediate(resolve));
    expect(watchers.notifyTaskWatchers).toHaveBeenCalledTimes(2);
    expect(watchers.notifyTaskWatchers).toHaveBeenLastCalledWith(
      expect.objectContaining({ changeKind: 'attachment_removed' }),
    );
  });
});
