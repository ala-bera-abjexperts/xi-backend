import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { PlansModule } from '../plans/plans.module';
import { TasksModule } from '../tasks/tasks.module';
import { PortfolioManagementLetterRepository } from './portfolio-management-letter.repository';
import { PortfolioPlanRepository } from './portfolio-plan.repository';
import { PortfolioRepository } from './portfolio.repository';
import { PortfoliosController } from './portfolios.controller';
import { PortfoliosService } from './portfolios.service';

@Module({
  imports: [
    AuditLogsModule,
    NotificationsModule,
    PermissionsModule,
    PlansModule,
    TasksModule,
  ],
  controllers: [PortfoliosController],
  providers: [
    PortfoliosService,
    PortfolioRepository,
    PortfolioPlanRepository,
    PortfolioManagementLetterRepository,
  ],
  exports: [PortfoliosService],
})
export class PortfoliosModule {}
