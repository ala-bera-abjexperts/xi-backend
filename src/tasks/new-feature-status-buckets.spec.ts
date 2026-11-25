import { toLegacyStatusText } from './legacy-status.util';

describe('legacy status buckets', () => {
  it('keeps a legal key as it is', () => {
    expect(toLegacyStatusText('review', false, 'done')).toBe('review');
  });

  it.each([
    ['todo', 'open'],
    ['in_progress', 'in_progress'],
    ['done', 'done'],
    ['cancelled', 'closed'],
  ])('puts a custom status of category %s into %s', (category, bucket) => {
    expect(toLegacyStatusText('warte_auf_freigabe', false, category)).toBe(
      bucket,
    );
  });

  it('uses completion when the category is unknown or missing', () => {
    expect(toLegacyStatusText('fertig', true, null)).toBe('done');
    expect(toLegacyStatusText('neu', false, 'unknown')).toBe('open');
    expect(toLegacyStatusText('neu', undefined, null)).toBe('open');
  });
});
