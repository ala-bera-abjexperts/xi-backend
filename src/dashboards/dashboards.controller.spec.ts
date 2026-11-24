import { runControllerContractSuite } from '../test/controller-contract.helper';
import { DashboardsController } from './dashboards.controller';
import { InternalServerErrorException } from '@nestjs/common';

runControllerContractSuite({
  controller: DashboardsController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
});

describe('DashboardsController dashboard companion analytics compatibility', () => {
  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    email: 'user@example.com',
    organizationId: 'org-1',
  };

  it('delegates /dashboards/heatmap to the legacy-compatible heatmap service', async () => {
    const dashboardService = {
      getHeatmapData: jest.fn(),
    };
    const heatmapService = {
      generateHeatmapData: jest.fn().mockResolvedValue({
        success: true,
        heatMapData: { matrix: [] },
      }),
    };
    const controller = new (DashboardsController as unknown as new (
      dashboardService: unknown,
      heatmapService: unknown,
    ) => DashboardsController)(dashboardService, heatmapService);

    await controller.getHeatmap(user, {
      organizationId: 'org-ignored',
      matrixSize: '4',
      showIssueCount: 'false',
      title: 'Custom heatmap',
      requestTypes: 'Risiko,Maßnahme',
      status: 'active,closed',
      coloringMode: 'individual-cells',
      cellFontSize: 'large',
      spaceId: 'space-1',
    });

    expect(heatmapService.generateHeatmapData).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      {
        matrixSize: 4,
        showIssueCount: false,
        title: 'Custom heatmap',
        requestTypes: ['Risiko', 'Maßnahme'],
        status: ['active', 'closed'],
        coloringMode: 'individual-cells',
        cellFontSize: 'large',
        spaceId: 'space-1',
      },
    );
    expect(dashboardService.getHeatmapData).not.toHaveBeenCalled();
  });

  it('supports POST /dashboards/heatmap with the legacy nested config body', async () => {
    const dashboardService = {};
    const heatmapService = {
      generateHeatmapData: jest.fn().mockResolvedValue({
        success: true,
        heatMapData: { matrix: [] },
      }),
    };
    const controller = new (DashboardsController as unknown as new (
      dashboardService: unknown,
      heatmapService: unknown,
    ) => DashboardsController)(dashboardService, heatmapService);

    await (
      controller as unknown as {
        generateHeatmapPost: (
          userArg: typeof user,
          bodyArg: Record<string, unknown>,
        ) => Promise<unknown>;
      }
    ).generateHeatmapPost(user, {
      organizationId: 'org-ignored',
      config: {
        matrixSize: 3,
        requestTypes: ['Risiko'],
        status: ['active'],
        spaceId: 'space-1',
      },
    });

    expect(heatmapService.generateHeatmapData).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      {
        matrixSize: 3,
        requestTypes: ['Risiko'],
        status: ['active'],
        spaceId: 'space-1',
      },
    );
  });

  it('delegates /dashboards/risk-summary to the legacy-compatible heatmap summary', async () => {
    const dashboardService = {
      getRiskSummary: jest.fn(),
    };
    const heatmapService = {
      getRiskSummary: jest.fn().mockResolvedValue({
        success: true,
        riskSummary: [],
        totalRisks: 0,
      }),
    };
    const controller = new (DashboardsController as unknown as new (
      dashboardService: unknown,
      heatmapService: unknown,
    ) => DashboardsController)(dashboardService, heatmapService);

    await controller.getRiskSummary(user, {
      organizationId: 'org-ignored',
      requestTypes: 'Risiko,Maßnahme',
      status: 'active,closed',
      spaceId: 'space-1',
    });

    expect(heatmapService.getRiskSummary).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      {
        requestTypes: ['Risiko', 'Maßnahme'],
        status: ['active', 'closed'],
        spaceId: 'space-1',
      },
    );
    expect(dashboardService.getRiskSummary).not.toHaveBeenCalled();
  });

  it('throws a 500 when the legacy heatmap generator reports failure', async () => {
    const dashboardService = {};
    const heatmapService = {
      generateHeatmapData: jest.fn().mockResolvedValue({
        success: false,
        error: 'Heatmap query failed',
      }),
    };
    const controller = new (DashboardsController as unknown as new (
      dashboardService: unknown,
      heatmapService: unknown,
    ) => DashboardsController)(dashboardService, heatmapService);

    await expect(
      controller.getHeatmap(user, {
        organizationId: 'org-ignored',
      }),
    ).rejects.toThrow(InternalServerErrorException);
  });
});
