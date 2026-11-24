/**
 * @fileoverview Validation tests for the MCP-facing space-safe task write DTOs.
 * The runtime contract relies on the global `ValidationPipe({ whitelist,
 * forbidNonWhitelisted })`: these tests assert the same pipe semantics so that
 * disallowed fields (status, space/org move, custom fields, parent/task-type
 * override) are rejected and that the comment length ceiling holds.
 * @module src/tasks/tasks-mine-write.dto.spec
 * @author Prince Jadiya
 */

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MineCreateTaskDto } from './dto/mine-create-task.dto';
import { MineUpdateTaskDto } from './dto/mine-update-task.dto';
import { MineAddCommentDto } from './dto/mine-add-comment.dto';

// Mirror the global ValidationPipe options so the tests exercise the same
// whitelist + forbidNonWhitelisted behaviour the controller sees at runtime.
const PIPE_OPTS = {
  whitelist: true,
  forbidNonWhitelisted: true,
} as const;

async function validateDto<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) {
  const instance = plainToInstance(cls, payload);
  return validate(instance, PIPE_OPTS);
}

describe('Mine write DTOs', () => {
  describe('MineCreateTaskDto', () => {
    it('accepts a minimal valid create body', async () => {
      const errors = await validateDto(MineCreateTaskDto, {
        spaceIdOrKey: 'SP',
        summary: 'Fix login bug',
      });
      expect(errors).toHaveLength(0);
    });

    it('requires spaceIdOrKey and summary', async () => {
      const errors = await validateDto(MineCreateTaskDto, {});
      const fields = errors.map((e) => e.property);
      expect(fields).toContain('spaceIdOrKey');
      expect(fields).toContain('summary');
    });

    it('rejects a disallowed field (status / space_id / task_type_id)', async () => {
      const errors = await validateDto(MineCreateTaskDto, {
        spaceIdOrKey: 'SP',
        summary: 'x',
        status: 'done',
        space_id: 'other-space',
        task_type_id: 'epic',
      });
      const fields = errors.map((e) => e.property);
      expect(fields).toEqual(
        expect.arrayContaining(['status', 'space_id', 'task_type_id']),
      );
    });
  });

  describe('MineUpdateTaskDto', () => {
    it('accepts a valid update body', async () => {
      const errors = await validateDto(MineUpdateTaskDto, {
        expectedVersion: 3,
        summary: 'Updated',
        dueDate: null,
      });
      expect(errors).toHaveLength(0);
    });

    it('requires expectedVersion', async () => {
      const errors = await validateDto(MineUpdateTaskDto, { summary: 'x' });
      expect(errors.map((e) => e.property)).toContain('expectedVersion');
    });

    it('rejects an attempt to move space/org or set status', async () => {
      const errors = await validateDto(MineUpdateTaskDto, {
        expectedVersion: 1,
        space_id: 'other-space',
        organizationId: 'other-org',
        status: 'closed',
      });
      const fields = errors.map((e) => e.property);
      expect(fields).toEqual(
        expect.arrayContaining(['space_id', 'organizationId', 'status']),
      );
    });
  });

  describe('MineAddCommentDto', () => {
    it('accepts in-range content', async () => {
      const errors = await validateDto(MineAddCommentDto, { content: 'hi' });
      expect(errors).toHaveLength(0);
    });

    it('rejects empty content', async () => {
      const errors = await validateDto(MineAddCommentDto, { content: '' });
      expect(errors.map((e) => e.property)).toContain('content');
    });

    // Raised from 10000 when tables were enabled for task comments: table HTML is verbose enough
    // that a routine 15-20 row table blew the old cap, so an imported table could not be edited.
    it('accepts a long table-sized comment under the 50000 cap', async () => {
      const errors = await validateDto(MineAddCommentDto, {
        content: 'a'.repeat(50000),
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects content longer than 50000 chars', async () => {
      const errors = await validateDto(MineAddCommentDto, {
        content: 'a'.repeat(50001),
      });
      expect(errors.map((e) => e.property)).toContain('content');
    });
  });
});
