/**
 * @fileoverview Looks up the provider half of the integration by name, so controllers and the
 * health check can treat every provider the same way.
 * @module src/git-integrations/git-providers.registry
 */

import { BadRequestException, Injectable } from '@nestjs/common';

import { GithubIntegrationService } from './github/github-integration.service';
import { AzureDevopsIntegrationService } from './azure-devops/azure-devops-integration.service';
import { GitlabIntegrationService } from './gitlab/gitlab-integration.service';
import {
  GIT_PROVIDERS,
  type GitProvider,
  type IGitProviderAdapter,
} from './git-integrations.types';

@Injectable()
export class GitProvidersRegistry {
  constructor(
    readonly github: GithubIntegrationService,
    readonly gitlab: GitlabIntegrationService,
    readonly azureDevops: AzureDevopsIntegrationService,
  ) {}

  /** @throws {BadRequestException} for anything but a known provider name. */
  get(provider: string): IGitProviderAdapter {
    if (provider === 'github') return this.github;
    if (provider === 'gitlab') return this.gitlab;
    if (provider === 'azure_devops') return this.azureDevops;

    throw new BadRequestException(`Unknown provider "${provider}"`);
  }

  all(): IGitProviderAdapter[] {
    return GIT_PROVIDERS.map((provider) => this.get(provider));
  }

  configured(): Record<GitProvider, boolean> {
    return {
      github: this.github.isConfigured(),
      gitlab: this.gitlab.isConfigured(),
      azure_devops: this.azureDevops.isConfigured(),
    };
  }
}
