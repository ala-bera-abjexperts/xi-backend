import { capLog, maskSecrets } from './mask-log';

export const LIVE_LOG_BYTES = 64 * 1024;

// More than is shown, so a cut at the start never decides what the mask can find.
const RAW_BYTES = LIVE_LOG_BYTES * 4;
const NEW_LINE = 0x0a;
const ACTION_LINE = /^\s*pw:api\b/;
const ACTION_LINES_KEPT = 200;

/** Older action lines go first, so each finished test and the test count stay on screen in a long run. */
function withoutOldActions(text: string): string {
  const lines = text.split('\n');
  let actions = lines.filter((line) => ACTION_LINE.test(line)).length;

  return lines
    .filter((line) => !ACTION_LINE.test(line) || actions-- <= ACTION_LINES_KEPT)
    .join('\n');
}

/** Spots a marker in raw output. Only the last bytes are kept, so chunks can split it and no newline can grow memory. */
export class MarkerWatch {
  private readonly marker: Buffer;
  private tail = Buffer.alloc(0);
  private found = false;

  constructor(marker: string) {
    this.marker = Buffer.from(marker, 'utf8');
  }

  /** True once, for the chunk that completes the marker. */
  add(chunk: Buffer): boolean {
    if (this.found) return false;

    const data = Buffer.concat([this.tail, chunk]);

    this.found = data.includes(this.marker);
    this.tail = data.subarray(
      Math.max(data.length - this.marker.length + 1, 0),
    );

    return this.found;
  }
}

/** The end of a running test's output, ready to show while the run is going. */
export class LiveLog {
  private raw = Buffer.alloc(0);
  private cut = false;
  private changed = false;

  // A line of ours in the output, which nobody should see.
  constructor(private readonly hiddenLine?: string) {}

  add(chunk: Buffer): void {
    this.raw = Buffer.concat([this.raw, chunk]);
    this.changed = true;

    if (this.raw.length <= RAW_BYTES) return;

    // Only whole lines: the last one may still be being written.
    const end = this.raw.lastIndexOf(NEW_LINE) + 1;

    this.raw = Buffer.concat([
      Buffer.from(
        withoutOldActions(this.raw.subarray(0, end).toString('utf8')),
      ),
      this.raw.subarray(end),
    ]);

    if (this.raw.length > RAW_BYTES) {
      this.raw = this.raw.subarray(this.raw.length - RAW_BYTES);
      this.cut = true;
    }
  }

  /**
   * The text to show, or null when nothing new can be shown. Only whole lines: a line still being written
   * could hold part of a secret, which the mask would miss.
   */
  take(secrets: string[]): string | null {
    if (!this.changed) return null;

    const start = this.cut ? this.raw.indexOf(NEW_LINE) + 1 : 0;
    const end = this.raw.lastIndexOf(NEW_LINE);

    if (end < start) return null;

    this.changed = false;

    // A value over several lines can arrive in parts, so each part is hidden too.
    const parts = secrets.flatMap((secret) => [secret, ...secret.split('\n')]);

    const text = this.raw.subarray(start, end + 1).toString('utf8');

    return capLog(
      maskSecrets(
        withoutOldActions(
          this.hiddenLine ? text.split(this.hiddenLine).join('') : text,
        ),
        parts,
      ),
      LIVE_LOG_BYTES,
    );
  }
}
