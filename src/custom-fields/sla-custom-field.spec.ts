import { CustomFieldsService } from './custom-fields.service';
import { validateFieldValue } from './utils/custom-field-validation';
import { FIELD_TYPES } from './models/custom-field.model';
describe('computed SLA field boundaries', () => {
  const service = new CustomFieldsService({ getClient: () => ({}) } as any);
  it('includes type in shared create/update DTO enum', () =>
    expect(FIELD_TYPES).toContain('sla_time'));
  it.each([
    { field_type: 'sla_time', scope: 'organization' },
    {
      field_type: 'sla_time',
      scope: 'space',
      space_id: 's',
      contexts: ['wiki'],
    },
    { field_type: 'sla_time', scope: 'space', space_id: 's', default_value: 1 },
    {
      field_type: 'sla_time',
      scope: 'space',
      space_id: 's',
      validation_rules: { required: true },
    },
    {
      field_type: 'sla_time',
      scope: 'space',
      space_id: 's',
      validation_rules: { sla: {} },
    },
  ])('rejects unsafe definition before database call %j', async (input) => {
    await expect(
      service.create('o', 'u', { name: 'SLA', ...input } as any),
    ).rejects.toThrow();
  });
  it.each([null, undefined, 1, { elapsed_ms: 0 }])(
    'rejects computed values including clearing %j',
    (value) =>
      expect(() =>
        validateFieldValue(
          {
            field_type: 'sla_time',
            field_key: 'sla',
            name: 'SLA',
            validation_rules: {},
            options: [],
          },
          value,
        ),
      ).toThrow('server-computed'),
  );
});
