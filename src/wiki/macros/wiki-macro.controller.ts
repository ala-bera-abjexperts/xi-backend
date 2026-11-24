import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  ResolveWikiMacroDto,
  type WikiMacroRequest,
} from './wiki-macro.contract';
import { WikiMacroService } from './wiki-macro.service';

@RequireFeature('module_wiki')
@ApiTags('Wiki')
@ApiBearerAuth()
@Controller('spaces/:spaceId/wiki/macros')
export class WikiMacroController {
  constructor(private readonly macroService: WikiMacroService) {}

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve one authenticated wiki macro' })
  resolve(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: ResolveWikiMacroDto,
  ) {
    return this.macroService.resolve(user, spaceId, dto as WikiMacroRequest);
  }
}
