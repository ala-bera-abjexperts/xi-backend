import { htmlToPlainText } from './chat-html';

describe('htmlToPlainText', () => {
  it('returns empty text for empty input', () => {
    expect(htmlToPlainText(null)).toBe('');
    expect(htmlToPlainText('')).toBe('');
    expect(htmlToPlainText('<p></p>')).toBe('');
  });

  it('keeps paragraph and line breaks, drops tags', () => {
    expect(
      htmlToPlainText(
        '<p>Hello <strong>team</strong></p><p>line two<br>line three</p>',
      ),
    ).toBe('Hello team\nline two\nline three');
  });

  it('keeps mention text and decodes entities', () => {
    expect(
      htmlToPlainText(
        '<p>Hi <span data-user-mention data-user-id="u1">@Anna</span> &amp; Ben &lt;3&nbsp;!</p>',
      ),
    ).toBe('Hi @Anna & Ben <3 !');
  });

  it('collapses runs of whitespace and blank lines', () => {
    expect(htmlToPlainText('<p>a    b</p><p></p><p></p><p></p><p>c</p>')).toBe(
      'a b\n\nc',
    );
  });
});
