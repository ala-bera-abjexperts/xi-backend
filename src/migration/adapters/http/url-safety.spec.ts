import { normalizeBasePath } from './url-safety';

describe('normalizeBasePath', () => {
  it('is empty for a bare origin', () => {
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('')).toBe('');
  });

  it('keeps a context path and strips trailing slashes', () => {
    expect(normalizeBasePath('/jira')).toBe('/jira');
    expect(normalizeBasePath('/jira/')).toBe('/jira');
    expect(normalizeBasePath('/statistik.at/jira///')).toBe(
      '/statistik.at/jira',
    );
  });
});
