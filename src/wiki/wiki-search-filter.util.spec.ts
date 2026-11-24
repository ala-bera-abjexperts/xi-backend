import { buildWikiSearchFilter } from './wiki-search-filter.util';

describe('buildWikiSearchFilter', () => {
  it('matches title AND content with a case-insensitive substring filter', () => {
    expect(buildWikiSearchFilter('restart')).toBe(
      'title.ilike.%restart%,content_text.ilike.%restart%',
    );
  });

  it('strips PostgREST or-expression delimiters so a query cannot escape the filter', () => {
    expect(buildWikiSearchFilter('a,b(c)"d\'e\\f')).toBe(
      'title.ilike.%abcdef%,content_text.ilike.%abcdef%',
    );
  });

  it('strips LIKE wildcards so a caller cannot force a full wildcard scan', () => {
    expect(buildWikiSearchFilter('%*restart%*')).toBe(
      'title.ilike.%restart%,content_text.ilike.%restart%',
    );
  });

  it('returns null when nothing searchable remains', () => {
    expect(buildWikiSearchFilter('')).toBeNull();
    expect(buildWikiSearchFilter('   ')).toBeNull();
    expect(buildWikiSearchFilter('%*,()')).toBeNull();
  });
});
