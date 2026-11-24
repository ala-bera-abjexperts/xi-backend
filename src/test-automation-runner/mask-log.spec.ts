import { capLog, lastLines, maskSecrets, maskXmlSecrets } from './mask-log';

describe('maskXmlSecrets', () => {
  it('hides a secret written as it is', () => {
    expect(maskXmlSecrets('<a>token abcd1234</a>', ['abcd1234'])).toBe(
      '<a>token ***</a>',
    );
  });

  it('hides the escaped form of a secret', () => {
    expect(
      maskXmlSecrets(`<a b="x&amp;&lt;&gt;&quot;&apos;y"/>`, [`x&<>"'y`]),
    ).toBe('<a b="***"/>');
  });

  it('changes nothing without a match', () => {
    expect(maskXmlSecrets('<a>ok</a>', ['abcd1234'])).toBe('<a>ok</a>');
  });
});

describe('maskSecrets', () => {
  const secret = 's3cret/value+1';

  it('hides a secret every time it appears', () => {
    expect(maskSecrets(`a ${secret} b ${secret}`, [secret])).toBe(
      'a *** b ***',
    );
  });

  it('hides the URL-encoded form', () => {
    const encoded = encodeURIComponent(secret);

    expect(encoded).not.toBe(secret);
    expect(maskSecrets(`url?t=${encoded}`, [secret])).toBe('url?t=***');
  });

  it('hides the base64 forms', () => {
    const value = 'a?b>c~d';
    const plain = Buffer.from(value).toString('base64');
    const urlSafe = Buffer.from(value).toString('base64url');

    expect(plain).not.toBe(urlSafe);
    expect(maskSecrets(`Basic ${plain}`, [value])).toBe('Basic ***');
    expect(maskSecrets(`t=${urlSafe}`, [value])).toBe('t=***');
  });

  it('hides several secrets, including one inside another', () => {
    expect(maskSecrets('abcdefgh and abcd', ['abcd', 'abcdefgh'])).toBe(
      '*** and ***',
    );
  });

  it('leaves very short values alone, so words stay readable', () => {
    expect(maskSecrets('a test ran', ['a', 'te', 'ran'])).toBe('a test ran');
  });

  it('treats a secret as plain text, not a pattern', () => {
    expect(maskSecrets('a.*b and axxb', ['a.*b'])).toBe('*** and axxb');
  });

  it('changes nothing without secrets', () => {
    expect(maskSecrets('log', [])).toBe('log');
  });
});

describe('capLog', () => {
  it('leaves a short log alone', () => {
    expect(capLog('short', 100)).toBe('short');
  });

  it('keeps the end of a long log and says so', () => {
    const log = Array.from({ length: 100 }, (_, index) => `line ${index}`).join(
      '\n',
    );
    const capped = capLog(log, 200);

    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(200);
    expect(capped.startsWith('[earlier output removed')).toBe(true);
    expect(capped.endsWith('line 99')).toBe(true);
    expect(capped).not.toContain('line 0\n');
  });

  it('does not leave half a character at the cut', () => {
    const capped = capLog(`${'é'.repeat(200)}\nfinal line`, 100);

    expect(capped).not.toContain('�');
    expect(capped.endsWith('final line')).toBe(true);
  });
});

describe('lastLines', () => {
  it('keeps only the last lines', () => {
    expect(lastLines('a\nb\nc\nd', 2)).toBe('c\nd');
  });

  it('keeps everything when the log is shorter', () => {
    expect(lastLines('a\nb', 200)).toBe('a\nb');
  });
});
