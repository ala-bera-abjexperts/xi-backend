import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { ContactsService } from './contacts.service';
import { ListContactsDto } from './dto/list-contacts.dto';

@RequireFeature('module_site_studio')
@ApiTags('Site Studio — Contacts')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('funnels/:funnelId/contacts')
export class ContactsController {
  constructor(private readonly service: ContactsService) {}

  // ── Export — must be before :contactId ───────────────────────────────────────

  @Get('export')
  @RequirePermissions('can_view_site_studio')
  @ApiOperation({ summary: 'Export contacts as CSV' })
  @ApiParam({ name: 'funnelId' })
  async exportContacts(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Res() res: Response,
  ) {
    const csv = await this.service.exportContactsCsv(
      funnelId,
      user.organizationId,
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="contacts-${funnelId}.csv"`,
    );
    res.send(csv);
  }

  // ── List ──────────────────────────────────────────────────────────────────────

  @Get()
  @RequirePermissions('can_view_site_studio')
  @ApiOperation({ summary: 'List contacts for a funnel (paginated)' })
  @ApiParam({ name: 'funnelId' })
  async getContacts(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Query() dto: ListContactsDto,
  ) {
    return this.service.getContacts(funnelId, user.organizationId, dto);
  }

  // ── Delete ────────────────────────────────────────────────────────────────────

  @Delete(':contactId')
  @RequirePermissions('can_delete_site_studio')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a contact' })
  @ApiParam({ name: 'funnelId' })
  @ApiParam({ name: 'contactId' })
  async deleteContact(
    @CurrentUser() user: RequestUser,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ) {
    await this.service.deleteContact(
      contactId,
      user.organizationId,
      user.userId,
    );
  }
}
