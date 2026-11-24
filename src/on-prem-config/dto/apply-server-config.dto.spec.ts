import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApplyServerConfigDto } from './apply-server-config.dto';

const check = (body: Record<string, unknown>) =>
  validate(plainToInstance(ApplyServerConfigDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('ApplyServerConfigDto', () => {
  it('accepts a valid change', async () => {
    await expect(
      check({
        revision: 'a'.repeat(64),
        set: { SMTP_HOST: 'smtp.acme.com', SMTP_PASS: "it's" },
        reset: ['SMTP_USER'],
      }),
    ).resolves.toHaveLength(0);
  });

  it('accepts every catalog key (149) at once in set and reset', async () => {
    const keys = Array.from({ length: 149 }, (_, i) => `K${i}`);
    await expect(
      check({
        revision: 'r',
        set: Object.fromEntries(keys.map((k) => [k, 'v'])),
        reset: keys,
      }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    ['a lower-case set key', { set: { smtp_host: 'x' } }],
    ['a set key with a dash', { set: { 'SMTP-HOST': 'x' } }],
    ['a bad reset key', { reset: ['1SMTP'] }],
    ['a non-string value', { set: { SMTP_PORT: 25 } }],
    ['a newline', { set: { SMTP_HOST: 'a\nb' } }],
    ['a carriage return', { set: { SMTP_HOST: 'a\rb' } }],
    ['a NUL', { set: { SMTP_HOST: 'a\0b' } }],
    ['a value over 4096', { set: { SMTP_HOST: 'x'.repeat(4097) } }],
    [
      'more than 250 set keys',
      {
        set: Object.fromEntries(
          Array.from({ length: 251 }, (_, i) => [`K${i}`, 'v']),
        ),
      },
    ],
    [
      'more than 250 reset keys',
      { reset: Array.from({ length: 251 }, (_, i) => `K${i}`) },
    ],
    ['an array as set', { set: ['SMTP_HOST'] }],
    ['an unknown field', { extra: true }],
  ])('rejects %s', async (_label, patch) => {
    const errors = await check({ revision: 'r', ...patch });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing or oversized revision', async () => {
    expect((await check({})).length).toBeGreaterThan(0);
    expect((await check({ revision: 'x'.repeat(129) })).length).toBeGreaterThan(
      0,
    );
  });
});
