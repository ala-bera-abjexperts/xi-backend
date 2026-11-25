import { toLegacyPriorityText } from './legacy-priority.util';

describe('legacy priority: scheme words', () => {
  it.each([
    ['hoechste', 'highest'],
    ['hoch', 'high'],
    ['mittel', 'medium'],
    ['niedrig', 'low'],
    ['niedrigste', 'lowest'],
    ['kritisch', 'critical'],
  ])('maps the German word %s to %s', (key, bucket) => {
    expect(toLegacyPriorityText(key, null, null)).toBe(bucket);
  });

  it.each([
    ['blocker', 'critical'],
    ['major', 'high'],
    ['minor', 'low'],
    ['trivial', 'lowest'],
  ])('maps the classic Jira word %s to %s', (key, bucket) => {
    expect(toLegacyPriorityText(key, null, null)).toBe(bucket);
  });

  it('prefers the word over its position in the ladder', () => {
    expect(toLegacyPriorityText('blocker', 0, 5)).toBe('critical');
  });
});
