import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { PortfoliosModule } from '../portfolios/portfolios.module';
import { PortfolioGanttSavedViewRepository } from './portfolio-saved-view.repository';
import { PortfolioSavedViewsController } from './portfolio-saved-views.controller';
import { PortfolioSavedViewsService } from './portfolio-saved-views.service';

@Module({
  imports: [PermissionsModule, PortfoliosModule],
  controllers: [PortfolioSavedViewsController],
  providers: [PortfolioSavedViewsService, PortfolioGanttSavedViewRepository],
  exports: [PortfolioSavedViewsService],
})
export class PortfolioSavedViewsModule {}
