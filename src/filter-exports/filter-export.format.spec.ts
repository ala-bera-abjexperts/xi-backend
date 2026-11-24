import { guardFormula } from './filter-export.format';

describe('guardFormula', () => {
  it.each(['=SUM(A1)', '+cmd', '-2+3', '@team', '\tx', '\rx'])(
    'neutralises %j so a spreadsheet will not evaluate it',
    (text) => {
      expect(guardFormula(text)).toBe(`'${text}`);
    },
  );

  it.each(['-42', '+3.5', '.5', 'plain text', ''])(
    'leaves %j alone',
    (text) => {
      expect(guardFormula(text)).toBe(text);
    },
  );
});
