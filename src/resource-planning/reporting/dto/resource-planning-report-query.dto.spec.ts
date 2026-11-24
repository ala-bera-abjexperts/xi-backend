import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ResourcePlanningReportExportQueryDto,
  ResourcePlanningReportQueryDto,
} from './resource-planning-report-query.dto';

describe('ResourcePlanningReportQueryDto', () => {
  it('rejects array index strings as report enums', async () => {
    const query = Object.assign(new ResourcePlanningReportQueryDto(), {
      bucket: '0',
      group_by: '1',
    });
    const exportQuery = Object.assign(
      new ResourcePlanningReportExportQueryDto(),
      { format: '0' },
    );

    await expect(validate(query)).resolves.toHaveLength(2);
    await expect(validate(exportQuery)).resolves.toHaveLength(1);
  });

  it('accepts the documented report enum values', async () => {
    const query = Object.assign(new ResourcePlanningReportExportQueryDto(), {
      bucket: 'month',
      group_by: 'portfolio',
      format: 'pdf',
    });

    await expect(validate(query)).resolves.toHaveLength(0);
  });

  it('accepts a uuid space_id, treats an empty one as unset and rejects a non-uuid', async () => {
    const valid = plainToInstance(ResourcePlanningReportQueryDto, {
      space_id: '11111111-1111-4111-8111-111111111111',
    });
    const empty = plainToInstance(ResourcePlanningReportQueryDto, {
      space_id: '',
    });
    const invalid = plainToInstance(ResourcePlanningReportQueryDto, {
      space_id: 'not-a-uuid',
    });

    await expect(validate(valid)).resolves.toHaveLength(0);
    expect(empty.space_id).toBeUndefined();
    await expect(validate(empty)).resolves.toHaveLength(0);
    await expect(validate(invalid)).resolves.toHaveLength(1);
  });
});
