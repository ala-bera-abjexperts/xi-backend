// wiki-global.controller now transitively imports sanitize-rich-text (via
// wiki-search.service → wiki-mine.service → wiki-content.util), which pulls in
// jsdom (ESM) that ts-jest can't transform. Stub the sanitizer (identity).
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import { runControllerContractSuite } from '../test/controller-contract.helper';
import { WikiGlobalController } from './wiki-global.controller';

runControllerContractSuite({
  controller: WikiGlobalController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});
