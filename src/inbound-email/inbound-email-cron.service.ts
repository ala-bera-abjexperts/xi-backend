// Own timer, own re-entrancy guard — mirrors AutomationCronService's separation
// of runTick from runWork. Keeping mailbox polling off the automation tick means
// a slow or unreachable mailbox degrades only inbound email, never the
// app-event automations every tenant depends on.

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { MailboxPollService } from './mailbox-poll.service';
import { isOnPremReadOnly } from '../on-prem-license/read-only-flag';

// Individual pollers have their own poll_interval_seconds (min 60s); this is
// just how often we check whether any of them are due.
const POLL_TICK_MS = 30_000;

@Injectable()
export class InboundEmailCronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboundEmailCronService.name);
  private timer?: NodeJS.Timeout;
  private isPolling = false;

  constructor(private readonly pollService: MailboxPollService) {}

  onModuleInit(): void {
    if (process.env.INBOUND_EMAIL_POLLING_DISABLED === 'true') {
      this.logger.log('Inbound email polling disabled by env flag');

      return;
    }

    this.logger.log('Starting inbound mailbox poller');
    this.timer = setInterval(() => void this.runPoll(), POLL_TICK_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runPoll(): Promise<void> {
    if (this.isPolling) return;
    // On-prem past its licence grace: read-only, so no background writes.
    if (isOnPremReadOnly()) return;
    this.isPolling = true;

    try {
      const { polled, ingested } = await this.pollService.runPollCycle();

      if (polled > 0) {
        this.logger.log(
          `mailbox poll: ${polled} mailbox(es), ${ingested} message(s) ingested`,
        );
      }
    } catch (err) {
      // Never let a throw kill the interval — the loop must survive a bad cycle.
      this.logger.error(`mailbox poll cycle failed: ${String(err)}`);
    } finally {
      this.isPolling = false;
    }
  }
}
