import { cleanDescription } from './calendar-description';

describe('cleanDescription', () => {
  it('keeps nothing as nothing', () => {
    expect(cleanDescription(null)).toBeNull();
    expect(cleanDescription(undefined)).toBeNull();
  });

  it('strips a script out of rich text', () => {
    const cleaned = cleanDescription('<p>Agenda</p><script>alert(1)</script>');

    expect(cleaned).toContain('<p>Agenda</p>');
    expect(cleaned).not.toContain('script');
  });

  it('strips an inline handler but keeps the image', () => {
    const cleaned = cleanDescription(
      '<p><img src="/x.png" onerror="alert(1)"></p>',
    );

    expect(cleaned).toContain('<img');
    expect(cleaned).not.toContain('onerror');
  });

  it('keeps ordinary formatting, lists and links', () => {
    const html =
      '<p><strong>Bold</strong> <em>soft</em></p><ul><li>one</li></ul><p><a href="https://example.test">link</a></p>';
    const cleaned = cleanDescription(html) ?? '';

    expect(cleaned).toContain('<strong>Bold</strong>');
    expect(cleaned).toContain('<li>one</li>');
    expect(cleaned).toContain('href="https://example.test"');
  });

  it('leaves plain text exactly as typed', () => {
    expect(cleanDescription('Tom & Jerry\nRoom <4>')).toBe(
      'Tom & Jerry\nRoom <4>',
    );
  });
});
