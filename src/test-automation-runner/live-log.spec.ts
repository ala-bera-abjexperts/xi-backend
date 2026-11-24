import { LIVE_LOG_BYTES, LiveLog, MarkerWatch } from './live-log';

describe('LiveLog', () => {
  it('has nothing to show before any output', () => {
    expect(new LiveLog().take([])).toBeNull();
  });

  it('shows whole lines only, and the rest once the line ends', () => {
    const live = new LiveLog();

    live.add(Buffer.from('first\nsec'));
    expect(live.take([])).toBe('first\n');

    live.add(Buffer.from('ond\n'));
    expect(live.take([])).toBe('first\nsecond\n');
  });

  it('has nothing new when no output arrived since the last time', () => {
    const live = new LiveLog();

    live.add(Buffer.from('one\n'));
    live.take([]);

    expect(live.take([])).toBeNull();
  });

  it('never shows part of a secret that is still being printed', () => {
    const live = new LiveLog();

    live.add(Buffer.from('password=Admi'));
    expect(live.take(['Admin@123'])).toBeNull();

    live.add(Buffer.from('n@123\n'));
    expect(live.take(['Admin@123'])).toBe('password=***\n');
  });

  it('hides each line of a secret that spans several lines', () => {
    const live = new LiveLog();

    live.add(Buffer.from('key-line-one\n'));

    expect(live.take(['key-line-one\nkey-line-two'])).toBe('***\n');
  });

  it('does not split a character across chunks', () => {
    const live = new LiveLog();
    const tick = Buffer.from('✓ done\n');

    live.add(tick.subarray(0, 1));
    live.add(tick.subarray(1));

    expect(live.take([])).toBe('✓ done\n');
  });

  it('keeps the end of very long output and stays within the limit', () => {
    const live = new LiveLog();

    for (let line = 0; line < 40_000; line += 1) {
      live.add(Buffer.from(`line number ${line}\n`));
    }

    const shown = live.take([]) ?? '';

    expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(LIVE_LOG_BYTES);
    expect(shown.endsWith('line number 39999\n')).toBe(true);
    expect(shown).toContain('[earlier output removed');
  });

  it('drops the first line after a cut, so a cut secret is never shown in part', () => {
    const live = new LiveLog();
    const secret = 'SECRET-VALUE';
    const filler = 'x'.repeat(LIVE_LOG_BYTES * 4 - 6);

    live.add(Buffer.from(`${secret}\n`));
    live.add(Buffer.from(`${filler}\nlast\n`));

    expect(live.take([secret])).not.toContain('VALUE');
  });
});

describe('LiveLog in a long run with action lines', () => {
  const action = (test: number, step: number) =>
    `  pw:api => locator.click started for test ${test} step ${step} ${'x'.repeat(60)} +1ms\n`;

  it('keeps the test count and every finished test, and only the newest actions', () => {
    const live = new LiveLog();

    live.add(Buffer.from('Running 50 tests using 1 worker\n'));

    for (let test = 1; test <= 50; test += 1) {
      for (let step = 1; step <= 100; step += 1) {
        live.add(Buffer.from(action(test, step)));
      }

      live.add(
        Buffer.from(`  ✓  ${test} tests/a.spec.js:2:1 › test ${test} (1s)\n`),
      );
    }

    const shown = live.take([]) ?? '';

    expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(LIVE_LOG_BYTES);
    expect(shown).toContain('Running 50 tests using 1 worker\n');
    expect(shown.match(/✓/g)).toHaveLength(50);
    expect(shown.match(/pw:api/g)).toHaveLength(200);
    expect(shown).toContain('for test 50 step 100 ');
    expect(shown).not.toContain('for test 1 step 1 ');
    expect(shown).not.toContain('[earlier output removed');
  });

  it('keeps all action lines in a short run', () => {
    const live = new LiveLog();

    for (let step = 1; step <= 200; step += 1) {
      live.add(Buffer.from(action(1, step)));
    }

    expect((live.take([]) ?? '').match(/pw:api/g)).toHaveLength(200);
  });

  it('still hides a secret in a kept action line', () => {
    const live = new LiveLog();

    live.add(Buffer.from('  pw:api   fill("Admin@123") +1ms\n'));

    expect(live.take(['Admin@123'])).toBe('  pw:api   fill("***") +1ms\n');
  });

  it('keeps a line still being written when older output is removed', () => {
    const live = new LiveLog();

    for (let step = 1; step <= 5000; step += 1) {
      live.add(Buffer.from(action(1, step)));
    }

    live.add(Buffer.from('  ✓  1 tests/a.spec'));
    live.add(Buffer.from('.js:2:1 › test (1s)\n'));

    expect(live.take([])).toContain('  ✓  1 tests/a.spec.js:2:1 › test (1s)\n');
  });

  it('leaves a line that only mentions the words alone', () => {
    const live = new LiveLog();

    for (let step = 1; step <= 300; step += 1) {
      live.add(Buffer.from(action(1, step)));
    }

    live.add(Buffer.from('my log says pw:api here\n'));

    expect(live.take([])).toContain('my log says pw:api here\n');
  });
});

describe('LiveLog with a hidden line', () => {
  it('leaves that line out', () => {
    const live = new LiveLog('MARK\n');

    live.add(Buffer.from('one\nMARK\ntwo\n'));

    expect(live.take([])).toBe('one\ntwo\n');
  });

  it('copes with invalid UTF-8', () => {
    const live = new LiveLog('MARK\n');

    live.add(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('\nMARK\n')]),
    );

    expect(live.take([])).toBe('\ufffd\ufffd\n');
  });
});

describe('MarkerWatch', () => {
  it('finds the marker in one chunk, once', () => {
    const watch = new MarkerWatch('MARK');

    expect(watch.add(Buffer.from('a\nMARK\n'))).toBe(true);
    expect(watch.add(Buffer.from('MARK\n'))).toBe(false);
  });

  it('finds a marker split across chunks', () => {
    const watch = new MarkerWatch('MARK');

    expect(watch.add(Buffer.from('M'))).toBe(false);
    expect(watch.add(Buffer.from('AR'))).toBe(false);
    expect(watch.add(Buffer.from('K'))).toBe(true);
  });

  it('keeps only a few bytes of output without a newline', () => {
    const watch = new MarkerWatch('MARK');

    watch.add(Buffer.alloc(1024 * 1024, 'x'));

    expect((watch as unknown as { tail: Buffer }).tail.length).toBe(3);
    expect(watch.add(Buffer.from('MARK'))).toBe(true);
  });

  it('survives invalid UTF-8', () => {
    const watch = new MarkerWatch('MARK');

    expect(watch.add(Buffer.from([0xff, 0xfe, 0x4d]))).toBe(false);
    expect(watch.add(Buffer.from('ARK'))).toBe(true);
  });
});
