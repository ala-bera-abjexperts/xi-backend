import { Injectable, Logger } from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import { tmDbError } from '../test-management-errors';

export interface TestManagementSpace {
  id: string;
  key: string;
  name: string;
}

interface EnabledSpaceRow {
  spaces: {
    id: string;
    key: string;
    name: string;
    deleting_at: string | null;
  } | null;
}

/** Spaces of the caller's org where Test Management is on and the caller holds view_tests. */
@Injectable()
export class TestManagementSpacesService {
  private readonly logger = new Logger(TestManagementSpacesService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly permissions: PermissionsService,
  ) {}

  async listForUser(user: RequestUser): Promise<TestManagementSpace[]> {
    await this.access.assertTenantEnabled(user.organizationId);

    // one unpaged read plus one permission check per space; page it if a tenant
    // enables the module in hundreds of spaces.
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('space_modules')
      .select('spaces!inner(id, key, name, deleting_at)')
      .eq('module_type', 'test_management')
      .eq('is_enabled', true)
      .eq('spaces.organization_id', user.organizationId)
      .not('spaces.is_archived', 'is', true);

    if (error) throw tmDbError(this.logger, 'load spaces', error);

    const spaces = ((data ?? []) as unknown as EnabledSpaceRow[])
      .map((row) => row.spaces)
      .filter(
        (space): space is NonNullable<EnabledSpaceRow['spaces']> =>
          !!space && !space.deleting_at,
      );

    const allowed = await Promise.all(
      spaces.map(async (space) => {
        const grant = await this.permissions.resolveTestManagementPermissions(
          user.userId,
          user.organizationId,
          space.id,
        );

        // Without an own member row the space screens cannot be opened.
        return grant.hasOwnRow && grant.permissions.view_tests;
      }),
    );

    return spaces
      .filter((_, index) => allowed[index])
      .map(({ id, key, name }) => ({ id, key, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
