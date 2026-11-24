import { helmetOptions, isSwaggerEnabled } from './http-hardening';

describe('http-hardening', () => {
  it.each([
    [undefined, true],
    ['true', true],
    ['', true],
    ['false', false],
    ['0', false],
    [' FALSE ', false],
  ])('SWAGGER_ENABLED=%p → %p', (v, expected) => {
    expect(isSwaggerEnabled({ SWAGGER_ENABLED: v })).toBe(expected);
  });

  it.each([
    [undefined, {}],
    ['true', {}],
    ['false', { strictTransportSecurity: false }],
    ['0', { strictTransportSecurity: false }],
    [' FALSE ', { strictTransportSecurity: false }],
  ])('HSTS_ENABLED=%p → %p', (v, expected) => {
    expect(helmetOptions({ HSTS_ENABLED: v })).toEqual(expected);
  });
});
