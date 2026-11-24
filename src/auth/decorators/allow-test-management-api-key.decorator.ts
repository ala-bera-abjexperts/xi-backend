import { SetMetadata } from '@nestjs/common';

export const ALLOW_TM_API_KEY = 'allowTestManagementApiKey';

// Opts a route or controller in to Test Management API keys; every other route rejects them.
export const AllowTestManagementApiKey = () =>
  SetMetadata(ALLOW_TM_API_KEY, true);
