import { toLegacyPriorityText } from './legacy-priority.util';

describe('legacy priority: position in its own ladder', () => {
  it('maps a five-step scheme exactly onto lowest … highest', () => {
    expect(
      [0, 1, 2, 3, 4].map((ordinal) => toLegacyPriorityText('p', ordinal, 5)),
    ).toEqual(['lowest', 'low', 'medium', 'high', 'highest']);
  });

  it('keeps the order of a three-step scheme', () => {
    expect(
      [0, 1, 2].map((ordinal) => toLegacyPriorityText('sev', ordinal, 3)),
    ).toEqual(['lowest', 'medium', 'highest']);
  });

  it('never produces critical from a position', () => {
    expect(toLegacyPriorityText('p0', 9, 10)).toBe('highest');
  });

  it.each([
    ['no ladder', null, null],
    ['a one-step ladder', 0, 1],
    ['a position outside the ladder', 7, 5],
  ])('falls back to medium for %s', (_label, ordinal, total) => {
    expect(toLegacyPriorityText('custom', ordinal, total)).toBe('medium');
  });
});
