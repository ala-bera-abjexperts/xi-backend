import { UPLOAD_LIMITS } from '../common/upload-limits';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AttachmentsService } from './attachments.service';
import { CheckoutAttachmentDto } from './dto/checkout-attachment.dto';
import { CheckoutMessageDto } from './dto/checkout-message.dto';
import { CreateEntityFileLinkDto } from './dto/create-entity-file-link.dto';
import { ListAttachmentsQueryDto } from './dto/list-attachments-query.dto';
import { UploadAttachmentDto } from './dto/upload-attachment.dto';
import { EntityFileLinksService } from './entity-file-links.service';

@ApiTags('Attachments')
@ApiBearerAuth()
@Controller('attachments')
export class AttachmentsController {
  constructor(
    private readonly service: AttachmentsService,
    private readonly fileLinksService: EntityFileLinksService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List centralized attachments for an entity' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query() query: ListAttachmentsQueryDto,
  ) {
    return this.service.listForEntity({
      user,
      entityType: query.entityType,
      entityId: query.entityId,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Upload or version a centralized attachment' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: UPLOAD_LIMITS.ATTACHMENT } }),
  )
  async upload(
    @CurrentUser() user: RequestUser,
    @Body() body: UploadAttachmentDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Missing file');

    return this.service.upload({
      user,
      entityType: body.entity_type,
      entityId: body.entity_id,
      file,
      comment: body.comment ?? null,
    });
  }

  @Get('file-links')
  @ApiOperation({ summary: 'List File Explorer links for an entity' })
  async listFileLinks(
    @CurrentUser() user: RequestUser,
    @Query() query: ListAttachmentsQueryDto,
  ) {
    return this.fileLinksService.listForEntity({
      user,
      entityType: query.entityType,
      entityId: query.entityId,
    });
  }

  @Post('file-links')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Link a File Explorer item to an entity' })
  async createFileLink(
    @CurrentUser() user: RequestUser,
    @Body() body: CreateEntityFileLinkDto,
  ) {
    return this.fileLinksService.create({
      user,
      entityType: body.entity_type,
      entityId: body.entity_id,
      nodeId: body.node_id,
    });
  }

  @Delete('file-links/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a File Explorer link from an entity' })
  @ApiParam({ name: 'id' })
  async removeFileLink(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.fileLinksService.remove({ user, linkId: id });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an attachment with version history' })
  @ApiParam({ name: 'id' })
  async getWithVersions(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getWithVersions(id, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an attachment and all versions' })
  @ApiParam({ name: 'id' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.delete({ attachmentId: id, user });
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Redirect to a short-lived signed download URL' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'v', required: false, type: Number })
  @ApiQuery({ name: 'inline', required: false, enum: ['1'] })
  async download(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('v') versionParam: string | undefined,
    @Query('inline') inlineParam: string | undefined,
    @Res() res: Response,
  ) {
    if (inlineParam !== undefined && inlineParam !== '1') {
      throw new BadRequestException('Invalid inline parameter');
    }

    const versionNumber = versionParam
      ? Number.parseInt(versionParam, 10)
      : undefined;

    if (
      versionNumber !== undefined &&
      (Number.isNaN(versionNumber) || versionNumber < 1)
    ) {
      throw new BadRequestException('Invalid version parameter');
    }

    const info = await this.service.getDownloadInfo({
      attachmentId: id,
      versionNumber,
      inline: inlineParam === '1' ? true : undefined,
      user,
    });

    res.setHeader('Cache-Control', 'no-store, private');
    if (inlineParam === '1') {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    res.redirect(HttpStatus.FOUND, info.signedUrl);
  }

  @Post(':id/checkout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check out an attachment' })
  @ApiParam({ name: 'id' })
  async checkout(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CheckoutAttachmentDto,
  ) {
    return this.service.checkOut({
      attachmentId: id,
      user,
      note: body.note ?? null,
    });
  }

  @Post(':id/checkin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check in an attachment' })
  @ApiParam({ name: 'id' })
  async checkin(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.checkIn({ attachmentId: id, user });
  }

  @Post(':id/checkout-message')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Message the current checkout owner' })
  @ApiParam({ name: 'id' })
  async checkoutMessage(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CheckoutMessageDto,
  ) {
    return this.service.sendCheckoutMessage({
      attachmentId: id,
      user,
      message: body.message,
    });
  }
}
