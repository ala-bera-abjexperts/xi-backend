/**
 * @fileoverview NestJS module for the LISTS feature.
 *
 * NAMING TRAP, read before touching licensing or module toggles:
 * this directory is called `assets/` for historical reasons but it implements
 * **Lists** (list schemas, list items, their attachments, comments, links and
 * relations). Its controllers are gated by `@RequireFeature('module_lists')`.
 *
 * The product feature called **Assets** (the CMDB: object types, object
 * schemas, hierarchical objects) lives in `src/assets-objects/` and is gated by
 * `module_assets`.
 *
 * The `organization_modules` type `assets` and the `space_module_type` label
 * `assets` both refer to the CMDB, i.e. `assets-objects/`, NOT this module. See
 * MODULE_TYPE_TO_FEATURE_KEY in organization-modules.service.ts.
 *
 * @module src/assets/assets.module
 */

import { Module } from '@nestjs/common';
import { AutomationsModule } from '../automations/automations.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AssetsHistoryService } from './assets-history.service';
import { AssetsSchemasService } from './assets-schemas.service';
import { AssetsSchemasController } from './assets-schemas.controller';
import { AssetsItemsService } from './assets-items.service';
import { AssetsItemsController } from './assets-items.controller';
import { AssetsAttachmentsService } from './assets-attachments.service';
import { AssetsAttachmentsController } from './assets-attachments.controller';
import { AssetsCommentsService } from './assets-comments.service';
import { AssetsCommentsController } from './assets-comments.controller';
import { AssetsLinksService } from './assets-links.service';
import { AssetsLinksController } from './assets-links.controller';
import { AssetsRelationsService } from './assets-relations.service';
import { AssetsRelationsController } from './assets-relations.controller';
import { AssetsSchemaCfService } from './assets-schema-cf.service';
import { AssetsSchemaCfController } from './assets-schema-cf.controller';

@Module({
  imports: [AutomationsModule, PermissionsModule],
  controllers: [
    AssetsSchemasController,
    AssetsItemsController,
    AssetsAttachmentsController,
    AssetsCommentsController,
    AssetsLinksController,
    AssetsRelationsController,
    AssetsSchemaCfController,
  ],
  providers: [
    AssetsHistoryService,
    AssetsSchemasService,
    AssetsItemsService,
    AssetsAttachmentsService,
    AssetsCommentsService,
    AssetsLinksService,
    AssetsRelationsService,
    AssetsSchemaCfService,
  ],
  exports: [AssetsSchemasService, AssetsItemsService],
})
export class AssetsModule {}
