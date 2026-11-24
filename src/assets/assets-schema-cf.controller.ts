import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AssetsSchemaCfService } from './assets-schema-cf.service';
import { AssignCustomFieldDto } from './dto/assign-custom-field.dto';
import { UpdateCustomFieldAssignmentDto } from './dto/update-custom-field-assignment.dto';
import { ReorderCustomFieldsDto } from './dto/reorder-custom-fields.dto';
import { SyncCustomFieldsDto } from './dto/sync-custom-fields.dto';

@RequireFeature('module_lists')
@ApiTags('Asset Schema Custom Fields')
@ApiBearerAuth()
@Controller('lists/schemas/:schemaId/custom-fields')
export class AssetsSchemaCfController {
  constructor(private readonly service: AssetsSchemaCfService) {}

  // ── Static paths before /:assignmentId ────────────────────────────────────

  @Put('reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder custom fields in a schema' })
  @ApiParam({ name: 'schemaId' })
  async reorder(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Body() dto: ReorderCustomFieldsDto,
  ) {
    return this.service.reorder(schemaId, user.organizationId, dto);
  }

  @Put('sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sync (replace all) custom fields for a schema' })
  @ApiParam({ name: 'schemaId' })
  async sync(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Body() dto: SyncCustomFieldsDto,
  ) {
    return this.service.sync(schemaId, user.organizationId, user.userId, dto);
  }

  // ── Core CRUD ─────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List custom field assignments for a schema' })
  @ApiParam({ name: 'schemaId' })
  async getAll(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
  ) {
    return this.service.getAll(schemaId, user.organizationId);
  }

  @Post()
  @ApiOperation({ summary: 'Assign a custom field to a schema' })
  @ApiParam({ name: 'schemaId' })
  async assign(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Body() dto: AssignCustomFieldDto,
  ) {
    return this.service.assign(schemaId, user.organizationId, user.userId, dto);
  }

  @Patch(':assignmentId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a custom field assignment' })
  @ApiParam({ name: 'schemaId' })
  @ApiParam({ name: 'assignmentId' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() dto: UpdateCustomFieldAssignmentDto,
  ) {
    return this.service.updateAssignment(
      assignmentId,
      schemaId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete(':assignmentId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a custom field from a schema' })
  @ApiParam({ name: 'schemaId' })
  @ApiParam({ name: 'assignmentId' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
  ) {
    return this.service.removeAssignment(
      assignmentId,
      schemaId,
      user.organizationId,
    );
  }
}
