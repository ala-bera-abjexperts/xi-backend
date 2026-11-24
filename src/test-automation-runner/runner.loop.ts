import { Logger } from '@nestjs/common';

export const POLL_MS = 5_000;

const DEFAULT_SLOTS = 2;
const MAX_SLOTS = 8;

/** How many runs one worker handles at once. Two by default; a test container takes 2 GB. */
export function readSlots(raw = process.env.TM_RUNNER_SLOTS): number {
  const slots = Number(raw);

  if (!Number.isInteger(slots) || slots < 1) return DEFAULT_SLOTS;

  return Math.min(slots, MAX_SLOTS);
}

const DEFAULT_RUNNING_PER_ORG = 1;
const MAX_RUNNING_PER_ORG = 8;

/** How many runs one organisation may have going at once. One by default, as before. */
export function readRunningPerOrg(
  raw = process.env.TM_RUNNER_RUNNING_PER_ORG,
): number {
  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) return DEFAULT_RUNNING_PER_ORG;

  return Math.min(value, MAX_RUNNING_PER_ORG);
}

interface RunTaker {
  processNext(workerId: string): Promise<boolean>;
}

/** Keeps taking waiting runs until told to stop. A run in progress is always finished first. */
export class RunnerLoop {
  private readonly logger = new Logger(RunnerLoop.name);
  private stopping = false;
  private refusing = false;
  private wakeSleepers: (() => void)[] = [];

  constructor(
    private readonly runner: RunTaker,
    private readonly workerId: string,
    private readonly slots: number,
    private readonly pollMs = POLL_MS,
    // Asked before each run, such as whether Docker answers and there is disk space for one.
    private readonly ready: () => Promise<boolean> = () =>
      Promise.resolve(true),
  ) {}

  /** Resolves once every slot has finished its run and stopped. */
  async run(): Promise<void> {
    await Promise.all(
      Array.from({ length: this.slots }, (_, slot) => this.runSlot(slot + 1)),
    );
  }

  stop(): void {
    this.stopping = true;

    for (const wake of this.wakeSleepers) wake();

    this.wakeSleepers = [];
  }

  private async runSlot(slot: number): Promise<void> {
    const id = `${this.workerId}-${slot}`;

    while (!this.stopping) {
      let tookOne = false;

      try {
        const ready = await this.ready();

        // Once per stretch, not on every poll.
        if (!ready && !this.refusing) {
          this.logger.warn(
            'Not taking runs: Docker is not answering, or not enough free disk space for the work folder',
          );
        }

        this.refusing = !ready;
        tookOne = ready && (await this.runner.processNext(id));
      } catch (error) {
        // One bad run must not end the worker; the reaper closes it when its lease runs out.
        this.logger.error(`Slot ${slot} failed`, error);
      }

      if (!tookOne && !this.stopping) await this.sleep();
    }
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.wakeSleepers = this.wakeSleepers.filter((other) => other !== wake);
        resolve();
      }, this.pollMs);

      this.wakeSleepers.push(wake);
    });
  }
}
