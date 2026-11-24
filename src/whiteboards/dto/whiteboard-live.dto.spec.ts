/**
 * @fileoverview Validation tests for TimerCommandDto: the time typed on the board's timer card
 * (`set`) needs a duration within 5 s – 8 h, `resume` may carry one, the rest never need it.
 * @module src/whiteboards/dto/whiteboard-live.dto.spec
 */

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TimerCommandDto } from './whiteboard-live.dto';

async function errors(body: Record<string, unknown>) {
  const found = await validate(plainToInstance(TimerCommandDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return found.map((e) => e.property);
}

describe('TimerCommandDto', () => {
  it.each(['start', 'set'])('%s needs a duration', async (action) => {
    expect(await errors({ action })).toEqual(['duration_ms']);
    expect(await errors({ action, duration_ms: 90_000 })).toEqual([]);
  });

  it.each([4_999, 28_800_001, 1.5])(
    'set rejects %s ms',
    async (duration_ms) => {
      expect(await errors({ action: 'set', duration_ms })).toEqual([
        'duration_ms',
      ]);
    },
  );

  it('resume works with or without an edited duration', async () => {
    expect(await errors({ action: 'resume' })).toEqual([]);
    expect(await errors({ action: 'resume', duration_ms: 120_000 })).toEqual(
      [],
    );
    expect(await errors({ action: 'resume', duration_ms: 1_000 })).toEqual([
      'duration_ms',
    ]);
  });

  it.each(['pause', 'stop', 'add_minute'])(
    '%s needs no duration',
    async (action) => {
      expect(await errors({ action })).toEqual([]);
    },
  );

  it('rejects an unknown action', async () => {
    expect(await errors({ action: 'reset' })).toEqual(['action']);
  });
});
