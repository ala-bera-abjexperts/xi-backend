import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { TestManagementResponseInterceptor } from '../test-management-response.interceptor';
import { LABEL_VALUE } from './custom-images/registry/custom-image-review';
import {
  optionalText,
  USER_IMAGE_LANGUAGES,
} from './custom-images/shared/inputs/custom-image-inputs';
import { TestAutomationCustomImagesService } from './test-automation-custom-images.service';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CheckCustomImageDto {
  @ApiProperty({
    description:
      'Image address pinned by digest, for example ghcr.io/team/tests@sha256:…',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 600)
  image_ref!: string;

  @ApiPropertyOptional({
    description: 'Language of an image without labels, for example javascript',
  })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @Matches(LABEL_VALUE)
  @IsIn(USER_IMAGE_LANGUAGES)
  language?: string;

  @ApiPropertyOptional({
    description:
      'Test framework of an image without labels, for example cypress',
  })
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @Matches(LABEL_VALUE)
  test_framework?: string;

  @ApiPropertyOptional({
    description:
      'Whether others in the organisation may use the image; on when left out',
  })
  @IsOptional()
  @IsBoolean()
  shared?: boolean;
}

export class SetCustomImageSharingDto {
  @ApiProperty({
    description: 'Whether others in the organisation may use the image',
  })
  @IsBoolean()
  shared!: boolean;
}

export class DockerHubSearchQueryDto {
  @ApiProperty({
    description:
      'A name, owner/name, a hub.docker.com link or a copied docker pull command',
  })
  @Transform(trim)
  @IsString()
  @Length(2, 300)
  q!: string;
}

export class DockerHubTagsQueryDto {
  @ApiProperty({ description: 'A Docker Hub image, such as apache/cassandra' })
  @Transform(trim)
  @IsString()
  @Length(1, 255)
  repository!: string;

  @ApiPropertyOptional({
    description: 'Only versions whose name contains this',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 128)
  name?: string;
}

/**
 * Custom test images of a space's organisation. The space param is `:spaceId` and the image is `:imageId`, never
 * `:id`: SpacePermissionsGuard falls back to `params.id` as the space id.
 */
@RequireFeature('module_test_management')
@ApiTags('test-management')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@UseInterceptors(TestManagementResponseInterceptor)
@Controller('spaces/:spaceId/test-management/automation')
export class TestAutomationCustomImagesController {
  constructor(private readonly images: TestAutomationCustomImagesService) {}

  @Get('custom-images/settings')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary: 'Whether custom images, Docker Hub and uploads are on here',
  })
  settings(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.images.settings(user, spaceId);
  }

  @Get('custom-images')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary: "The organisation's custom test images and their checks",
  })
  list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.images.list(user, spaceId);
  }

  @Post('custom-images/check')
  @RequireSpacePermission('edit_space_settings')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Check a custom test image in its registry before a setting uses it',
  })
  check(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CheckCustomImageDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.images.check(
      user,
      spaceId,
      dto.image_ref,
      {
        language: dto.language,
        test_framework: dto.test_framework,
      },
      dto.shared,
    );
  }

  @Get('custom-images/:imageId')
  @RequireSpacePermission('view_tests')
  @ApiOperation({
    summary: 'One custom test image and the result of its check',
  })
  get(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.images.get(user, spaceId, imageId);
  }

  @Post('custom-images/:imageId/block')
  @RequireSpacePermission('edit_space_settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Block a custom test image so no setting can run it',
  })
  block(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.images.block(user, spaceId, imageId);
  }

  @Post('custom-images/:imageId/sharing')
  @RequireSpacePermission('edit_space_settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Let others in the organisation use a custom test image, or keep it private',
  })
  setSharing(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Body() dto: SetCustomImageSharingDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.images.setSharing(user, spaceId, imageId, dto.shared);
  }

  @Get('docker-hub/search')
  @RequireSpacePermission('edit_space_settings')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Search Docker Hub for a custom test image' })
  searchDockerHub(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: DockerHubSearchQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.images.searchDockerHub(user, spaceId, query.q);
  }

  @Get('docker-hub/tags')
  @RequireSpacePermission('edit_space_settings')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: "Versions of a Docker Hub image for this server's chip type",
  })
  dockerHubTags(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: DockerHubTagsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.images.dockerHubTags(
      user,
      spaceId,
      query.repository,
      query.name,
    );
  }
}
