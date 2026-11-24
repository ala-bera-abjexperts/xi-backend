import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { contentDispositionAttachment } from '../common/content-disposition';
import { ExportFilterDto } from './dto/export-filter.dto';
import { FilterExportsService } from './filter-exports.service';

@RequireFeature('module_filters')
@ApiTags('Saved Filters')
@ApiBearerAuth()
@Controller('filters')
export class FilterExportsController {
  constructor(private readonly service: FilterExportsService) {}

  @Post(':id/export')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Export the current filter result as CSV, Excel or PDF',
  })
  @ApiParam({ name: 'id' })
  async export(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExportFilterDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // A cancelled download closes the connection, so the remaining pages are never read.
    const abort = new AbortController();

    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    try {
      const { buffer, fileName, contentType } = await this.service.export(
        id,
        dto,
        user.organizationId,
        user.userId,
        req.headers.origin,
        abort.signal,
      );

      res.set({
        'Content-Type': contentType,
        'Content-Disposition': contentDispositionAttachment(fileName),
        'Cache-Control': 'no-store',
      });
      res.send(buffer);
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }
  }
}
