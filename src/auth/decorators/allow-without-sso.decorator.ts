import { SetMetadata } from '@nestjs/common';

export const ALLOW_WITHOUT_SSO_KEY = 'auth:allow_without_sso';

export const AllowWithoutSso = () => SetMetadata(ALLOW_WITHOUT_SSO_KEY, true);
