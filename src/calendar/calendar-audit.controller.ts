/**
 * @fileoverview Reading the calendar module's audit trail.
 *
 * The trail spans every calendar in the tenant, private ones included, so it is administration: only
 * an organization owner or admin may read it. Writing entries happens inside the services themselves.
 */
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  CALENDAR_AUDIT_ENTITIES,
  CalendarAuditService,
  type CalendarAuditEntity,
  type CalendarAuditPage,
  CALENDAR_AUDIT_SORTS,
  type CalendarAuditSort,
} from './calendar-audit.service';
import { CalendarPrincipalsService } from './calendar-principals.service';
import { CalendarsService } from './calendars.service';

const DEFAULT_LIMIT = 50;

const MAX_LIMIT = 200;

@RequireFeature('module_calendar')
@ApiTags('calendar-audit')
@ApiBearerAuth()
@Controller('calendar/audit')
export class CalendarAuditController {
  constructor(
    private readonly audit: CalendarAuditService,
    private readonly calendars: CalendarsService,
    private readonly principals: CalendarPrincipalsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Recent calendar activity, newest first' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `How many rows, 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT})`,
  })
  @ApiQuery({
    name: 'before',
    required: false,
    description: 'ISO timestamp; returns only entries older than it',
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    description: `Column to order by: ${CALENDAR_AUDIT_SORTS.join(', ')}`,
  })
  @ApiQuery({
    name: 'dir',
    required: false,
    description: 'asc or desc; desc by default',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'How many rows to skip, for page 2 onwards',
  })
  @ApiQuery({
    name: 'action',
    required: false,
    description: 'One or more actions, comma separated',
  })
  @ApiQuery({
    name: 'user_id',
    required: false,
    description: 'Only what this person did',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO timestamp; nothing older than this',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'ISO timestamp; nothing newer than this',
  })
  @ApiQuery({
    name: 'entity_type',
    required: false,
    description: `One slice of the trail: ${CALENDAR_AUDIT_ENTITIES.join(', ')}`,
  })
  @ApiResponse({ status: 200, description: 'Entries returned' })
  @ApiResponse({
    status: 403,
    description: 'Not an organization owner or admin, or the module is off',
  })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('entity_type') entityType?: string,
    @Query('action') action?: string,
    @Query('user_id') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('offset') offset?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
  ): Promise<CalendarAuditPage> {
    await this.calendars.assertModuleEnabled(user.organizationId);

    const { isOrgAdmin } = await this.principals.resolve(
      user.userId,
      user.organizationId,
    );

    if (!isOrgAdmin) {
      throw new ForbiddenException(
        'Only an organization owner or admin can read the calendar audit trail.',
      );
    }

    // Checked here rather than handed to the database, which would answer with its own parse error.
    for (const [name, value] of [
      ['before', before],
      ['from', from],
      ['to', to],
    ] as const) {
      if (value !== undefined && Number.isNaN(Date.parse(value))) {
        throw new BadRequestException(`\`${name}\` must be an ISO timestamp.`);
      }
    }

    return this.audit.recent(
      user.organizationId,
      CalendarAuditController.pageSize(limit),
      before,
      CalendarAuditController.slice(entityType),
      {
        actions: action
          ? action
              .split(',')
              .map((part) => part.trim())
              .filter(Boolean)
          : undefined,
        userId: userId || undefined,
        from: from || undefined,
        to: to || undefined,
      },
      CalendarAuditController.startAt(offset),
      CalendarAuditController.orderBy(sort),
      dir === 'asc',
    );
  }

  /** An unknown slice is refused rather than silently widened to the whole trail. */
  private static slice(
    entityType?: string,
  ): readonly CalendarAuditEntity[] | undefined {
    if (entityType === undefined || entityType === '') return undefined;

    const asked = entityType.split(',').map((part) => part.trim());
    const known = asked.filter((part): part is CalendarAuditEntity =>
      (CALENDAR_AUDIT_ENTITIES as readonly string[]).includes(part),
    );

    if (known.length !== asked.length) {
      throw new BadRequestException(
        `\`entity_type\` must be one of: ${CALENDAR_AUDIT_ENTITIES.join(', ')}`,
      );
    }

    return known;
  }

  /** An unknown column is refused rather than handed to the database as an order clause. */
  private static orderBy(sort?: string): CalendarAuditSort {
    if (sort === undefined || sort === '') return 'created_at';

    if (!(CALENDAR_AUDIT_SORTS as readonly string[]).includes(sort)) {
      throw new BadRequestException(
        `\`sort\` must be one of: ${CALENDAR_AUDIT_SORTS.join(', ')}`,
      );
    }

    return sort as CalendarAuditSort;
  }

  /** A missing or unreadable offset starts at the beginning rather than refusing the request. */
  private static startAt(offset?: string): number {
    const asked = Number.parseInt(offset ?? '', 10);

    return Number.isFinite(asked) && asked > 0 ? asked : 0;
  }

  /** A missing or unreadable limit falls back to the default rather than refusing the request. */
  private static pageSize(limit?: string): number {
    const asked = Number.parseInt(limit ?? '', 10);

    if (!Number.isFinite(asked) || asked < 1) return DEFAULT_LIMIT;

    return Math.min(asked, MAX_LIMIT);
  }
}
