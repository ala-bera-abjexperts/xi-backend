import { BadRequestException } from '@nestjs/common';
import { runControllerContractSuite } from '../test/controller-contract.helper';
import { InvitationsController } from './invitations.controller';

runControllerContractSuite({
  controller: InvitationsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('InvitationsController manual behavior', () => {
  const user = {
    userId: 'user-1',
    organizationId: 'org-1',
  };

  function setup() {
    const invitationsService = {
      createOrgInvitation: jest.fn(),
      listInvitations: jest.fn(),
      getByToken: jest.fn(),
      acceptInvitation: jest.fn(),
      resendInvitation: jest.fn(),
      revokeInvitation: jest.fn(),
      deleteInvitation: jest.fn(),
    };
    const mailService = { sendInvitation: jest.fn() };
    const controller = new InvitationsController(
      invitationsService as any,
      mailService as any,
      { get: jest.fn().mockReturnValue('http://localhost:3000') } as any,
    );
    return { controller, invitationsService, mailService };
  }

  it('defaults created invitations to member and sends an email', async () => {
    const { controller, invitationsService, mailService } = setup();
    invitationsService.createOrgInvitation.mockResolvedValue({
      invitationLink: 'https://app.test/invite',
      organizationName: 'Acme',
      invitation: { id: 'inv-1', expires_at: '2026-01-01T00:00:00.000Z' },
    });

    await expect(
      controller.createInvitation(
        user as any,
        {
          email: 'new@example.com',
          firstName: 'New',
          lastName: 'User',
        } as any,
      ),
    ).resolves.toEqual({
      message: 'Invitation sent successfully',
      invitation: {
        id: 'inv-1',
        email: 'new@example.com',
        role: 'member',
        organization: 'Acme',
        expires_at: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(invitationsService.createOrgInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        invitedByUserId: 'user-1',
        role: 'member',
      }),
    );
    expect(mailService.sendInvitation).toHaveBeenCalledWith(
      'new@example.com',
      expect.objectContaining({ role: 'member' }),
    );
  });

  it('maps an invitation email send failure to 503 email_send_failed (invitation row kept)', async () => {
    const { controller, invitationsService, mailService } = setup();
    invitationsService.createOrgInvitation.mockResolvedValue({
      invitationLink: 'https://app.test/invite',
      organizationName: 'Acme',
      invitation: { id: 'inv-1', expires_at: '2026-01-01T00:00:00.000Z' },
    });
    mailService.sendInvitation.mockRejectedValue(
      Object.assign(new Error('unable to verify the first certificate'), {
        code: 'ESOCKET',
      }),
    );

    await expect(
      controller.createInvitation(
        user as any,
        { email: 'new@example.com', firstName: 'New', lastName: 'User' } as any,
      ),
    ).rejects.toMatchObject({
      status: 503,
      response: { code: 'email_send_failed' },
    });
  });

  it('parses invitation pagination defaults and unwraps data metadata', async () => {
    const { controller, invitationsService } = setup();
    invitationsService.listInvitations.mockResolvedValue({
      data: [{ id: 'inv-1' }],
      total: 1,
      page: 1,
    });

    await expect(
      controller.listInvitations(user as any, undefined, undefined),
    ).resolves.toEqual({ data: [{ id: 'inv-1' }], total: 1, page: 1 });
    expect(invitationsService.listInvitations).toHaveBeenCalledWith(
      'org-1',
      1,
      50,
    );
  });

  it('requires a token for public token lookup', async () => {
    const { controller, invitationsService } = setup();

    await expect(controller.getByToken('')).rejects.toThrow(
      BadRequestException,
    );
    expect(invitationsService.getByToken).not.toHaveBeenCalled();
  });

  it('accepts invitations with optional password and sets cookies when tokens are returned', async () => {
    const { controller, invitationsService } = setup();
    const res = { cookie: jest.fn() };

    invitationsService.acceptInvitation.mockResolvedValue({
      success: true,
      tokens: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      },
    });

    await expect(
      controller.acceptInvitation(
        'inv-1',
        { token: 'tok', password: 'Admin@123' } as any,
        res as any,
      ),
    ).resolves.toEqual({
      success: true,
      // Fresh accept: the controller normalises the service's absent
      // `alreadyAccepted` to false, and passes `organization` straight
      // through (undefined here — this service double models the documented
      // org-lookup-failed path, where the field is omitted).
      alreadyAccepted: false,
      organization: undefined,
    });
    expect(invitationsService.acceptInvitation).toHaveBeenCalledWith(
      'inv-1',
      'tok',
      'Admin@123',
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      'access-token',
      expect.objectContaining({ httpOnly: true, path: '/' }),
    );
  });

  it('resends invitations with stored invitee details', async () => {
    const { controller, invitationsService, mailService } = setup();
    invitationsService.resendInvitation.mockResolvedValue({
      invitationLink: 'https://app.test/invite-again',
      organizationName: 'Acme',
      invitation: {
        email: 'existing@example.com',
        first_name: 'Existing',
        last_name: 'User',
        role: 'admin',
      },
    });

    await expect(
      controller.resendInvitation('inv-1', user as any),
    ).resolves.toEqual({ message: 'Invitation resent successfully' });
    expect(invitationsService.resendInvitation).toHaveBeenCalledWith(
      'inv-1',
      'org-1',
    );
    expect(mailService.sendInvitation).toHaveBeenCalledWith(
      'existing@example.com',
      expect.objectContaining({ role: 'admin' }),
    );
  });

  it('revokes invitations in the current organization', async () => {
    const { controller, invitationsService } = setup();
    invitationsService.revokeInvitation.mockResolvedValue({
      id: 'inv-1',
      status: 'revoked',
    });

    await expect(
      controller.revokeInvitation('inv-1', user as any),
    ).resolves.toEqual({
      id: 'inv-1',
      status: 'revoked',
    });
    expect(invitationsService.revokeInvitation).toHaveBeenCalledWith(
      'inv-1',
      'org-1',
      'user-1',
    );
  });
});
