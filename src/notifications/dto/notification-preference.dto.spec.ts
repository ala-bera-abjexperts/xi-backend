import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpsertNotificationPreferenceDto } from './notification-preference.dto';

describe('UpsertNotificationPreferenceDto', () => {
  it('accepts watcher_updates as a notification preference type', async () => {
    const dto = plainToInstance(UpsertNotificationPreferenceDto, {
      notification_type: 'watcher_updates',
      in_app: false,
      email: true,
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each(['chat_mention', 'chat_dm'])(
    'accepts %s as a notification preference type',
    async (notification_type) => {
      const dto = plainToInstance(UpsertNotificationPreferenceDto, {
        notification_type,
        email: false,
      });

      await expect(validate(dto)).resolves.toHaveLength(0);
    },
  );

  it('still rejects an unknown type', async () => {
    const dto = plainToInstance(UpsertNotificationPreferenceDto, {
      notification_type: 'chat_summary',
      in_app: false,
    });

    await expect(validate(dto)).resolves.toHaveLength(1);
  });
});
