import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateResourceScheduleSavedViewDto } from './dto/create-resource-schedule-saved-view.dto';
import type { UpdateResourceScheduleSavedViewDto } from './dto/update-resource-schedule-saved-view.dto';
import {
  ResourceScheduleSavedViewRepository,
  type ResourceScheduleSavedViewRow,
} from './resource-schedule-saved-view.repository';

@Injectable()
export class ResourceScheduleSavedViewsService {
  constructor(private readonly repo: ResourceScheduleSavedViewRepository) {}

  async list(
    organizationId: string,
    userId: string,
  ): Promise<ResourceScheduleSavedViewRow[]> {
    return this.repo.findByUserAndOrg(userId, organizationId);
  }

  async create(
    organizationId: string,
    userId: string,
    dto: CreateResourceScheduleSavedViewDto,
  ): Promise<ResourceScheduleSavedViewRow> {
    // Insert as non-default first: an insert can never collide with the one-default-per-user-org
    // partial index, only a name collision on this row could fail here. Only once that succeeds do
    // we touch any OTHER row's default flag -- so a failed create (e.g. duplicate name) never
    // leaves the org with no default view.
    const created = await this.repo.create({
      organization_id: organizationId,
      user_id: userId,
      name: dto.name,
      view_state: dto.view_state,
      is_default: false,
    });

    if (dto.is_default) {
      await this.repo.unsetDefaultsForUserOrg(
        userId,
        organizationId,
        created.id,
      );
      return this.repo.update(created.id, userId, organizationId, {
        is_default: true,
      });
    }

    return created;
  }

  async update(
    organizationId: string,
    userId: string,
    id: string,
    dto: UpdateResourceScheduleSavedViewDto,
  ): Promise<ResourceScheduleSavedViewRow> {
    await this.assertOwned(organizationId, userId, id);

    // Apply name/view_state first, without touching is_default -- a rename that collides on the
    // unique-name constraint must fail before any OTHER row's default flag is cleared.
    const fieldPatch: Partial<
      Pick<ResourceScheduleSavedViewRow, 'name' | 'view_state'>
    > = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.view_state !== undefined ? { view_state: dto.view_state } : {}),
    };

    let row: ResourceScheduleSavedViewRow | null = null;
    if (Object.keys(fieldPatch).length > 0) {
      row = await this.repo.update(id, userId, organizationId, fieldPatch);
    }

    if (dto.is_default !== undefined) {
      if (dto.is_default) {
        await this.repo.unsetDefaultsForUserOrg(userId, organizationId, id);
      }
      row = await this.repo.update(id, userId, organizationId, {
        is_default: dto.is_default,
      });
    }

    return row ?? (await this.repo.findById(id, userId, organizationId))!;
  }

  async delete(
    organizationId: string,
    userId: string,
    id: string,
  ): Promise<{ success: true }> {
    await this.assertOwned(organizationId, userId, id);
    await this.repo.delete(id, userId, organizationId);
    return { success: true };
  }

  async setDefault(
    organizationId: string,
    userId: string,
    id: string,
  ): Promise<ResourceScheduleSavedViewRow> {
    await this.assertOwned(organizationId, userId, id);
    await this.repo.unsetDefaultsForUserOrg(userId, organizationId, id);
    return this.repo.update(id, userId, organizationId, { is_default: true });
  }

  // The repo-level find/update/delete calls above already filter by (id, user_id,
  // organization_id) themselves -- this is a friendly-404 pre-check, not the security
  // boundary. Do not rely on this alone: a mismatched org/user id must also make the
  // mutating repo call itself return nothing, which it does.
  private async assertOwned(
    organizationId: string,
    userId: string,
    id: string,
  ): Promise<ResourceScheduleSavedViewRow> {
    const row = await this.repo.findById(id, userId, organizationId);
    if (!row) {
      throw new NotFoundException('Saved view not found');
    }
    return row;
  }
}
