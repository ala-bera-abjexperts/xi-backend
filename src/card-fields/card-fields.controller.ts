import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { CardFieldsService } from './card-fields.service';
import { SetCardFieldsDto } from './dto/set-card-fields.dto';

@RequireFeature('module_boards')
@ApiTags('Board Card Fields')
@ApiBearerAuth()
@Controller('boards/:boardId/card-fields')
export class CardFieldsController {
  constructor(private readonly service: CardFieldsService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_boards')
  @ApiOperation({
    summary: 'List card fields for a board (ordered by position)',
  })
  @ApiParam({ name: 'boardId' })
  async getCardFields(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
  ) {
    return this.service.getCardFields(boardId, user.organizationId);
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_boards')
  @ApiOperation({
    summary: 'Replace all card fields for a board (delete-then-insert)',
  })
  @ApiParam({ name: 'boardId' })
  async setCardFields(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Body() dto: SetCardFieldsDto,
  ) {
    return this.service.setCardFields(boardId, user.organizationId, dto);
  }
}
