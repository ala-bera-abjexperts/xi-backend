import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { FormBuilderIntegrationsService } from './form-builder-integrations.service';
import { CreateIntegrationDto } from './dto/create-integration.dto';
import { UpdateIntegrationDto } from './dto/update-integration.dto';
import { ListGithubReposDto } from './dto/list-github-repos.dto';
import { ListClickupListsDto } from './dto/list-clickup-lists.dto';
import { ListTrelloListsDto } from './dto/list-trello-lists.dto';
import { ListAirtableBasesDto } from './dto/list-airtable-bases.dto';
import { ListAirtableTablesDto } from './dto/list-airtable-tables.dto';
import { ListJiraProjectsDto } from './dto/list-jira-projects.dto';
import { ListJiraIssueTypesDto } from './dto/list-jira-issue-types.dto';
import { ListHubspotPropertiesDto } from './dto/list-hubspot-properties.dto';
import { ListSalesforceFieldsDto } from './dto/list-salesforce-fields.dto';
import { FormBuilderSpaceOrgInterceptor } from './interceptors/space-org.interceptor';

@RequireFeature('module_form_builder')
@ApiTags('form-builder')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(FormBuilderSpaceOrgInterceptor)
@Controller('spaces/:spaceId/forms/:formId/integrations')
export class FormBuilderIntegrationsController {
  constructor(private readonly service: FormBuilderIntegrationsService) {}

  @Get()
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'List a form’s native integrations' })
  async list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(formId, { spaceId, orgId: user.organizationId });
  }

  @Post()
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'Create a native integration' })
  async create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: CreateIntegrationDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.create(
      formId,
      dto,
      { spaceId, orgId: user.organizationId },
      user.userId,
    );
  }

  @Patch(':integrationId')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'Update a native integration' })
  async update(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('integrationId', ParseUUIDPipe) integrationId: string,
    @Body() dto: UpdateIntegrationDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.update(formId, integrationId, dto, {
      spaceId,
      orgId: user.organizationId,
    });
  }

  @Delete(':integrationId')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'Delete a native integration' })
  async remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('integrationId', ParseUUIDPipe) integrationId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.remove(formId, integrationId, {
      spaceId,
      orgId: user.organizationId,
    });
  }

  // Resource pickers — mirror the existing github/repositories route: static POST paths declared
  // BEFORE the parameterised ':integrationId/*' routes. The credential typed into the dialog is sent
  // in the body so the picker works while CREATING an integration; when it is omitted (edit mode)
  // the service falls back to this form's stored, decrypted credential.

  @Post('clickup/lists')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'List the connected ClickUp account’s Lists' })
  async listClickupLists(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: ListClickupListsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listClickupLists(formId, dto.credential, {
      spaceId,
      orgId: user.organizationId,
    });
  }

  @Post('trello/lists')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'List the connected Trello account’s Lists' })
  async listTrelloLists(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: ListTrelloListsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listTrelloLists(
      formId,
      { apiKey: dto.apiKey, credential: dto.credential },
      { spaceId, orgId: user.organizationId },
    );
  }

  @Post('airtable/bases')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'List the connected Airtable account’s bases' })
  async listAirtableBases(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: ListAirtableBasesDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listAirtableBases(formId, dto.credential, {
      spaceId,
      orgId: user.organizationId,
    });
  }

  @Post('airtable/tables')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'List the tables inside an Airtable base' })
  async listAirtableTables(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: ListAirtableTablesDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listAirtableTables(
      formId,
      { baseId: dto.baseId, credential: dto.credential },
      { spaceId, orgId: user.organizationId },
    );
  }

  @Post('jira/projects')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'List the connected Jira account’s projects' })
  async listJiraProjects(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: ListJiraProjectsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listJiraProjects(
      formId,
      { siteUrl: dto.siteUrl, email: dto.email, credential: dto.credential },
      { spaceId, orgId: user.organizationId },
    );
  }

  @Post('jira/issue-types')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'List the creatable issue types in a Jira project' })
  async listJiraIssueTypes(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: ListJiraIssueTypesDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listJiraIssueTypes(
      formId,
      {
        siteUrl: dto.siteUrl,
        email: dto.email,
        projectKey: dto.projectKey,
        credential: dto.credential,
      },
      { spaceId, orgId: user.organizationId },
    );
  }

  @Post('hubspot/properties')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'List writable HubSpot contact properties' })
  async listHubspotProperties(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: ListHubspotPropertiesDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listHubspotProperties(formId, dto.credential, {
      spaceId,
      orgId: user.organizationId,
    });
  }

  @Post('salesforce/fields')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'List createable Salesforce Lead fields' })
  async listSalesforceFields(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: ListSalesforceFieldsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listSalesforceLeadFields(
      formId,
      { instanceUrl: dto.instanceUrl },
      { spaceId, orgId: user.organizationId },
    );
  }

  @Post(':integrationId/test')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'Send a test event to a native integration' })
  async sendTest(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('integrationId', ParseUUIDPipe) integrationId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.sendTest(formId, integrationId, {
      spaceId,
      orgId: user.organizationId,
    });
  }

  @Post('github/repositories')
  @RequireSpacePermission('manage_forms')
  @ApiOperation({ summary: 'List the connected GitHub account’s repositories' })
  async listGithubRepos(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Body() dto: ListGithubReposDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listGithubRepos(formId, dto.credential, {
      spaceId,
      orgId: user.organizationId,
    });
  }

  @Get(':integrationId/deliveries')
  @RequireSpacePermission('view_form_responses')
  @ApiOperation({
    summary: 'List recent delivery attempts for a native integration',
  })
  async listDeliveries(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('formId', ParseUUIDPipe) formId: string,
    @Param('integrationId', ParseUUIDPipe) integrationId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listDeliveries(formId, integrationId, {
      spaceId,
      orgId: user.organizationId,
    });
  }
}
