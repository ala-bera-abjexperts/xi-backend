import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SlaResultsService } from './sla-results.service';
class SlaBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  task_ids!: string[];
}
@Controller('sla')
export class SlaResultsController {
  constructor(private readonly service: SlaResultsService) {}
  @Get('tasks/:id') task(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.task(user, id);
  }
  @Get('tasks/:id/history')
  history(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.history(user, id);
  }
  @Post('tasks/batch') batch(
    @CurrentUser() user: RequestUser,
    @Body() body: SlaBatchDto,
  ) {
    return this.service.batch(user, body.task_ids);
  }
}
