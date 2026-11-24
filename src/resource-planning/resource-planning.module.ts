/**
 * @fileoverview NestJS module for the Resource Planning feature.
 * Wires together the controller, service, and required dependencies.


 * @module src/resource-planning/resource-planning.module
 */

import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { DocumentDesignerModule } from '../document-designer/document-designer.module';
import { OrganizationModulesModule } from '../organization-modules/organization-modules.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { CalendarAdminController } from './calendar/calendar-admin.controller';
import { CalendarAdminService } from './calendar/calendar-admin.service';
import { WorkingCalendarService } from './calendar/working-calendar.service';
import { BudgetSplitController } from './budget-split/budget-split.controller';
import { BudgetSplitService } from './budget-split/budget-split.service';
import { BudgetCostCategoriesService } from './budget-tree/budget-cost-categories.service';
import { BudgetTimelineService } from './budget-tree/budget-timeline.service';
import { BudgetTreeController } from './budget-tree/budget-tree.controller';
import { BudgetTreeService } from './budget-tree/budget-tree.service';
import { BudgetTimelinePeopleController } from './budget-tree/people/budget-timeline-people.controller';
import { BudgetTimelinePeopleService } from './budget-tree/people/budget-timeline-people.service';
import { ResourcePlanningController } from './resource-planning.controller';
import { ResourcePlanningCoreController } from './resource-planning-core.controller';
import { ResourcePlanningCoreService } from './resource-planning-core.service';
import { ResourcePlanningService } from './resource-planning.service';
import { OverallBudgetController } from './overall-budget/overall-budget.controller';
import { OverallBudgetService } from './overall-budget/overall-budget.service';
import { BudgetUsageService } from './overall-budget/budget-usage.service';
import { PlanningRosterController } from './roster/planning-roster.controller';
import { PlanningRosterService } from './roster/planning-roster.service';
import { ScheduleController } from './schedule/schedule.controller';
import { ScheduleService } from './schedule/schedule.service';
import {
  ResourcePlanningReportController,
  ResourcePlanningReportExportService,
  ResourcePlanningReportService,
} from './reporting';

@Module({
  imports: [
    PermissionsModule,
    OrganizationModulesModule,
    DocumentDesignerModule,
    AuditLogsModule,
  ],
  controllers: [
    ResourcePlanningController,
    ResourcePlanningCoreController,
    ResourcePlanningReportController,
    CalendarAdminController,
    BudgetTreeController,
    ScheduleController,
    PlanningRosterController,
    OverallBudgetController,
    BudgetSplitController,
    BudgetTimelinePeopleController,
  ],
  providers: [
    WorkingCalendarService,
    CalendarAdminService,
    BudgetCostCategoriesService,
    BudgetTreeService,
    BudgetTimelineService,
    BudgetTimelinePeopleService,
    ResourcePlanningService,
    ResourcePlanningCoreService,
    ResourcePlanningReportService,
    ResourcePlanningReportExportService,
    ScheduleService,
    PlanningRosterService,
    OverallBudgetService,
    BudgetUsageService,
    BudgetSplitService,
  ],
  exports: [
    ResourcePlanningService,
    ResourcePlanningCoreService,
    ResourcePlanningReportService,
    WorkingCalendarService,
  ],
})
export class ResourcePlanningModule {}
