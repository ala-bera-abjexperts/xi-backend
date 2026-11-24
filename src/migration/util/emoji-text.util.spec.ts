import {
  decodeUnicodeEscapes,
  emojiFromId,
  resolveEmojiText,
} from './emoji-text.util';

/**
 * The fixtures below are the REAL attr shapes observed across a 350-page Confluence Cloud space —
 * including the inconsistency that makes idempotency mandatory (some emoji arrive escaped, some
 * arrive as the finished character).
 */
describe('decodeUnicodeEscapes', () => {
  it('decodes a surrogate pair into one astral character', () => {
    // The literal twelve characters Atlassian delivers for 🗓.
    expect(decodeUnicodeEscapes('\\uD83D\\uDDD3')).toBe('\u{1F5D3}');
    expect([...decodeUnicodeEscapes('\\uD83D\\uDDD3')]).toHaveLength(1);
  });

  it('decodes escapes surrounded by ordinary text', () => {
    expect(decodeUnicodeEscapes('\\uD83D\\uDC65 Teilnehmer')).toBe(
      '\u{1F465} Teilnehmer',
    );
  });

  it('leaves an already-decoded character untouched (idempotent)', () => {
    for (const value of ['✅', '⤴', '🗃️', '📝', '🎯']) {
      expect(decodeUnicodeEscapes(value)).toBe(value);
      expect(decodeUnicodeEscapes(decodeUnicodeEscapes(value))).toBe(value);
    }
  });

  it('is idempotent across repeated passes on an escaped value', () => {
    const once = decodeUnicodeEscapes('\\uD83D\\uDDD3');

    expect(decodeUnicodeEscapes(once)).toBe(once);
  });

  it('preserves a variation selector', () => {
    expect(decodeUnicodeEscapes('\\uD83D\\uDDC3\\uFE0F')).toBe('\u{1F5C3}️');
  });

  it('returns the original when decoding would leave a LONE high surrogate', () => {
    // Postgres rejects unpaired surrogates, so visible-but-storable text beats a failed write.
    expect(decodeUnicodeEscapes('\\uD83D')).toBe('\\uD83D');
    expect(decodeUnicodeEscapes('\\uD83D plain')).toBe('\\uD83D plain');
  });

  it('returns the original when decoding would leave a LONE low surrogate', () => {
    expect(decodeUnicodeEscapes('\\uDDD3')).toBe('\\uDDD3');
  });

  it('decodes BMP escapes', () => {
    expect(decodeUnicodeEscapes('\\u2705')).toBe('✅');
  });

  it('ignores malformed escapes', () => {
    expect(decodeUnicodeEscapes('\\uZZZZ')).toBe('\\uZZZZ');
    expect(decodeUnicodeEscapes('\\u12')).toBe('\\u12');
    expect(decodeUnicodeEscapes('no escapes here')).toBe('no escapes here');
    expect(decodeUnicodeEscapes('')).toBe('');
  });
});

describe('emojiFromId', () => {
  it('builds a character from a single code point', () => {
    expect(emojiFromId('1f5d3')).toBe('\u{1F5D3}');
    expect(emojiFromId('2705')).toBe('✅');
  });

  it('builds a multi-code-point (ZWJ) sequence', () => {
    expect(emojiFromId('1f468-200d-1f469-200d-1f467')).toBe(
      '\u{1F468}‍\u{1F469}‍\u{1F467}',
    );
  });

  it('rejects Atlassian custom ids rather than coercing them', () => {
    // `atlassian-plus`.split('-') must never be treated as code points.
    expect(emojiFromId('atlassian-plus')).toBeNull();
    expect(emojiFromId('atlassian-minus')).toBeNull();
    expect(emojiFromId('atlassian-warning')).toBeNull();
  });

  it('rejects absent, empty and out-of-range ids', () => {
    expect(emojiFromId(null)).toBeNull();
    expect(emojiFromId(undefined)).toBeNull();
    expect(emojiFromId('')).toBeNull();
    expect(emojiFromId('110000')).toBeNull(); // > U+10FFFF
    expect(emojiFromId('0')).toBeNull();
  });

  it('rejects surrogate halves, which fromCodePoint would throw on', () => {
    expect(emojiFromId('d83d')).toBeNull();
    expect(emojiFromId('dc65')).toBeNull();
  });
});

describe('resolveEmojiText', () => {
  it('decodes the escaped text Atlassian ships', () => {
    expect(
      resolveEmojiText({
        id: '1f5d3',
        text: '\\uD83D\\uDDD3',
        shortName: ':calendar_spiral:',
      }),
    ).toBe('\u{1F5D3}');
  });

  it('passes through text that already holds the character', () => {
    expect(
      resolveEmojiText({
        id: '2705',
        text: '✅',
        shortName: ':white_check_mark:',
      }),
    ).toBe('✅');
  });

  it('prefers text over id so a variation selector survives', () => {
    // id 1f5c3 alone would drop the U+FE0F that `text` carries.
    expect(
      resolveEmojiText({ id: '1f5c3', text: '🗃️', shortName: ':card_box:' }),
    ).toBe('\u{1F5C3}️');
  });

  it('falls back to id when text is missing or empty', () => {
    expect(resolveEmojiText({ id: '1f465', shortName: ':x:' })).toBe(
      '\u{1F465}',
    );
    expect(resolveEmojiText({ id: '1f465', text: '', shortName: ':x:' })).toBe(
      '\u{1F465}',
    );
  });

  it('falls back to shortName for Atlassian custom emoji', () => {
    expect(resolveEmojiText({ id: 'atlassian-plus', text: ':plus:' })).toBe(
      ':plus:',
    );
    expect(
      resolveEmojiText({ id: 'atlassian-warning', shortName: ':warning:' }),
    ).toBe(':warning:');
  });

  it('handles a null id (real: :memo: arrives without one)', () => {
    expect(resolveEmojiText({ id: null, text: '📝' })).toBe('📝');
  });

  it('returns empty string rather than throwing on junk input', () => {
    expect(resolveEmojiText(undefined)).toBe('');
    expect(resolveEmojiText({})).toBe('');
    expect(resolveEmojiText({ text: 42, id: 7, shortName: {} } as never)).toBe(
      '',
    );
  });
});
