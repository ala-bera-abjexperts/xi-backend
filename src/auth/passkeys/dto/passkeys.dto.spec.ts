import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  RenamePasskeyDto,
  VerifyPasskeyAuthenticationDto,
  VerifyPasskeyRegistrationDto,
} from './passkeys.dto';

describe('passkey DTOs', () => {
  const credential = {
    id: 'credential-id',
    rawId: 'credential-id',
    type: 'public-key',
    authenticatorAttachment: 'platform',
    clientExtensionResults: {},
    response: {
      clientDataJSON: 'client-data',
      authenticatorData: 'authenticator-data',
      signature: 'signature',
      userHandle: 'user-handle',
    },
  };

  it('accepts the complete SimpleWebAuthn authentication JSON shape', async () => {
    const dto = plainToInstance(VerifyPasskeyAuthenticationDto, {
      challengeId: '11111111-1111-4111-8111-111111111111',
      credential,
    });

    await expect(
      validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).resolves.toHaveLength(0);
  });

  it('rejects unrecognized credential fields and oversized extensions', async () => {
    const dto = plainToInstance(VerifyPasskeyAuthenticationDto, {
      challengeId: '11111111-1111-4111-8111-111111111111',
      credential: {
        ...credential,
        attackerControlled: true,
        clientExtensionResults: { blob: 'x'.repeat(20 * 1024) },
      },
    });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors).not.toHaveLength(0);
  });

  it('requires a non-blank friendly name for registration and rename', async () => {
    const registration = plainToInstance(VerifyPasskeyRegistrationDto, {
      challengeId: '11111111-1111-4111-8111-111111111111',
      friendlyName: '   ',
      credential,
    });
    const rename = plainToInstance(RenamePasskeyDto, {
      friendlyName: '\t',
    });

    await expect(validate(registration)).resolves.not.toHaveLength(0);
    await expect(validate(rename)).resolves.not.toHaveLength(0);
  });
});
