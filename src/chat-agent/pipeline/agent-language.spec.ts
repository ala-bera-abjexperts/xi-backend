import { detectRequestLanguage } from './agent-language';

describe('detectRequestLanguage', () => {
  it.each([
    ['@Robert when do the pilot users get access?', 'en'],
    ['@Robert what did we agree on, and who owns the second point?', 'en'],
    ['@Robert was haben wir vereinbart?', 'de'],
    ['@Robert bis wann muss Rajbha die Übersetzungen fertig haben?', 'de'],
    ['@Robert Zusammenfassung für Müller', 'de'],
    ['@Robert Was ist offen?', 'de'],
  ])('%s → %s', (text, language) => {
    expect(detectRequestLanguage(text)).toBe(language);
  });

  it('ignores mentions and links', () => {
    expect(
      detectRequestLanguage('@Ala @Rajbha https://example.com/the/and/is'),
    ).toBeNull();
    expect(detectRequestLanguage('@Bühler what is open?')).toBe('en');
  });

  it('lets the side with more signals win a mixed request', () => {
    expect(
      detectRequestLanguage('@Robert what did we vereinbart for the launch?'),
    ).toBe('en');
    expect(
      detectRequestLanguage('@Robert was haben wir für den launch agreed?'),
    ).toBe('de');
  });

  it('says nothing when the request shows no language or both equally', () => {
    expect(detectRequestLanguage('@Robert ?')).toBeNull();
    expect(detectRequestLanguage('ok')).toBeNull();
    expect(detectRequestLanguage('')).toBeNull();
    expect(detectRequestLanguage('und the')).toBeNull();
  });
});

describe('detectRequestLanguage short requests (1.15.2)', () => {
  it.each([
    ['document this', 'en'],
    ['meeting notes pls', 'en'],
    ['fass das als Wiki-Seite zusammen', 'de'],
    ['erstelle eine FAQ Seite zum Thema Passkeys', 'de'],
  ])('%s → %s', (text, lang) => expect(detectRequestLanguage(text)).toBe(lang));
});
