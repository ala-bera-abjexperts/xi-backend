/**
 * @fileoverview Validation tests for the Budget Split DTOs, run with the
 * global ValidationPipe's whitelist / forbidNonWhitelisted options.
 * @module src/resource-planning/budget-split/dto/budget-split.dto.spec
 */

import { type ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateBudgetSplitDto, UpdateBudgetSplitDto } from './budget-split.dto';

const UUID = '11111111-1111-4111-8111-111111111111';

async function check<T extends object>(
  cls: ClassConstructor<T>,
  body: Record<string, unknown>,
) {
  const dto = plainToInstance(cls, body);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors, invalid: errors.map((e) => e.property) };
}

describe('CreateBudgetSplitDto', () => {
  const valid = { overall_budget_id: UUID, task_id: UUID, amount: 1000 };

  it('accepts a full body and trims the note', async () => {
    const { dto, invalid } = await check(CreateBudgetSplitDto, {
      ...valid,
      amount: 12000.5,
      note: '  Phase 1 ',
    });
    expect(invalid).toEqual([]);
    expect(dto.note).toBe('Phase 1');
  });

  it('turns a blank note into null', async () => {
    const { dto, invalid } = await check(CreateBudgetSplitDto, {
      ...valid,
      note: '   ',
    });
    expect(invalid).toEqual([]);
    expect(dto.note).toBeNull();
  });

  it.each(['overall_budget_id', 'task_id'])(
    'rejects a missing or malformed %s',
    async (field) => {
      const malformed = await check(CreateBudgetSplitDto, {
        ...valid,
        [field]: 'not-a-uuid',
      });
      const missing = await check(CreateBudgetSplitDto, {
        ...valid,
        [field]: undefined,
      });
      expect(malformed.invalid).toEqual([field]);
      expect(missing.invalid).toEqual([field]);
    },
  );

  it.each([0, -1, 1.234, '100', undefined, null, Number.MAX_SAFE_INTEGER + 2])(
    'rejects amount %j',
    async (amount) => {
      const { invalid } = await check(CreateBudgetSplitDto, {
        ...valid,
        amount,
      });
      expect(invalid).toEqual(['amount']);
    },
  );

  it('limits the note to 1000 characters', async () => {
    const atMax = await check(CreateBudgetSplitDto, {
      ...valid,
      note: 'x'.repeat(1000),
    });
    const tooLong = await check(CreateBudgetSplitDto, {
      ...valid,
      note: 'x'.repeat(1001),
    });
    expect(atMax.invalid).toEqual([]);
    expect(tooLong.invalid).toEqual(['note']);
  });

  it('rejects an unknown key', async () => {
    const { invalid } = await check(CreateBudgetSplitDto, {
      ...valid,
      currency: 'EUR',
    });
    expect(invalid).toEqual(['currency']);
  });
});

describe('UpdateBudgetSplitDto', () => {
  it('accepts a partial body and a null note', async () => {
    const { invalid } = await check(UpdateBudgetSplitDto, { note: null });
    expect(invalid).toEqual([]);
  });

  it('still validates provided fields', async () => {
    const { invalid } = await check(UpdateBudgetSplitDto, {
      amount: 0,
      note: 'x'.repeat(1001),
    });
    expect(invalid).toEqual(['amount', 'note']);
  });

  it('rejects the budget and task ids', async () => {
    const { invalid } = await check(UpdateBudgetSplitDto, {
      overall_budget_id: UUID,
      task_id: UUID,
    });
    expect(invalid).toEqual(['overall_budget_id', 'task_id']);
  });

  it('lets a null amount through (the service rejects it)', async () => {
    const { invalid } = await check(UpdateBudgetSplitDto, { amount: null });
    expect(invalid).toEqual([]);
  });
});
