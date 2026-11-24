/**
 * @fileoverview Unit tests for HeatmapService — config CRUD/upsert/reset,
 * heatmap data generation including the empty-dataset edge case, and the
 * grouped risk summary aggregation.
 * @module src/heatmap/heatmap.service.spec
 * @author Prince Jadiya
 */

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { HeatmapService } from './heatmap.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('HeatmapService', () => {
  let service: HeatmapService;
  let mockFrom: jest.Mock;
  let mockPermissionsService: {
    isAdminOrOwner: jest.Mock;
    checkPermission: jest.Mock;
    getUserSpacePermissions: jest.Mock;
  };

  const ORG = 'org-1';
  const USER = 'user-1';

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.upsert = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    mockPermissionsService = {
      isAdminOrOwner: jest.fn().mockResolvedValue(true),
      checkPermission: jest.fn().mockResolvedValue(true),
      getUserSpacePermissions: jest.fn().mockResolvedValue({
        isMember: true,
        permissions: { view_dashboards: true },
      }),
    };
    service = new HeatmapService(supa, mockPermissionsService as never);
  });

  // ── Heatmap Configuration ─────────────────────────────────────────────

  describe('getConfig', () => {
    it('returns a custom config when one exists', async () => {
      const stored = {
        id: 'cfg-1',
        organization_id: ORG,
        title: 'Custom matrix',
        matrix_size: 5,
      };
      mockFrom.mockReturnValue(buildChain({ data: stored, error: null }));

      const r = await service.getConfig(ORG);

      expect(r.isDefault).toBe(false);
      expect(r.config).toEqual(stored);
    });

    it('returns the default config (isDefault=true) when PGRST116 / no row', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { code: 'PGRST116' } }),
      );

      const r = await service.getConfig(ORG);

      expect(r.isDefault).toBe(true);
      expect(r.config['matrix_size']).toBe(5);
    });

    it('throws BadRequest on non-PGRST116 errors', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: null,
          error: { code: '42P01', message: 'relation missing' },
        }),
      );
      await expect(service.getConfig(ORG)).rejects.toThrow(BadRequestException);
    });
  });

  describe('createConfig', () => {
    it('inserts and returns the new configuration', async () => {
      const created = { id: 'cfg-1', organization_id: ORG, matrix_size: 5 };
      mockFrom.mockReturnValue(buildChain({ data: created, error: null }));

      const r = await service.createConfig(ORG, USER, {
        title: 'My matrix',
      } as never);

      expect(r.config).toEqual(created);
    });

    it('throws BadRequest on insert error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'fail' } }),
      );
      await expect(
        service.createConfig(ORG, USER, {} as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('upsertConfig', () => {
    it('upserts and returns the new configuration', async () => {
      const upserted = { id: 'cfg-1', organization_id: ORG };
      mockFrom.mockReturnValue(buildChain({ data: upserted, error: null }));

      const r = await service.upsertConfig(ORG, USER, {
        title: 'Updated',
      } as never);
      expect(r.config).toEqual(upserted);
    });

    it('ignores trusted scope fields from legacy payloads', async () => {
      const upserted = { id: 'cfg-1', organization_id: ORG };
      const chain = buildChain({ data: upserted, error: null });
      mockFrom.mockReturnValue(chain);

      await service.upsertConfig(ORG, USER, {
        organizationId: '11111111-1111-4111-8111-111111111111',
        organization_id: 'evil-org',
        created_by: 'evil-user',
        updated_by: 'evil-user',
        title: 'Trusted update',
      } as never);

      expect(chain.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          organization_id: ORG,
          updated_by: USER,
          title: 'Trusted update',
        }),
        { onConflict: 'organization_id' },
      );
      expect(chain.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({
          created_by: 'evil-user',
        }),
        expect.anything(),
      );
    });

    it('throws BadRequest on upsert error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'conflict' } }),
      );
      await expect(
        service.upsertConfig(ORG, USER, {} as never),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('deleteConfig', () => {
    it('deletes the row and returns success', async () => {
      mockFrom.mockReturnValue(buildChain({ data: null, error: null }));

      const r = await service.deleteConfig(ORG);
      expect(r).toEqual({
        success: true,
        message: 'Configuration reset to default',
      });
    });

    it('throws BadRequest on delete error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'fail' } }),
      );
      await expect(service.deleteConfig(ORG)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects config writes without dashboard edit permission', async () => {
      mockPermissionsService.isAdminOrOwner.mockResolvedValue(false);
      mockPermissionsService.checkPermission.mockResolvedValue(false);

      await expect(
        service.upsertConfig(ORG, USER, { title: 'Denied' } as never),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ── Heatmap Data Generation ───────────────────────────────────────────

  describe('generateHeatmapData', () => {
    it('returns an empty matrix when no processes match', async () => {
      mockFrom.mockReturnValue(buildChain({ data: [], error: null }));

      const r = await service.generateHeatmapData(ORG, {
        matrixSize: 5,
      } as never);

      expect(r['success']).toBe(true);
      const heatMap = r['heatMapData'] as { stats: Record<string, number> };
      expect(heatMap.stats.totalProcessed).toBe(0);
      expect(heatMap.stats.emptyCells).toBe(25);
    });

    it('checks space dashboard access before generating scoped heatmaps', async () => {
      mockPermissionsService.isAdminOrOwner.mockResolvedValue(false);
      mockFrom.mockReturnValue(buildChain({ data: [], error: null }));

      await service.generateHeatmapData(ORG, USER, {
        matrixSize: 5,
        spaceId: 'space-1',
      } as never);

      expect(
        mockPermissionsService.getUserSpacePermissions,
      ).toHaveBeenCalledWith(USER, ORG, 'space-1');
    });

    it('generates matrix entries for processes with valid CIA values', async () => {
      const processes = [
        {
          id: 'p-1',
          title: 'Risk A',
          description: null,
          request_type: 'Risiko',
          vuln_c_p: 5,
          vuln_c_i: 5,
          vuln_i_p: 0,
          vuln_i_i: 0,
          vuln_a_p: 0,
          vuln_a_i: 0,
        },
      ];
      mockFrom.mockReturnValue(buildChain({ data: processes, error: null }));

      const r = await service.generateHeatmapData(ORG, {
        matrixSize: 5,
      } as never);

      expect(r['success']).toBe(true);
      const heatMap = r['heatMapData'] as { stats: { totalProcessed: number } };
      expect(heatMap.stats.totalProcessed).toBeGreaterThan(0);
    });

    it('catches and reports DB errors as { success:false, error }', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'db down' } }),
      );

      const r = await service.generateHeatmapData(ORG, {
        matrixSize: 5,
      } as never);

      expect(r['success']).toBe(false);
      expect(typeof r['error']).toBe('string');
    });
  });

  // ── Risk Summary ──────────────────────────────────────────────────────

  describe('getRiskSummary', () => {
    it('groups processes into risk buckets sorted by probability×impact', async () => {
      const processes = [
        {
          id: 'p-1',
          title: 'Critical',
          description: null,
          request_type: 'Risiko',
          vuln_c_p: 5,
          vuln_c_i: 5,
          vuln_i_p: 5,
          vuln_i_i: 5,
          vuln_a_p: 5,
          vuln_a_i: 5,
        },
        {
          id: 'p-2',
          title: 'Low',
          description: null,
          request_type: 'Risiko',
          vuln_c_p: 1,
          vuln_c_i: 1,
          vuln_i_p: 1,
          vuln_i_i: 1,
          vuln_a_p: 1,
          vuln_a_i: 1,
        },
      ];
      mockFrom.mockReturnValueOnce(
        buildChain({ data: processes, error: null }),
      );

      const r = await service.getRiskSummary(ORG, {});

      expect(r.success).toBe(true);
      expect(r.totalRisks).toBeGreaterThan(0);
      // Sorted by probability×impact desc — first entry should be the worst
      const first = r.riskSummary[0] as {
        maxProbability: number;
        maxImpact: number;
      };
      const last = r.riskSummary[r.riskSummary.length - 1] as {
        maxProbability: number;
        maxImpact: number;
      };
      expect(first.maxProbability * first.maxImpact).toBeGreaterThanOrEqual(
        last.maxProbability * last.maxImpact,
      );
    });

    it('keeps legacy impact bucket value as grossFinancialImpact', async () => {
      const processes = [
        {
          id: 'p-1',
          title: 'X',
          description: null,
          request_type: 'Risiko',
          vuln_c_p: 5,
          vuln_c_i: 5,
          vuln_i_p: 0,
          vuln_i_i: 0,
          vuln_a_p: 0,
          vuln_a_i: 0,
        },
      ];
      mockFrom.mockReturnValueOnce(
        buildChain({ data: processes, error: null }),
      );

      const r = await service.getRiskSummary(ORG, {});

      expect(r.success).toBe(true);
      const top = r.riskSummary[0] as { grossFinancialImpact: number };
      expect(top.grossFinancialImpact).toBe(5);
    });

    it('skips processes whose CIA values yield 0 probability or impact', async () => {
      const processes = [
        {
          id: 'p-zero',
          title: 'Zero',
          description: null,
          request_type: 'Risiko',
          vuln_c_p: 0,
          vuln_c_i: 0,
          vuln_i_p: 0,
          vuln_i_i: 0,
          vuln_a_p: 0,
          vuln_a_i: 0,
        },
      ];
      mockFrom.mockReturnValueOnce(
        buildChain({ data: processes, error: null }),
      );

      const r = await service.getRiskSummary(ORG, {});
      // p-zero is filtered out by hasValidCIAValues so totalRisks is 0
      expect(r.totalRisks).toBe(0);
    });
  });
});
