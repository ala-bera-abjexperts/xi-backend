/**
 * @fileoverview Regression tests for the custom-field DTO validation gates.
 *
 * These run the REAL global `ValidationPipe` configured exactly as `main.ts`
 * configures it (`whitelist` + `transform` + `forbidNonWhitelisted`), because
 * every bug covered here only reproduces under that combination:
 *
 * - `forbidNonWhitelisted` propagates into `@ValidateNested` children, so an
 *   option key that is missing from `FieldOptionDto` is a hard 400, not a
 *   silent drop. That is how a `grid` field's `column_type` / `width` /
 *   `choices` were rejected.
 * - `UpdateCustomFieldDto` used to keep its own copy of the field-type list
 *   which was never widened for `grid` / `file` / `file_multi`, so EDITING a
 *   field of a new type 400'd even though creating it worked.
 *
 * @module src/custom-fields/dto/custom-field-dtos.spec
 */

import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { CreateCustomFieldDto } from './create-custom-field.dto';
import { UpdateCustomFieldDto } from './update-custom-field.dto';
import { FIELD_TYPES } from '../models/custom-field.model';

/** Identical to the global pipe registered in `main.ts`. */
const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

const meta = (metatype: new () => unknown): ArgumentMetadata => ({
  type: 'body',
  metatype,
});

async function run<T>(
  metatype: new () => unknown,
  payload: unknown,
): Promise<T> {
  return (await pipe.transform(payload, meta(metatype))) as T;
}

async function expectRejected(
  metatype: new () => unknown,
  payload: unknown,
): Promise<string> {
  try {
    await pipe.transform(payload, meta(metatype));
  } catch (error) {
    return JSON.stringify((error as { response?: unknown }).response ?? error);
  }

  throw new Error('expected the payload to be rejected, but it passed');
}

/** A realistic admin-authored grid column definition set. */
const GRID_OPTIONS = [
  { value: 'task_name', label: 'Task', column_type: 'text', width: 240 },
  { value: 'qty', label: 'Qty', column_type: 'number', width: 100 },
  { value: 'due', label: 'Due', column_type: 'date', width: 140 },
  {
    value: 'status',
    label: 'Status',
    column_type: 'select',
    width: 160,
    choices: [
      { value: 'open', label: 'Open' },
      { value: 'done', label: 'Done' },
    ],
  },
  { value: 'billable', label: 'Billable', column_type: 'checkbox', width: 80 },
];

describe('custom-field DTOs under the real ValidationPipe', () => {
  describe('field_type list parity (BLOCKER 1)', () => {
    it.each([...FIELD_TYPES])(
      'CreateCustomFieldDto accepts field_type "%s"',
      async (fieldType) => {
        const result = await run<CreateCustomFieldDto>(CreateCustomFieldDto, {
          name: 'Field',
          field_type: fieldType,
        });

        expect(result.field_type).toBe(fieldType);
      },
    );

    it.each([...FIELD_TYPES])(
      'UpdateCustomFieldDto accepts field_type "%s"',
      async (fieldType) => {
        const result = await run<UpdateCustomFieldDto>(UpdateCustomFieldDto, {
          field_type: fieldType,
          name: 'Field',
        });

        expect(result.field_type).toBe(fieldType);
      },
    );

    it('rejects a field type that is not in FIELD_TYPES', async () => {
      const message = await expectRejected(UpdateCustomFieldDto, {
        field_type: 'not_a_real_type',
      });

      expect(message).toContain('field_type');
    });
  });

  describe('grid column definitions in `options` (BLOCKER 2)', () => {
    it('UpdateCustomFieldDto keeps column_type / width / choices intact', async () => {
      const result = await run<UpdateCustomFieldDto>(UpdateCustomFieldDto, {
        id: 'a3b1e0b8-0000-4000-8000-000000000001',
        field_type: 'grid',
        name: 'Line items',
        options: GRID_OPTIONS,
      });

      expect(result.options).toHaveLength(GRID_OPTIONS.length);

      // The exact keys `forbidNonWhitelisted` used to reject.
      expect(result.options?.map((o) => o.column_type)).toEqual([
        'text',
        'number',
        'date',
        'select',
        'checkbox',
      ]);
      expect(result.options?.map((o) => o.width)).toEqual([
        240, 100, 140, 160, 80,
      ]);
      expect(result.options?.[3].choices).toEqual([
        { value: 'open', label: 'Open' },
        { value: 'done', label: 'Done' },
      ]);
    });

    it('CreateCustomFieldDto keeps the same grid options intact', async () => {
      const result = await run<CreateCustomFieldDto>(CreateCustomFieldDto, {
        name: 'Line items',
        field_key: 'line_items',
        field_type: 'grid',
        options: GRID_OPTIONS,
      });

      expect(result.options).toEqual(GRID_OPTIONS);
    });

    it('still rejects an unknown option key', async () => {
      const message = await expectRejected(UpdateCustomFieldDto, {
        options: [{ value: 'a', label: 'A', totally_unknown_key: 1 }],
      });

      expect(message).toContain('totally_unknown_key');
    });

    it('rejects an unsupported column_type', async () => {
      const message = await expectRejected(UpdateCustomFieldDto, {
        options: [{ value: 'a', label: 'A', column_type: 'rich_text' }],
      });

      expect(message).toContain('column_type');
    });

    it('rejects an out-of-range column width', async () => {
      const tooNarrow = await expectRejected(UpdateCustomFieldDto, {
        options: [{ value: 'a', label: 'A', width: 10 }],
      });

      expect(tooNarrow).toContain('width');

      const tooWide = await expectRejected(UpdateCustomFieldDto, {
        options: [{ value: 'a', label: 'A', width: 5000 }],
      });

      expect(tooWide).toContain('width');
    });

    it('rejects a malformed select choice', async () => {
      const message = await expectRejected(UpdateCustomFieldDto, {
        options: [
          {
            value: 'a',
            label: 'A',
            column_type: 'select',
            choices: [{ value: '' }],
          },
        ],
      });

      expect(message).toContain('choices');
    });
  });

  describe('non-grid option keys still survive', () => {
    it('keeps cascading_select parent_value / level and select color / icon', async () => {
      const result = await run<UpdateCustomFieldDto>(UpdateCustomFieldDto, {
        field_type: 'cascading_select',
        options: [
          { value: 'eu', label: 'Europe', level: 0, color: '#ff0000' },
          {
            value: 'de',
            label: 'Germany',
            level: 1,
            parent_value: 'eu',
            icon: 'bx-flag',
            isDefault: true,
          },
        ],
      });

      expect(result.options?.[0]).toMatchObject({
        value: 'eu',
        level: 0,
        color: '#ff0000',
      });
      expect(result.options?.[1]).toMatchObject({
        parent_value: 'eu',
        level: 1,
        icon: 'bx-flag',
        isDefault: true,
      });
    });
  });
});
