import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RUN_RESERVE_TOKENS } from '../agent.constants';
import { AgentUsageQueryDto, UpdateAgentSettingsDto } from './agent.dto';

/** The names of the properties that failed validation. */
const invalid = async (dto: new () => object, body: Record<string, unknown>) =>
  (await validate(plainToInstance(dto, body))).map((error) => error.property);

const settings = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  allowInDms: true,
  monthlyTokenCap: 2_000_000,
  userDailyTokenCap: 200_000,
  storePrompts: false,
  ...overrides,
});

describe('UpdateAgentSettingsDto', () => {
  it('accepts the whole settings object, a cap of exactly one reservation, and null for "no cap"', async () => {
    await expect(invalid(UpdateAgentSettingsDto, settings())).resolves.toEqual(
      [],
    );
    await expect(
      invalid(
        UpdateAgentSettingsDto,
        settings({
          monthlyTokenCap: RUN_RESERVE_TOKENS,
          userDailyTokenCap: RUN_RESERVE_TOKENS,
        }),
      ),
    ).resolves.toEqual([]);
    await expect(
      invalid(
        UpdateAgentSettingsDto,
        settings({ monthlyTokenCap: null, userDailyTokenCap: null }),
      ),
    ).resolves.toEqual([]);
  });

  it.each(['monthlyTokenCap', 'userDailyTokenCap'])(
    'refuses a %s below the reservation of one run, which could never start a run',
    async (cap) => {
      for (const value of [RUN_RESERVE_TOKENS - 1, 1, 0, -5]) {
        await expect(
          invalid(UpdateAgentSettingsDto, settings({ [cap]: value })),
        ).resolves.toEqual([cap]);
      }
    },
  );

  it.each([
    ['a fraction', 60_000.5],
    ['text', '2000000'],
    ['more than a number can hold exactly', 1e30],
    ['left out', undefined],
  ])('refuses a cap that is %s', async (_name, value) => {
    await expect(
      invalid(UpdateAgentSettingsDto, settings({ monthlyTokenCap: value })),
    ).resolves.toEqual(['monthlyTokenCap']);
  });

  it.each(['enabled', 'allowInDms', 'storePrompts'])(
    'needs %s as a boolean',
    async (key) => {
      await expect(
        invalid(UpdateAgentSettingsDto, settings({ [key]: undefined })),
      ).resolves.toEqual([key]);
      await expect(
        invalid(UpdateAgentSettingsDto, settings({ [key]: 'true' })),
      ).resolves.toEqual([key]);
    },
  );

  it('answers 400 through the pipe every route runs, also for a field it does not know', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const run = (body: Record<string, unknown>) =>
      pipe.transform(body, { type: 'body', metatype: UpdateAgentSettingsDto });

    await expect(run(settings())).resolves.toEqual(settings());
    await expect(run(settings({ monthlyTokenCap: 59_999 }))).rejects.toThrow(
      BadRequestException,
    );
    await expect(run(settings({ organizationId: 'org-2' }))).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('AgentUsageQueryDto', () => {
  it('accepts two calendar days', async () => {
    await expect(
      invalid(AgentUsageQueryDto, { from: '2026-10-01', to: '2026-10-31' }),
    ).resolves.toEqual([]);
  });

  it.each([
    ['a day that does not exist', '2026-02-30'],
    ['a timestamp', '2026-10-01T00:00:00Z'],
    ['another format', '01.10.2026'],
    ['nothing', undefined],
    ['a number', 20261001],
  ])('refuses %s', async (_name, value) => {
    await expect(
      invalid(AgentUsageQueryDto, { from: value, to: '2026-10-31' }),
    ).resolves.toEqual(['from']);
    await expect(
      invalid(AgentUsageQueryDto, { from: '2026-10-01', to: value }),
    ).resolves.toEqual(['to']);
  });
});
