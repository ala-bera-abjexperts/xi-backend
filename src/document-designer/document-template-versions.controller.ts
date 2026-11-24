import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { RestoreDocumentTemplateVersionDto } from './dto/restore-document-template-version.dto';
import { DocumentTemplateVersionsService } from './document-template-versions.service';

@RequireFeature('module_document_designer')
@ApiTags('Document Template Versions')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('document-templates/:templateId/versions')
export class DocumentTemplateVersionsController {
  constructor(private readonly service: DocumentTemplateVersionsService) {}

  @Get()
  @RequirePermissions('can_view_document_templates')
  @ApiOperation({
    summary: "List a document template's version history (newest first)",
  })
  list(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listVersions(templateId, user.organizationId);
  }

  @Get(':versionId')
  @RequirePermissions('can_view_document_templates')
  @ApiOperation({
    summary: 'Get one version with its definition snapshot (read-only preview)',
  })
  getOne(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getVersion(templateId, versionId, user.organizationId);
  }

  @Post()
  @RequirePermissions('can_manage_document_templates')
  @ApiOperation({
    summary: 'Manually snapshot the current template as a new version',
  })
  create(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.captureVersion(
      templateId,
      user.organizationId,
      user.userId,
      { force: true },
    );
  }

  @Post(':versionId/restore')
  @RequirePermissions('can_manage_document_templates')
  @ApiOperation({
    summary: 'Restore a version onto the live template (version-locked)',
  })
  restore(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() dto: RestoreDocumentTemplateVersionDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.restoreVersion(
      templateId,
      versionId,
      user.organizationId,
      user.userId,
      dto.version,
    );
  }
}
