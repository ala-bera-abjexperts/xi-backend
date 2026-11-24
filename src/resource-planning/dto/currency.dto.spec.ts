/**
 * @fileoverview Validation tests for Resource Planning currency inputs: every
 * currency must be one of SUPPORTED_CAPACITY_CURRENCIES, and a cost rate
 * requires one.
 * @module src/resource-planning/dto/currency.dto.spec
 * @author Prince Jadiya
 */

import { type ClassConstructor, plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { CreateBudgetEntryDto, UpdateBudgetEntryDto } from './budget-entry.dto';
import {
  CreateCapacityPeriodDto,
  CURRENCY_REQUIRED_FOR_RATE_MESSAGE,
  UNSUPPORTED_CURRENCY_MESSAGE,
  UpdateCapacityPeriodDto,
} from './capacity-period.dto';
import { UpsertCapacityDto } from './upsert-capacity.dto';

async function check<T extends object>(
  cls: ClassConstructor<T>,
  body: Record<string, unknown>,
) {
  const dto = plainToInstance(cls, body);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto: dto as T & { currency?: unknown }, errors };
}

function currencyMessages(errors: ValidationError[]): string[] {
  return errors
    .filter((e) => e.property === 'currency')
    .flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('UpsertCapacityDto currency', () => {
  const base = { weekly_capacity_hours: 40 };

  it.each(['EURO', 'ABC', '€'])('rejects %s', async (currency) => {
    const { errors } = await check(UpsertCapacityDto, {
      ...base,
      cost_rate: 50,
      currency,
    });
    expect(currencyMessages(errors)).toEqual([UNSUPPORTED_CURRENCY_MESSAGE]);
  });

  it.each([
    ['null', { currency: null }],
    ['blank', { currency: '' }],
    ['missing', {}],
  ])('rejects a rate with a %s currency', async (_, currency) => {
    const { errors } = await check(UpsertCapacityDto, {
      ...base,
      cost_rate: 50,
      ...currency,
    });
    expect(currencyMessages(errors)).toContain(
      CURRENCY_REQUIRED_FOR_RATE_MESSAGE,
    );
  });

  it.each([
    ['EUR', 'EUR'],
    [' eur ', 'EUR'],
  ])('accepts %j with a rate as %s', async (currency, expected) => {
    const { dto, errors } = await check(UpsertCapacityDto, {
      ...base,
      cost_rate: 50,
      currency,
    });
    expect(errors).toHaveLength(0);
    expect(dto.currency).toBe(expected);
  });

  it('accepts a currency without a rate', async () => {
    const { errors } = await check(UpsertCapacityDto, {
      ...base,
      currency: 'USD',
    });
    expect(errors).toHaveLength(0);
  });

  it.each(['', null])(
    'accepts %j without a rate as a cleared currency',
    async (currency) => {
      const { dto, errors } = await check(UpsertCapacityDto, {
        ...base,
        currency,
      });
      expect(errors).toHaveLength(0);
      expect(dto.currency).toBeNull();
    },
  );
});

describe('CreateCapacityPeriodDto currency', () => {
  const base = {
    user_id: '11111111-1111-4111-8111-111111111111',
    effective_from: '2026-08-01',
    weekly_capacity_hours: 40,
  };

  it('requires a currency once cost_rate is set', async () => {
    const { errors } = await check(CreateCapacityPeriodDto, {
      ...base,
      cost_rate: 50,
    });
    expect(currencyMessages(errors)).toContain(
      CURRENCY_REQUIRED_FOR_RATE_MESSAGE,
    );
  });

  it('rejects an unsupported code', async () => {
    const { errors } = await check(CreateCapacityPeriodDto, {
      ...base,
      currency: 'ABC',
    });
    expect(currencyMessages(errors)).toEqual([UNSUPPORTED_CURRENCY_MESSAGE]);
  });

  it('accepts a rate with a normalized currency', async () => {
    const { dto, errors } = await check(CreateCapacityPeriodDto, {
      ...base,
      cost_rate: 50,
      currency: ' usd ',
    });
    expect(errors).toHaveLength(0);
    expect(dto.currency).toBe('USD');
  });
});

describe('UpdateCapacityPeriodDto currency', () => {
  it.each([{ is_active: false }, { currency: null }])(
    'accepts %j',
    async (body) => {
      expect((await check(UpdateCapacityPeriodDto, body)).errors).toHaveLength(
        0,
      );
    },
  );

  it('rejects an unsupported code', async () => {
    const { errors } = await check(UpdateCapacityPeriodDto, {
      currency: 'ABC',
    });
    expect(currencyMessages(errors)).toEqual([UNSUPPORTED_CURRENCY_MESSAGE]);
  });
});

describe('budget entry currency', () => {
  const base = {
    plan_id: '11111111-1111-4111-8111-111111111111',
    entry_type: 'planned',
    name: 'Hosting',
    effective_date: '2026-08-14',
  };

  it.each(['ABC', ''])('rejects %j', async (currency) => {
    const { errors } = await check(CreateBudgetEntryDto, {
      ...base,
      currency,
    });
    expect(currencyMessages(errors)).toContain(UNSUPPORTED_CURRENCY_MESSAGE);
  });

  it('accepts " eur " as EUR', async () => {
    const { dto, errors } = await check(CreateBudgetEntryDto, {
      ...base,
      currency: ' eur ',
    });
    expect(errors).toHaveLength(0);
    expect(dto.currency).toBe('EUR');
  });

  it.each([{ aggregation: 'rollup_sum' }, { quantity: 1, unit_cost: 5 }])(
    'keeps inline update %j valid without a currency',
    async (body) => {
      expect((await check(UpdateBudgetEntryDto, body)).errors).toHaveLength(0);
    },
  );
});
