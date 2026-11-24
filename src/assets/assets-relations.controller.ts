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
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AssetsRelationsService } from './assets-relations.service';
import { CreateRelationDto } from './dto/create-relation.dto';

@RequireFeature('module_lists')
@ApiTags('Asset Relations')
@ApiBearerAuth()
@Controller('lists/items')
export class AssetsRelationsController {
  constructor(private readonly service: AssetsRelationsService) {}

  @Get(':itemId/relations')
  @ApiOperation({ summary: 'List relations for an item (source + target)' })
  @ApiParam({ name: 'itemId' })
  async getAll(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.getAll(itemId, user.organizationId);
  }

  @Post(':itemId/relations')
  @ApiOperation({ summary: 'Create a relation between items' })
  @ApiParam({ name: 'itemId' })
  async create(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: CreateRelationDto,
  ) {
    return this.service.create(itemId, user.organizationId, user.userId, dto);
  }

  @Delete('relations/:relationId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a relation' })
  @ApiParam({ name: 'relationId' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('relationId', ParseUUIDPipe) relationId: string,
  ) {
    return this.service.delete(relationId, user.organizationId);
  }
}
