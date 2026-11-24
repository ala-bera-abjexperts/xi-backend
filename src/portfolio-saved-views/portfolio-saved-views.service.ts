import { Injectable, NotFoundException } from '@nestjs/common';
import { PortfoliosService } from '../portfolios/portfolios.service';
import type { CreateSavedViewDto } from './dto/create-saved-view.dto';
import type { UpdateSavedViewDto } from './dto/update-saved-view.dto';
import {
  PortfolioGanttSavedViewRepository,
  type PortfolioGanttSavedViewRow,
} from './portfolio-saved-view.repository';

@Injectable()
export class PortfolioSavedViewsService {
  constructor(
    private readonly repo: PortfolioGanttSavedViewRepository,
    private readonly portfoliosService: PortfoliosService,
  ) {}

  async list(
    organizationId: string,
    userId: string,
    portfolioId: string,
  ): Promise<PortfolioGanttSavedViewRow[]> {
    await this.portfoliosService.assertPortfolioModuleEnabled(organizationId);
    // Validates portfolio belongs to org and module is enabled.
    await this.portfoliosService.getById(organizationId, portfolioId);
    return this.repo.findByUserAndPortfolio(userId, portfolioId);
  }

  async create(
    organizationId: string,
    userId: string,
    dto: CreateSavedViewDto,
  ): Promise<PortfolioGanttSavedViewRow> {
    await this.portfoliosService.assertPortfolioModuleEnabled(organizationId);
    await this.portfoliosService.getById(organizationId, dto.portfolio_id);

    if (dto.is_default) {
      await this.repo.unsetDefaultsForUserPortfolio(userId, dto.portfolio_id);
    }
    return this.repo.create({
      organization_id: organizationId,
      user_id: userId,
      portfolio_id: dto.portfolio_id,
      name: dto.name,
      view_state: dto.view_state,
      is_default: dto.is_default ?? false,
    });
  }

  async update(
    organizationId: string,
    userId: string,
    id: string,
    dto: UpdateSavedViewDto,
  ): Promise<PortfolioGanttSavedViewRow> {
    await this.portfoliosService.assertPortfolioModuleEnabled(organizationId);
    const existing = await this.assertOwned(organizationId, userId, id);

    if (dto.is_default === true && existing.portfolio_id) {
      await this.repo.unsetDefaultsForUserPortfolio(
        userId,
        existing.portfolio_id,
        id,
      );
    }

    return this.repo.update(id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.view_state !== undefined ? { view_state: dto.view_state } : {}),
      ...(dto.is_default !== undefined ? { is_default: dto.is_default } : {}),
    });
  }

  async delete(
    organizationId: string,
    userId: string,
    id: string,
  ): Promise<{ success: true }> {
    await this.portfoliosService.assertPortfolioModuleEnabled(organizationId);
    await this.assertOwned(organizationId, userId, id);
    await this.repo.delete(id);
    return { success: true };
  }

  async setDefault(
    organizationId: string,
    userId: string,
    id: string,
  ): Promise<PortfolioGanttSavedViewRow> {
    await this.portfoliosService.assertPortfolioModuleEnabled(organizationId);
    const existing = await this.assertOwned(organizationId, userId, id);
    if (!existing.portfolio_id) {
      throw new NotFoundException(
        'Saved view is not associated with a portfolio',
      );
    }
    await this.repo.unsetDefaultsForUserPortfolio(
      userId,
      existing.portfolio_id,
      id,
    );
    return this.repo.update(id, { is_default: true });
  }

  private async assertOwned(
    organizationId: string,
    userId: string,
    id: string,
  ): Promise<PortfolioGanttSavedViewRow> {
    const row = await this.repo.findById(id);
    if (!row || row.organization_id !== organizationId) {
      throw new NotFoundException('Saved view not found');
    }
    if (row.user_id !== userId) {
      // Surface as not-found to avoid leaking existence to non-owners.
      throw new NotFoundException('Saved view not found');
    }
    return row;
  }
}
