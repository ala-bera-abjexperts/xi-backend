import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SlaRepliesService } from './sla-replies.service';
import {
  parseTieSortsQuery,
  sortTaskComments,
} from '../tasks/task-comment-sort';
import {
  TASK_COMMENT_SORTS,
  type TaskCommentSort,
} from '../users/dto/save-task-comment-preferences.dto';
class LinkRequestDto {
  @IsUUID() request_id!: string;
}
class PublishReplyDto {
  @IsUUID()
  request_id!: string;
  @IsUUID() idempotency_key!: string;
  @IsString() @MinLength(1) @MaxLength(50000) content!: string;
}
@Controller('sla/tasks/:taskId')
export class SlaRepliesController {
  constructor(private readonly replies: SlaRepliesService) {}
  @Get('support-request-options')
  options(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) id: string,
    @Query('search') search?: string,
  ) {
    return this.replies.supportRequestOptions(user, id, search);
  }
  @Get('support-request')
  get(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) id: string,
  ) {
    return this.replies.linkedRequest(user, id);
  }
  @Put('support-request')
  link(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) id: string,
    @Body() dto: LinkRequestDto,
  ) {
    return this.replies.link(user, id, dto.request_id);
  }
  @Delete('support-request')
  unlink(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) id: string,
  ) {
    return this.replies.link(user, id, null);
  }
  @Get('customer-replies')
  async thread(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) id: string,
    @Query('sort') sort?: string,
    @Query('then') then?: string,
  ) {
    const tieSorts = parseTieSortsQuery(then);
    if (!tieSorts)
      throw new BadRequestException(
        'then must be comma-separated, from: oldest, newest, updated_desc, updated_asc (one created and one updated at most)',
      );
    if (sort === undefined) return this.replies.thread(user, id);
    if (!TASK_COMMENT_SORTS.includes(sort as TaskCommentSort)) {
      throw new BadRequestException(
        `sort must be one of: ${TASK_COMMENT_SORTS.join(', ')}`,
      );
    }
    // Same server-side orders as internal task comments
    return sortTaskComments(
      await this.replies.thread(user, id),
      sort as TaskCommentSort,
      tieSorts,
    );
  }
  @Post('customer-replies')
  publish(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) id: string,
    @Body() dto: PublishReplyDto,
  ) {
    return this.replies.publish(user, id, dto);
  }
}
