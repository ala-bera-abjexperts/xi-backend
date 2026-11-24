import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { CreateSpaceCategoryDto } from './dto/create-space-category.dto';
import type { UpdateSpaceCategoryDto } from './dto/update-space-category.dto';

const TABLE = 'space_categories';

function generateKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 50);
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

@Injectable()
export class SpaceCategoriesService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getCategories(
    spaceId: string,
  ): Promise<{ data: Record<string, unknown>[]; count: number }> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('space_id', spaceId)
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    return { data: rows, count: rows.length };
  }

  async getCategoryById(
    categoryId: string,
    spaceId: string,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', categoryId)
      .eq('space_id', spaceId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Category not found');
    return { data: data as Record<string, unknown>, success: true };
  }

  async createCategory(
    spaceId: string,
    organizationId: string,
    userId: string,
    dto: CreateSpaceCategoryDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const key = generateKey(dto.name);
    const slug = generateSlug(dto.name);

    await this.assertKeyAvailable(spaceId, key);
    await this.assertSlugAvailable(spaceId, slug);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        space_id: spaceId,
        organization_id: organizationId,
        name: dto.name,
        key,
        slug,
        description: dto.description ?? null,
        color: dto.color ?? '#808080',
        metadata: dto.metadata ?? {},
        created_by: userId,
        updated_by: userId,
      })
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to create category',
      );
    }

    return { data: data as Record<string, unknown>, success: true };
  }

  async updateCategory(
    categoryId: string,
    spaceId: string,
    userId: string,
    dto: UpdateSpaceCategoryDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.getCategoryById(categoryId, spaceId);

    const patch: Record<string, unknown> = {
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };

    if (dto.name !== undefined) {
      patch['name'] = dto.name;
      const newKey = generateKey(dto.name);
      const newSlug = generateSlug(dto.name);
      await this.assertKeyAvailable(spaceId, newKey, categoryId);
      await this.assertSlugAvailable(spaceId, newSlug, categoryId);
      patch['key'] = newKey;
      patch['slug'] = newSlug;
    }
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dto.color !== undefined) patch['color'] = dto.color;
    if (dto.metadata !== undefined) patch['metadata'] = dto.metadata;

    const updatableFields = Object.keys(patch).filter(
      (k) => k !== 'updated_by' && k !== 'updated_at',
    );
    if (updatableFields.length === 0) {
      throw new BadRequestException('At least one field must be provided');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', categoryId)
      .eq('space_id', spaceId)
      .select()
      .single();

    if (error || !data) {
      throw new BadRequestException(
        error?.message ?? 'Failed to update category',
      );
    }

    return { data: data as Record<string, unknown>, success: true };
  }

  async deleteCategory(
    categoryId: string,
    spaceId: string,
  ): Promise<{ success: true; message: string }> {
    await this.getCategoryById(categoryId, spaceId);

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', categoryId)
      .eq('space_id', spaceId);

    if (error) throw new BadRequestException(error.message);
    return { success: true, message: 'Category deleted successfully' };
  }

  private async assertKeyAvailable(
    spaceId: string,
    key: string,
    excludeId?: string,
  ): Promise<void> {
    let query = this.client
      .from(TABLE)
      .select('id')
      .eq('space_id', spaceId)
      .eq('key', key);
    if (excludeId) query = query.neq('id', excludeId);
    const { data } = await query.maybeSingle();
    if (data)
      throw new ConflictException(
        `A category with key "${key}" already exists in this space`,
      );
  }

  private async assertSlugAvailable(
    spaceId: string,
    slug: string,
    excludeId?: string,
  ): Promise<void> {
    let query = this.client
      .from(TABLE)
      .select('id')
      .eq('space_id', spaceId)
      .eq('slug', slug);
    if (excludeId) query = query.neq('id', excludeId);
    const { data } = await query.maybeSingle();
    if (data)
      throw new ConflictException(
        `A category with slug "${slug}" already exists in this space`,
      );
  }
}
