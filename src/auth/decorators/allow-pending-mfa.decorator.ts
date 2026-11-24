import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_MFA_KEY = 'auth:allow_pending_mfa';

export const AllowPendingMfa = () => SetMetadata(ALLOW_PENDING_MFA_KEY, true);
