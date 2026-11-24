/**
 * @fileoverview Validation tests for the Overall Budget DTOs, run with the
 * global ValidationPipe's whitelist / forbidNonWhitelisted options.
 * @module src/resource-planning/overall-budget/dto/overall-budget.dto.spec
 */

import { type ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UNSUPPORTED_CURRENCY_MESSAGE } from '../../dto/capacity-period.dto';
import {
  CreateOverallBudgetDto,
  OVERALL_BUDGET_SOURCES,
  UpdateOverallBudgetDto,
} from './overall-budget.dto';

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

describe('CreateOverallBudgetDto', () => {
  const valid = { name: 'Capex', amount: 1000, currency: 'EUR' };

  it('accepts a full body and trims the text fields', async () => {
    const { dto, invalid } = await check(CreateOverallBudgetDto, {
      name: '  Capex 2026 ',
      amount: 1000.5,
      currency: 'EUR',
      source: ' grant ',
      financial_year: '2026/27',
      responsible_user_id: UUID,
      cost_category_id: UUID,
    });
    expect(invalid).toEqual([]);
    expect(dto).toMatchObject({ name: 'Capex 2026', source: 'grant' });
  });

  it('accepts null optional fields', async () => {
    const { invalid } = await check(CreateOverallBudgetDto, {
      ...valid,
      source: null,
      financial_year: null,
      responsible_user_id: null,
      cost_category_id: null,
    });
    expect(invalid).toEqual([]);
  });

  it.each([undefined, '', '   ', 'x'.repeat(201)])(
    'rejects name %j',
    async (name) => {
      const { invalid } = await check(CreateOverallBudgetDto, {
        ...valid,
        name,
      });
      expect(invalid).toEqual(['name']);
    },
  );

  it.each([0, -1, 1.234, '100', undefined])(
    'rejects amount %j',
    async (amount) => {
      const { invalid } = await check(CreateOverallBudgetDto, {
        ...valid,
        amount,
      });
      expect(invalid).toEqual(['amount']);
    },
  );

  it('accepts amount 250000', async () => {
    const { invalid } = await check(CreateOverallBudgetDto, {
      ...valid,
      amount: 250000,
    });
    expect(invalid).toEqual([]);
  });

  it('normalizes currency " eur " to EUR', async () => {
    const { dto, invalid } = await check(CreateOverallBudgetDto, {
      ...valid,
      currency: ' eur ',
    });
    expect(invalid).toEqual([]);
    expect(dto.currency).toBe('EUR');
  });

  it.each(['ABC', '', undefined])('rejects currency %j', async (currency) => {
    const { errors } = await check(CreateOverallBudgetDto, {
      ...valid,
      currency,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toEqual({
      isIn: UNSUPPORTED_CURRENCY_MESSAGE,
    });
  });

  it.each(['source', 'financial_year'])(
    'turns a blank %s into null',
    async (field) => {
      const { dto, invalid } = await check(CreateOverallBudgetDto, {
        ...valid,
        [field]: '  ',
      });
      expect(invalid).toEqual([]);
      expect(dto[field as keyof CreateOverallBudgetDto]).toBeNull();
    },
  );

  it.each([...OVERALL_BUDGET_SOURCES])('accepts source %s', async (source) => {
    const { invalid } = await check(CreateOverallBudgetDto, {
      ...valid,
      source,
    });
    expect(invalid).toEqual([]);
  });

  it.each(['Grant', 'GRANT', 'funding', 'x'.repeat(500), 42])(
    'rejects source %j outside the list',
    async (source) => {
      const { invalid } = await check(CreateOverallBudgetDto, {
        ...valid,
        source,
      });
      expect(invalid).toEqual(['source']);
    },
  );

  it('limits financial_year to 20 characters', async () => {
    const atMax = await check(CreateOverallBudgetDto, {
      ...valid,
      financial_year: 'x'.repeat(20),
    });
    const tooLong = await check(CreateOverallBudgetDto, {
      ...valid,
      financial_year: 'x'.repeat(21),
    });
    expect(atMax.invalid).toEqual([]);
    expect(tooLong.invalid).toEqual(['financial_year']);
  });

  it.each(['responsible_user_id', 'cost_category_id'])(
    'rejects a malformed %s',
    async (field) => {
      const { invalid } = await check(CreateOverallBudgetDto, {
        ...valid,
        [field]: 'not-a-uuid',
      });
      expect(invalid).toEqual([field]);
    },
  );

  it('rejects an unknown key', async () => {
    const { invalid } = await check(CreateOverallBudgetDto, {
      ...valid,
      space_id: UUID,
    });
    expect(invalid).toEqual(['space_id']);
  });
});

describe('UpdateOverallBudgetDto', () => {
  it('accepts a partial body', async () => {
    const { invalid } = await check(UpdateOverallBudgetDto, {
      source: 'customer',
    });
    expect(invalid).toEqual([]);
  });

  it('still validates provided fields', async () => {
    const { invalid } = await check(UpdateOverallBudgetDto, {
      amount: 0,
      currency: 'ABC',
      source: 'Grant',
    });
    expect(invalid).toEqual(['amount', 'currency', 'source']);
  });

  it('clears the source with null or a blank value', async () => {
    const asNull = await check(UpdateOverallBudgetDto, { source: null });
    const asBlank = await check(UpdateOverallBudgetDto, { source: ' ' });
    expect(asNull.invalid).toEqual([]);
    expect(asBlank.invalid).toEqual([]);
    expect(asBlank.dto.source).toBeNull();
  });

  it('lets a null name through (the service rejects it)', async () => {
    const { invalid } = await check(UpdateOverallBudgetDto, { name: null });
    expect(invalid).toEqual([]);
  });
});
