import { Module } from '@nestjs/common';

import { DocumentDesignerModule } from '../document-designer/document-designer.module';
import { SavedFiltersModule } from '../saved-filters/saved-filters.module';
import { FilterExportsController } from './filter-exports.controller';
import { FilterExportsService } from './filter-exports.service';

/**
 * Separate from SavedFiltersModule because DocumentDesignerModule, which owns the PDF renderer,
 * already imports SavedFiltersModule: rendering from inside it would be a module cycle.
 */
@Module({
  imports: [SavedFiltersModule, DocumentDesignerModule],
  controllers: [FilterExportsController],
  providers: [FilterExportsService],
})
export class FilterExportsModule {}
