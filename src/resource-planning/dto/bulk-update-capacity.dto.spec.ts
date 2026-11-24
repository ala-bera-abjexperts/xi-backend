/**
 * @fileoverview Validation tests for BulkUpdateCapacityDto: the id list
 * limits and the nested changes (null clears rate/currency, never weekly).
 * @module src/resource-planning/dto/bulk-update-capacity.dto.spec
 */

import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { BulkUpdateCapacityDto } from './bulk-update-capacity.dto';
import { UNSUPPORTED_CURRENCY_MESSAGE } from './capacity-period.dto';

const ID = '11111111-1111-4111-8111-111111111111';

async function check(body: Record<string, unknown>) {
  const dto = plainToInstance(BulkUpdateCapacityDto, body);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
}

const update = (changes: Record<string, unknown>) =>
  check({ action: 'update', user_ids: [ID], changes });

/** Constraint messages per property inside `changes`. */
function changeErrors(errors: ValidationError[]) {
  return Object.fromEntries(
    (errors.find((e) => e.property === 'changes')?.children ?? []).map((e) => [
      e.property,
      Object.values(e.constraints ?? {}),
    ]),
  );
}

describe('BulkUpdateCapacityDto', () => {
  it('accepts a valid update and a valid reset', async () => {
    expect(
      (
        await update({
          weekly_capacity_hours: 40,
          cost_rate: 90,
          currency: 'EUR',
        })
      ).errors,
    ).toHaveLength(0);
    expect(
      (await check({ action: 'reset', user_ids: [ID] })).errors,
    ).toHaveLength(0);
  });

  it.each([
    ['empty', []],
    ['duplicate', [ID, ID]],
    ['non-uuid', ['not-a-uuid']],
    [
      '1001',
      Array.from(
        { length: 1001 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ),
    ],
  ])('rejects %s user_ids', async (_, userIds) => {
    const { errors } = await check({ action: 'reset', user_ids: userIds });
    expect(errors.map((e) => e.property)).toEqual(['user_ids']);
  });

  it('rejects a null weekly capacity and a negative rate', async () => {
    const errors = changeErrors(
      (await update({ weekly_capacity_hours: null, cost_rate: -1 })).errors,
    );
    expect(Object.keys(errors).sort()).toEqual([
      'cost_rate',
      'weekly_capacity_hours',
    ]);
  });

  it('accepts a null rate as a clear', async () => {
    expect((await update({ cost_rate: null })).errors).toHaveLength(0);
  });

  it.each([
    ['eur', 'EUR'],
    ['', null],
  ])('normalizes currency %j to %j', async (currency, expected) => {
    const { dto, errors } = await update({ currency });
    expect(errors).toHaveLength(0);
    expect(dto.changes?.currency).toBe(expected);
  });

  it('rejects an unsupported currency', async () => {
    expect(changeErrors((await update({ currency: 'ABC' })).errors)).toEqual({
      currency: [UNSUPPORTED_CURRENCY_MESSAGE],
    });
  });

  it('rejects an unknown key inside changes', async () => {
    const errors = changeErrors(
      (await update({ weekly_capacity_hours: 40, is_active: false })).errors,
    );
    expect(Object.keys(errors)).toEqual(['is_active']);
  });
});
