export const PASSKEY_SESSION_ASSURANCE = Symbol('PASSKEY_SESSION_ASSURANCE');

export interface PasskeySessionAssuranceInput {
  accessToken: string;
  authUserId: string;
  sessionId: string;
}

export interface PasskeySessionAssuranceReader {
  isSessionAssured(input: PasskeySessionAssuranceInput): Promise<boolean>;
  countVerifiedPasskeys?(authUserId: string): Promise<number>;
  revokeTrustedDevices?(authUserId: string): Promise<void>;
}
