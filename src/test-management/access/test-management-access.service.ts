import { Injectable, Logger } from '@nestjs/common';

import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  moduleDisabled,
  spaceReadOnly,
  tmDbError,
} from '../test-management-errors';

@Injectable()
export class TestManagementAccessService {
  private readonly logger = new Logger(TestManagementAccessService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly orgModules: OrganizationModulesService,
  ) {}

  /**
   * 403 unless Test Management is licensed and on for the tenant and for this space of the caller's
   * org. The space lookup is filtered by org because the guard's org-admin grant does not check it.
   * Archived spaces are refused for reads too; writes also refuse a space that is being deleted
   * (the space-module check ignores deleting_at).
   */
  async assertAvailable(
    organizationId: string,
    spaceId: string,
    options: { write?: boolean } = {},
  ): Promise<void> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('spaces')
      .select('is_archived, deleting_at')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'check the space', error);

    const space = data as {
      is_archived: boolean | null;
      deleting_at: string | null;
    } | null;

    if (!space) throw moduleDisabled();
    if (space.is_archived || (options.write && space.deleting_at)) {
      throw spaceReadOnly();
    }

    const [tenantOn, spaceOn] = await Promise.all([
      this.orgModules.isEnabled(organizationId, 'test_management'),
      this.orgModules.isSpaceModuleEnabled(
        organizationId,
        spaceId,
        'test_management',
      ),
    ]);

    if (!tenantOn || !spaceOn) throw moduleDisabled();
  }

  /** Licence and tenant switch, for organization-level data such as environments. */
  async assertTenantEnabled(organizationId: string): Promise<void> {
    if (!(await this.orgModules.isEnabled(organizationId, 'test_management'))) {
      throw moduleDisabled();
    }
  }
}
