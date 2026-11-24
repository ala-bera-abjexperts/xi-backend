import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateWidgetDto } from './create-widget.dto';
import { UpdateWidgetDto } from './update-widget.dto';

describe('resource planning dashboard widget DTOs', () => {
  it('accepts resource_planning when creating a widget', async () => {
    const dto = plainToInstance(CreateWidgetDto, {
      widget_type: 'resource_planning',
      position: { x: 0, y: 0, w: 6, h: 4 },
      config: {
        bucket: 'week',
        groupBy: 'unit',
        dateFrom: '2026-08-01',
        dateTo: '2026-08-31',
      },
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('accepts changing an existing widget to resource_planning', async () => {
    const dto = plainToInstance(UpdateWidgetDto, {
      widget_type: 'resource_planning',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});
