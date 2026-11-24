import { BadRequestException } from '@nestjs/common';
import { AutomationConnectionsController } from './automation-connections.controller';
import type { IAutomationConnectionResponse } from './interfaces/automation.interface';

const mockConnectionResponse: IAutomationConnectionResponse = {
  id: 'conn-1',
  organization_id: 'org-1',
  space_id: 'space-1',
  provider: 'slack',
  display_name: 'Slack Workspace',
  external_account_id: 'T123',
  masked_secret: 'enc•••••',
  metadata: {},
  masked_metadata: {},
  is_revoked: false,
  last_used_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: 'user-1',
};

function createController() {
  const connectionsService = {
    listForSpace: jest.fn().mockResolvedValue([mockConnectionResponse]),
    revoke: jest.fn().mockResolvedValue(undefined),
  };
  return {
    controller: new AutomationConnectionsController(
      connectionsService as never,
    ),
    connectionsService,
  };
}

describe('AutomationConnectionsController', () => {
  describe('listConnections', () => {
    it('returns connections for a space', async () => {
      const { controller, connectionsService } = createController();
      const result = await controller.listConnections('space-1');
      expect(connectionsService.listForSpace).toHaveBeenCalledWith('space-1');
      expect(result).toEqual({ data: [mockConnectionResponse] });
    });

    it('throws BadRequestException when spaceId is missing', async () => {
      const { controller } = createController();
      await expect(controller.listConnections('')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('revokeConnection', () => {
    it('revokes connection and returns { data: { ok: true } }', async () => {
      const { controller, connectionsService } = createController();
      const result = await controller.revokeConnection('conn-1', 'space-1');
      expect(connectionsService.revoke).toHaveBeenCalledWith(
        'conn-1',
        'space-1',
      );
      expect(result).toEqual({ data: { ok: true } });
    });

    it('throws BadRequestException when spaceId is missing', async () => {
      const { controller } = createController();
      await expect(controller.revokeConnection('conn-1', '')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
