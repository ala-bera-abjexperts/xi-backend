import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { SetUserStateDto } from './dto/set-user-state.dto';
import { QuickFiltersService } from './quick-filters.service';

@RequireFeature('module_boards')
@ApiTags('Board Quick Filters')
@ApiBearerAuth()
@Controller('boards/:boardId/user-state/quick-filters')
export class QuickFiltersUserStateController {
  constructor(private readonly service: QuickFiltersService) {}

  @Put(':filterId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set active/inactive state of a quick filter for the current user',
  })
  @ApiParam({ name: 'boardId' })
  @ApiParam({ name: 'filterId' })
  async setState(
    @CurrentUser() user: RequestUser,
    @Param('boardId', ParseUUIDPipe) boardId: string,
    @Param('filterId', ParseUUIDPipe) filterId: string,
    @Body() dto: SetUserStateDto,
  ) {
    return this.service.setUserState(
      boardId,
      filterId,
      user.organizationId,
      user.userId,
      dto.is_active,
    );
  }
}
