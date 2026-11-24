import { InternalServerErrorException } from '@nestjs/common';
import { runControllerContractSuite } from '../test/controller-contract.helper';
import {
  HeatmapController,
  LegacyDashboardHeatmapController,
} from './heatmap.controller';

runControllerContractSuite({
  controller: HeatmapController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

runControllerContractSuite({
  controller: LegacyDashboardHeatmapController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('HeatmapController', () => {
  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    email: 'user@example.com',
    organizationId: 'org-1',
  };

  it('turns failed heatmap generation into the legacy HTTP failure path', async () => {
    const service = {
      generateHeatmapData: jest.fn().mockResolvedValue({
        success: false,
        error: 'Failed to fetch processes',
      }),
    };
    const controller = new HeatmapController(service as never);

    await expect(controller.generateGet(user, {})).rejects.toThrow(
      InternalServerErrorException,
    );
  });
});

describe('LegacyDashboardHeatmapController', () => {
  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    email: 'user@example.com',
    organizationId: 'org-1',
  };

  it('preserves the legacy /dashboard/heatmap query contract', async () => {
    const service = {
      generateHeatmapData: jest.fn().mockResolvedValue({
        success: true,
        heatMapData: { matrix: [] },
      }),
    };
    const controller = new LegacyDashboardHeatmapController(service as never);

    await controller.generateGet(user, {
      organizationId: 'ignored-org',
      matrixSize: '4',
      showIssueCount: 'false',
      requestTypes: 'Risk,Control',
      status: 'active,closed',
      coloringMode: 'individual-cells',
      cellFontSize: 'large',
      spaceId: 'space-1',
    });

    expect(service.generateHeatmapData).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      {
        matrixSize: 4,
        showIssueCount: false,
        title: 'ISMS Risk Assessment Matrix',
        requestTypes: ['Risk', 'Control'],
        status: ['active', 'closed'],
        coloringMode: 'individual-cells',
        cellFontSize: 'large',
        spaceId: 'space-1',
      },
    );
  });

  it('preserves the legacy /dashboard/risk-summary query contract', async () => {
    const service = {
      getRiskSummary: jest.fn().mockResolvedValue({
        success: true,
        riskSummary: [],
        totalRisks: 0,
      }),
    };
    const controller = new LegacyDashboardHeatmapController(service as never);

    await controller.riskSummary(user, {
      organizationId: 'ignored-org',
      requestTypes: 'Risk,Control',
      status: 'active,closed',
      spaceId: 'space-1',
    });

    expect(service.getRiskSummary).toHaveBeenCalledWith('org-1', 'user-1', {
      requestTypes: ['Risk', 'Control'],
      status: ['active', 'closed'],
      spaceId: 'space-1',
    });
  });

  it('turns failed generation into the old dashboard route failure path', async () => {
    const service = {
      generateHeatmapData: jest.fn().mockResolvedValue({
        success: false,
        error: 'Failed to fetch processes',
      }),
    };
    const controller = new LegacyDashboardHeatmapController(service as never);

    await expect(controller.generateGet(user, {})).rejects.toThrow(
      InternalServerErrorException,
    );
  });
});
