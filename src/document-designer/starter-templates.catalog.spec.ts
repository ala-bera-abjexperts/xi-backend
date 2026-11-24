import {
  DOCUMENT_STARTER_TEMPLATES,
  findStarterTemplate,
} from './starter-templates.catalog';
import { documentTemplateDefinitionSchema } from './template-definition/template-definition.schema';

describe('DOCUMENT_STARTER_TEMPLATES', () => {
  it('has unique keys', () => {
    const keys = DOCUMENT_STARTER_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(DOCUMENT_STARTER_TEMPLATES.map((t) => [t.key, t] as const))(
    '%s: definition passes documentTemplateDefinitionSchema',
    (_key, entry) => {
      expect(() =>
        documentTemplateDefinitionSchema.parse(entry.definition),
      ).not.toThrow();
    },
  );

  it.each(DOCUMENT_STARTER_TEMPLATES.map((t) => [t.key, t] as const))(
    '%s: source_entity and mode match the definition',
    (_key, entry) => {
      expect(entry.source_entity).toBe(entry.definition.sourceEntity);
      expect(entry.mode).toBe(entry.definition.mode);
    },
  );

  describe('findStarterTemplate', () => {
    it('finds an entry by key', () => {
      expect(findStarterTemplate('task-report')?.name).toBe('Task Report');
    });

    it('returns undefined for an unknown key', () => {
      expect(findStarterTemplate('nope')).toBeUndefined();
    });
  });
});
