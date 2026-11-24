/**
 * @fileoverview NestJS module for the Assets Objects feature — object schemas,
 * hierarchical object-type tree, key-sequence counters, references, attachments,
 * comments, and change history.
 *
 * NAMING TRAP: this is the real **Assets** product (the CMDB), gated by
 * `@RequireFeature('module_assets')`. The sibling directory `src/assets/` is
 * despite its name the **Lists** module, gated by `module_lists`. The
 * `organization_modules` type `assets` and the `space_module_type` label
 * `assets` both refer to THIS module.
 *
 * SupabaseModule is @Global() so no explicit import needed here.
 * SpacePermissionsGuard is declared at controller class level via @UseGuards();
 * it does NOT need to be listed in providers — the guard is resolved from the
 * NestJS DI container automatically because PermissionsModule exports it.
 *
 * @module src/assets-objects/assets-objects.module
 */
import { Module } from '@nestjs/common';
import { AutomationsModule } from '../automations/automations.module';
import { PermissionsModule } from '../permissions/permissions.module';

import { AssetObjectSchemasService } from './asset-object-schemas.service';
import { AssetObjectTypesService } from './asset-object-types.service';
import { AssetObjectHistoryService } from './asset-object-history.service';
import { AssetObjectReferencesService } from './asset-object-references.service';
import { AssetObjectAttachmentsService } from './asset-object-attachments.service';
import { AssetObjectCommentsService } from './asset-object-comments.service';
import { AssetObjectTypeAttributesService } from './asset-object-type-attributes.service';
import { AssetObjectsService } from './asset-objects.service';
import { AssetObjectTaskLinksService } from './asset-object-task-links.service';
import { AssetObjectsImportService } from './asset-objects-import.service';
import { AssetObjectsExportService } from './asset-objects-export.service';
import { FindAssetObjectByNameAction } from './automation/find-asset-object-by-name.action';

import { AssetObjectSchemasController } from './asset-object-schemas.controller';
import { AssetObjectTypesController } from './asset-object-types.controller';
import { AssetObjectReferencesController } from './asset-object-references.controller';
import { AssetObjectAttachmentsController } from './asset-object-attachments.controller';
import { AssetObjectCommentsController } from './asset-object-comments.controller';
import { AssetObjectHistoryController } from './asset-object-history.controller';
import { AssetObjectTypeAttributesController } from './asset-object-type-attributes.controller';
import { AssetObjectsController } from './asset-objects.controller';
import { AssetObjectTaskLinksController } from './asset-object-task-links.controller';

@Module({
  imports: [PermissionsModule, AutomationsModule],
  controllers: [
    AssetObjectSchemasController,
    AssetObjectTypesController,
    AssetObjectReferencesController,
    AssetObjectAttachmentsController,
    AssetObjectCommentsController,
    AssetObjectHistoryController,
    AssetObjectTypeAttributesController,
    AssetObjectsController,
    AssetObjectTaskLinksController,
  ],
  providers: [
    AssetObjectSchemasService,
    AssetObjectHistoryService,
    AssetObjectTypesService,
    AssetObjectReferencesService,
    AssetObjectAttachmentsService,
    AssetObjectCommentsService,
    AssetObjectTypeAttributesService,
    AssetObjectsService,
    AssetObjectTaskLinksService,
    AssetObjectsImportService,
    AssetObjectsExportService,

    // Provider only — it self-registers with the automations ActionRegistryService on init.
    FindAssetObjectByNameAction,
  ],
  exports: [
    AssetObjectSchemasService,
    AssetObjectTypesService,
    AssetObjectHistoryService,
    AssetObjectReferencesService,
    AssetObjectAttachmentsService,
    AssetObjectCommentsService,
    AssetObjectTypeAttributesService,
    AssetObjectsService,
    AssetObjectTaskLinksService,
  ],
})
export class AssetsObjectsModule {}
