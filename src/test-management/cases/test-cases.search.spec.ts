import { containsPattern } from './test-cases.service';

describe('containsPattern', () => {
  it('quotes plain text as a contains pattern', () => {
    expect(containsPattern('login')).toBe('"%login%"');
  });

  it('matches LIKE wildcards literally', () => {
    expect(containsPattern('50%_off')).toBe('"%50\\\\%\\\\_off%"');
  });

  it('keeps PostgREST separators inside the quoted value', () => {
    expect(containsPattern('a,b.c(d)')).toBe('"%a,b.c(d)%"');
  });

  it('escapes quotes and backslashes', () => {
    expect(containsPattern('say "hi" \\ bye')).toBe(
      '"%say \\"hi\\" \\\\\\\\ bye%"',
    );
  });
});
