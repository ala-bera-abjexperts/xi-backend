import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { contentDispositionAttachment } from '../common/content-disposition';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AssetsSchemasService } from './assets-schemas.service';
import { CreateAssetSchemaDto } from './dto/create-asset-schema.dto';
import { UpdateAssetSchemaDto } from './dto/update-asset-schema.dto';
import { AddColumnDto } from './dto/add-column.dto';
import { ReorderColumnsDto } from './dto/reorder-columns.dto';
import { RenameColumnDto } from './dto/rename-column.dto';

@RequireFeature('module_lists')
@ApiTags('Asset Schemas (Lists)')
@ApiBearerAuth()
// SECURITY (H2): require space membership + list view (services scope org-only).
@UseGuards(SpacePermissionsGuard)
@RequireSpacePermission('can_view_lists')
@Controller('spaces/:spaceId/lists')
export class AssetsSchemasController {
  constructor(private readonly service: AssetsSchemasService) {}

  // ── Schemas ───────────────────────────────────────────────────────────────

  @Get('schemas')
  @ApiOperation({ summary: 'List all schemas in a space' })
  @ApiParam({ name: 'spaceId' })
  async getAll(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.service.getAll(spaceId, user.organizationId);
  }

  @Post('schemas')
  @ApiOperation({ summary: 'Create a schema' })
  @ApiParam({ name: 'spaceId' })
  async create(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateAssetSchemaDto,
  ) {
    return this.service.create(spaceId, user.organizationId, user.userId, dto);
  }

  @Get('key/:key')
  @ApiOperation({ summary: 'Get schema by key' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'key' })
  async getByKey(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('key') key: string,
  ) {
    return this.service.getByKey(key, spaceId, user.organizationId);
  }

  @Get('schemas/:schemaId')
  @ApiOperation({ summary: 'Get schema by ID' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'schemaId' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
  ) {
    return this.service.getById(schemaId, spaceId, user.organizationId);
  }

  @Put('schemas/:schemaId')
  @ApiOperation({ summary: 'Update a schema' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'schemaId' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Body() dto: UpdateAssetSchemaDto,
  ) {
    return this.service.update(
      schemaId,
      spaceId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete('schemas/:schemaId')
  @ApiOperation({ summary: 'Soft delete a schema' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'schemaId' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
  ) {
    return this.service.softDelete(
      schemaId,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }

  @Get('schemas/:schemaId/export')
  @ApiOperation({ summary: 'Export schema items as CSV' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'schemaId' })
  async exportCsv(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Res() res: Response,
  ) {
    const schema = await this.service.getById(
      schemaId,
      spaceId,
      user.organizationId,
    );
    const csv = await this.service.exportCsv(
      schemaId,
      spaceId,
      user.organizationId,
    );
    const date = new Date().toISOString().split('T')[0];
    // RFC 5987: keep the ORIGINAL schema name in filename*= — the old `[^\w\s-]` strip dropped
    // every accented character from the downloaded name.
    const schemaName =
      ((schema['name'] as string | null | undefined) ?? 'export').trim() ||
      'export';
    const filename = `${schemaName}_export_${date}.csv`;
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': contentDispositionAttachment(filename),
    });
    res.send(csv);
  }

  // ── Columns ───────────────────────────────────────────────────────────────

  @Post('schemas/:schemaId/columns')
  @ApiOperation({ summary: 'Add a column to a schema' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'schemaId' })
  async addColumn(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Body() dto: AddColumnDto,
  ) {
    return this.service.addColumn(
      schemaId,
      spaceId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Put('schemas/:schemaId/columns')
  @ApiOperation({ summary: 'Reorder all columns' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'schemaId' })
  async reorderColumns(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Body() dto: ReorderColumnsDto,
  ) {
    return this.service.reorderColumns(
      schemaId,
      spaceId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Put('schemas/:schemaId/columns/:columnId')
  @ApiOperation({ summary: 'Rename a column' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'schemaId' })
  @ApiParam({ name: 'columnId' })
  async renameColumn(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Param('columnId') columnId: string,
    @Body() dto: RenameColumnDto,
  ) {
    return this.service.renameColumn(
      schemaId,
      columnId,
      spaceId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete('schemas/:schemaId/columns/:columnId')
  @ApiOperation({ summary: 'Remove a column from a schema' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'schemaId' })
  @ApiParam({ name: 'columnId' })
  async removeColumn(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Param('columnId') columnId: string,
  ) {
    return this.service.removeColumn(
      schemaId,
      columnId,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }
}
