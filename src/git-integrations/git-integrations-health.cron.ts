/**
 * @fileoverview Every 5 minutes: asks each provider whether it still grants access (flipping connections
 * to / from "Needs attention"), checks the organizations' own servers in both directions (ticket 11),
 * imports the open and recent pull requests of newly connected repositories (ticket 4), and prunes old
 * webhook delivery records.
 *
 * Providers run even without a built-in (env) app: an organization's own server brings its own app, and
 * each connection resolves its app itself (unresolvable ones are skipped, never flagged).
 *
 * Runs on every instance. That is safe: status changes are conditional updates in
 * GitIntegrationsService.setStatus, so only one instance notifies or audits a given change,
 * GitLab token refreshes take a lease, and each repository's import is claimed by one instance.
 * @module src/git-integrations/git-integrations-health.cron
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { GitIntegrationsService } from './git-integrations.service';
import type { GitProvider } from './git-integrations.types';
import { GitProvidersRegistry } from './git-providers.registry';
import { GitPullRequestsService } from './git-pull-requests.service';
import { GitServerTestService } from './git-server-test.service';

/** First-connection import: open pull requests plus those updated within this window. */
const BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class GitIntegrationsHealthCron {
  private readonly logger = new Logger(GitIntegrationsHealthCron.name);
  private running = false;

  constructor(
    private readonly core: GitIntegrationsService,
    private readonly providers: GitProvidersRegistry,
    private readonly pullRequests: GitPullRequestsService,
    private readonly serverTests: GitServerTestService,
  ) {}

  // Second 15 of every 5th minute, offset from the site-studio sweep at :45.
  @Cron('15 */5 * * * *')
  async run(): Promise<void> {
    // A slow provider must not let ticks stack up on this instance.
    if (this.running) return;

    this.running = true;

    try {
      for (const provider of this.providers.all()) {
        try {
          await provider.checkHealth();
        } catch (error) {
          this.logger.warn(
            `${provider.provider} health check failed: ${error instanceof Error ? error.message : error}`,
          );
        }
      }

      await this.serverTests.checkServers();
      await this.backfillPullRequests();
      await this.core.pruneDeliveries();
    } finally {
      this.running = false;
    }
  }

  /** A failed import gives the repository back, so the next tick retries it (the sync is idempotent). */
  private async backfillPullRequests(): Promise<void> {
    // Every provider: a repository on an own server needs no built-in app (ticket 11). A repository
    // whose app cannot be resolved fails its import and is given back, like any provider error.
    const providers = this.providers
      .all()
      .map((provider): GitProvider => provider.provider);

    let claimed: Awaited<ReturnType<GitPullRequestsService['claimBackfill']>>;

    try {
      claimed = await this.pullRequests.claimBackfill(providers);
    } catch (error) {
      this.logger.warn(
        `pull request import: ${error instanceof Error ? error.message : error}`,
      );
      return;
    }

    const since = new Date(Date.now() - BACKFILL_WINDOW_MS);

    for (const { connection, repository } of claimed) {
      try {
        const pullRequests = await this.providers
          .get(repository.provider)
          .listRecentPullRequests(connection, repository, since);

        for (const pr of pullRequests)
          await this.pullRequests.sync(repository, pr);

        // Ticket 5: branches named after a task that may not have a pull request yet.
        const branches = await this.providers
          .get(repository.provider)
          .listKeyBranches(connection, repository);

        for (const branch of branches)
          await this.pullRequests.syncBranch(
            repository,
            branch.name,
            branch.pushedAt,
            false,
          );
      } catch (error) {
        this.logger.warn(
          `pull request import ${repository.id}: ${error instanceof Error ? error.message : error}`,
        );
        await this.pullRequests.releaseBackfill(repository);
      }
    }
  }
}
