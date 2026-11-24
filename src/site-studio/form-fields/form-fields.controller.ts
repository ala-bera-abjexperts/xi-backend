import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import {
  Body,
  Controller,
  Get,
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
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { SaveFormFieldsDto } from './dto/save-form-fields.dto';
import { FormFieldsService } from './form-fields.service';

@RequireFeature('module_site_studio')
@ApiTags('Site Studio — Form Fields')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('funnels/:funnelId/form-fields')
export class FormFieldsController {
  constructor(private readonly service: FormFieldsService) {}

  @Get()
  @RequirePermissions('can_view_site_studio')
  @ApiOperation({ summary: 'List form fields for a funnel' })
  @ApiParam({ name: 'funnelId' })
  async getFormFields(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
  ) {
    const fields = await this.service.getFormFields(
      funnelId,
      user.organizationId,
    );
    return { data: fields };
  }

  @Put()
  @RequirePermissions('can_edit_site_studio')
  @ApiOperation({
    summary: 'Save (atomically replace) form fields for a funnel',
  })
  @ApiParam({ name: 'funnelId' })
  async saveFormFields(
    @CurrentUser() user: RequestUser,
    @Param('funnelId', ParseUUIDPipe) funnelId: string,
    @Body() dto: SaveFormFieldsDto,
  ) {
    const fields = await this.service.saveFormFields(
      funnelId,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data: fields };
  }
}
