// Service backing GET /auth/mcp/org-context. Composes the minimal org-context
// payload the MCP org.current tool needs: { organization: { id, slug, name }, role, modules: string[] }.
// The organization always comes from the authenticated RequestUser (set by the
// S2S guard from the grant claim), never from a request argument, which prevents
// cross-tenant reads. role comes from the caller's membership; modules reuses the
// org-level OrganizationModulesService.isEnabled check (no billing/license/member
// fields). Onboarding state (organizationId === '') returns a safe empty shape.

import { Injectable } from '@nestjs/common';
import {
  ALLOWED_ORGANIZATION_MODULES,
  OrganizationModulesService,
} from '../../organization-modules/organization-modules.service';
import { OrganizationsService } from '../../organizations/organizations.service';
import type { RequestUser } from '../interfaces/request-user.interface';

/**
 * The exact, whitelisted shape returned by `GET /auth/mcp/org-context`.
 * Nothing outside these fields is ever serialized.
 */
export interface McpOrgContext {
  organization: {
    id: string;
    slug: string;
    name: string;
  };
  role: 'owner' | 'admin' | 'member' | 'viewer' | null;
  modules: string[];
}

@Injectable()
export class McpOrgContextService {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly organizationModulesService: OrganizationModulesService,
  ) {}

  // Builds the minimal org-context payload for the authenticated caller.
  async getOrgContext(user: RequestUser): Promise<McpOrgContext> {
    // Onboarding / no active org: return a safe empty shape rather than throwing,
    // so the MCP tool can surface "no organization" cleanly.
    if (!user.organizationId) {
      return {
        organization: { id: '', slug: '', name: '' },
        role: null,
        modules: [],
      };
    }

    const membership = user.memberships.find(
      (m) => m.organizationId === user.organizationId,
    );

    const role = membership?.role ?? null;
    const slug = membership?.organizationSlug ?? '';

    const organization = await this.organizationsService.getOrganizationById(
      user.organizationId,
    );

    const modules = await this.resolveEnabledModules(user.organizationId);

    // Whitelist the org fields explicitly; the underlying row carries extra
    // columns (size, default_space_id, timestamps) we don't want to leak.
    return {
      organization: {
        id: organization.id,
        slug: organization.slug || slug,
        name: organization.name,
      },
      role,
      modules,
    };
  }

  // Resolves the enabled org-level modules by checking
  // OrganizationModulesService.isEnabled for each module in the allowed catalog.
  private async resolveEnabledModules(
    organizationId: string,
  ): Promise<string[]> {
    const checks = await Promise.all(
      ALLOWED_ORGANIZATION_MODULES.map(async (moduleType) => ({
        moduleType,
        enabled: await this.organizationModulesService.isEnabled(
          organizationId,
          moduleType,
        ),
      })),
    );

    return checks.filter((c) => c.enabled).map((c) => c.moduleType);
  }
}
