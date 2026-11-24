import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireRoles } from '../auth/decorators/require-roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AiConfigService } from './ai-config.service';
import { SaveAiConfigDto } from './dto/save-ai-config.dto';
import { TestAiConfigDto } from './dto/test-ai-config.dto';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';

@RequireFeature('feature_ai_assist')
@ApiTags('AI Config')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@RequireRoles('admin', 'owner')
@Controller('ai-config')
export class AiConfigController {
  constructor(private readonly service: AiConfigService) {}

  @Get()
  @ApiOperation({ summary: 'Get AI provider config (masked key)' })
  getConfig(@CurrentUser() user: RequestUser) {
    return this.service.getConfig(user.organizationId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Save (upsert) AI provider config' })
  saveConfig(@CurrentUser() user: RequestUser, @Body() dto: SaveAiConfigDto) {
    return this.service.saveConfig(user.organizationId, user.userId, dto);
  }

  @Get('models')
  @ApiOperation({
    summary:
      'Models the saved AI provider lists, with the recommended ones (the key never leaves the server)',
  })
  getModels(@CurrentUser() user: RequestUser) {
    return this.service.getModels(user.organizationId);
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Test connection: one small call that checks the key, the model and structured output',
  })
  testConnection(
    @CurrentUser() user: RequestUser,
    @Body() dto: TestAiConfigDto,
  ) {
    return this.service.testConnection(user.organizationId, user.userId, dto);
  }

  @Delete()
  @ApiOperation({ summary: 'Remove AI provider config' })
  deleteConfig(@CurrentUser() user: RequestUser) {
    return this.service.deleteConfig(user.organizationId, user.userId);
  }

  @Get('usage')
  @ApiOperation({
    summary: 'Get AI usage analytics (last 14 days + aggregates)',
  })
  getUsageStats(@CurrentUser() user: RequestUser) {
    return this.service.getUsageStats(user.organizationId);
  }
}
