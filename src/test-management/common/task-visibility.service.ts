import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  PICKER_LOOKUP_MAX_IDS,
  TaskPickerService,
  type TaskPickerItem,
} from '../../tasks/task-picker/task-picker.service';
import { tmDbError } from '../test-management-errors';

// Half the picker cap: 200 ids plus the picker's relation select make the request URL too long.
const LOOKUP_CHUNK = PICKER_LOOKUP_MAX_IDS / 2;

/** A ticket of another space would not show its links on its own page, so it cannot be linked. */
export function otherSpaceTicket(): BadRequestException {
  return new BadRequestException({
    code: 'TICKET_OTHER_SPACE',
    message: 'Only tickets of this space can be linked.',
  });
}

/** Tickets the caller may see, keyed by id: the task picker's membership rules plus spaces not being deleted. */
@Injectable()
export class TaskVisibilityService {
  private readonly logger = new Logger(TaskVisibilityService.name);

  constructor(
    private readonly picker: TaskPickerService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  async visibleTasks(
    user: RequestUser,
    ids: string[],
  ): Promise<Map<string, TaskPickerItem>> {
    const unique = [...new Set(ids)];
    const items: TaskPickerItem[] = [];

    for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
      const found = await this.picker.lookup(
        user,
        unique.slice(i, i + LOOKUP_CHUNK),
      );

      items.push(...found.items);
    }

    const visible = new Map<string, TaskPickerItem>();

    if (items.length === 0) return visible;

    // The picker ignores deleting_at. One .in() over the spaces found; chunk it if one caller sees hundreds of spaces.
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('spaces')
      .select('id')
      .in('id', [...new Set(items.map((item) => item.spaceId))])
      .eq('organization_id', user.organizationId)
      .is('deleting_at', null);

    if (error) throw tmDbError(this.logger, 'check ticket spaces', error);

    const live = new Set(((data ?? []) as { id: string }[]).map((r) => r.id));

    for (const item of items) {
      if (live.has(item.spaceId)) visible.set(item.id, item);
    }

    return visible;
  }
}
