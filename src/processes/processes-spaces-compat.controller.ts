/**
 * @fileoverview Space-scoped compatibility routes for legacy Next.js process APIs.
 * @module src/processes/processes-spaces-compat.controller
 */

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ProcessesService } from './processes.service';
import { ProcessAttachmentsService } from './processes-attachments.service';

type AnyBody = Record<string, unknown>;

@RequireFeature('module_processes')
@ApiTags('Processes')
@ApiBearerAuth()
@Controller('spaces/:spaceId/processes')
export class ProcessesSpacesCompatController {
  constructor(
    private readonly service: ProcessesService,
    private readonly attachmentsService: ProcessAttachmentsService,
  ) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  async list(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') spaceId: string,
    @Query('status') status?: string,
    @Query('request_type') requestTypeSnake?: string,
    @Query('requestType') requestTypeCamel?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSizeCamel?: string,
    @Query('withParents') withParentsCamel?: string,
    @Query('with_parents') withParentsSnake?: string,
    @Query('page_size') pageSizeSnake?: string,
  ) {
    const requestType = requestTypeSnake ?? requestTypeCamel;
    const parsedPage = this.parseIntOrUndefined(page);
    const parsedPageSize =
      this.parseIntOrUndefined(pageSizeCamel) ??
      this.parseIntOrUndefined(pageSizeSnake);
    const filters = this.compact({
      status,
      request_type: requestType,
      search,
      page: parsedPage,
      pageSize: parsedPageSize,
    });

    if (parsedPage !== undefined || parsedPageSize !== undefined) {
      const result = await this.service.getAll(
        user.organizationId,
        spaceId,
        filters,
      );
      return {
        data: result.data,
        total: result.total,
        page: result.page ?? parsedPage ?? 1,
        pageSize: result.pageSize ?? parsedPageSize ?? 50,
      };
    }

    const withParents =
      withParentsCamel === 'true' || withParentsSnake === 'true';
    const data = withParents
      ? await this.service.getAllWithParents(
          user.organizationId,
          spaceId,
          filters,
        )
      : (await this.service.getAll(user.organizationId, spaceId, filters)).data;
    return { data, count: data.length };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_processes')
  async create(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') spaceId: string,
    @Body() body: AnyBody,
  ) {
    const data = await this.service.create(user.organizationId, user.userId, {
      ...this.cleanBody(body),
      space_id: spaceId,
    } as never);
    return { data, success: true };
  }

  @Get('by-key/:key')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  async getByKey(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') spaceId: string,
    @Param('key') key: string,
    @Query('withParents') withParentsCamel?: string,
    @Query('with_parents') withParentsSnake?: string,
  ) {
    const data =
      withParentsCamel === 'true' || withParentsSnake === 'true'
        ? await this.service.getByKeyWithParents(
            key,
            user.organizationId,
            spaceId,
          )
        : await this.service.getByKey(key, user.organizationId, spaceId);
    return { data };
  }

  @Get(':processId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') spaceId: string,
    @Param('processId') processId: string,
    @Query('withParents') withParentsCamel?: string,
    @Query('with_parents') withParentsSnake?: string,
    @Query('tree') tree?: string,
  ) {
    if (tree === 'true') {
      const data = await this.service.getProcessTree(
        user.organizationId,
        processId,
        spaceId,
      );
      return { data };
    }

    const data =
      withParentsCamel === 'true' || withParentsSnake === 'true'
        ? await this.service.getByIdWithParents(
            processId,
            user.organizationId,
            spaceId,
          )
        : await this.service.getById(processId, user.organizationId, spaceId);
    return { data };
  }

  @Put(':processId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_processes')
  async update(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('processId') processId: string,
    @Body() body: AnyBody,
  ) {
    const data = await this.service.update(
      processId,
      user.organizationId,
      user.userId,
      this.cleanBody(body) as never,
    );
    return { data, success: true };
  }

  @Delete(':processId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_processes')
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('processId') processId: string,
  ) {
    await this.service.delete(processId, user.organizationId, user.userId);
    return { success: true };
  }

  @Get(':processId/diagram')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  getDiagram(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('processId') processId: string,
  ) {
    return this.service.getDiagram(processId, user.organizationId);
  }

  @Put(':processId/diagram')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_processes')
  async upsertDiagram(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('processId') processId: string,
    @Body() body: AnyBody,
  ) {
    const xml = body.xml;
    if (typeof xml !== 'string' || xml.length === 0) {
      throw new BadRequestException('xml and organizationId are required');
    }
    return this.service.upsertDiagram(
      processId,
      user.organizationId,
      user.userId,
      xml,
      typeof body.previewSvg === 'string' ? body.previewSvg : undefined,
    );
  }

  @Get(':processId/attachments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  listAttachments(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('processId') processId: string,
  ) {
    return this.attachmentsService.getAttachments(
      processId,
      user.organizationId,
    );
  }

  @Post(':processId/attachments')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_processes')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  async uploadAttachment(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('processId') processId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('File is required');
    return this.attachmentsService.uploadAttachment(
      processId,
      user.organizationId,
      user.userId,
      file,
    );
  }

  @Get(':processId/attachments/:attachmentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  getAttachmentDownloadUrl(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.attachmentsService.getDownloadUrl(
      attachmentId,
      user.organizationId,
    );
  }

  @Delete(':processId/attachments/:attachmentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_processes')
  deleteAttachment(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    return this.attachmentsService.deleteAttachment(
      attachmentId,
      user.organizationId,
      user.userId,
    );
  }

  @Post('reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_processes')
  async reorder(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Body() body: { updates?: { id: string; sort_order: number }[] },
  ) {
    if (!body.updates?.length) {
      throw new BadRequestException('updates array is required');
    }
    await this.service.reorder(body.updates, user.organizationId);
    return { success: true, updated: body.updates.length };
  }

  private cleanBody<T extends AnyBody>(body: T): AnyBody {
    const cleaned = { ...(body ?? ({} as T)) } as Omit<
      T,
      'organizationId' | 'organization_id' | 'orgId'
    >;
    delete (cleaned as Record<string, unknown>)['organizationId'];
    delete (cleaned as Record<string, unknown>)['organization_id'];
    delete (cleaned as Record<string, unknown>)['orgId'];
    const rest = cleaned as AnyBody;
    if ('requestType' in rest && !('request_type' in rest)) {
      rest.request_type = rest.requestType;
      delete rest.requestType;
    }
    return rest;
  }

  private compact<T extends AnyBody>(value: T): T {
    return Object.fromEntries(
      Object.entries(value).filter(([, v]) => v !== undefined),
    ) as T;
  }

  private parseIntOrUndefined(value?: string): number | undefined {
    if (value === undefined || value === '') return undefined;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
}
