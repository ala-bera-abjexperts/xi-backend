/**
 * @fileoverview Unit tests for the PreferencesService covering recent items,
 * sidebar preferences, and starred spaces operations.
 * @module src/users/preferences.service.spec
 * @author Prince Jadiya
 */

import { InternalServerErrorException } from '@nestjs/common';
import { PreferencesService } from './preferences.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('PreferencesService', () => {
  let service: PreferencesService;
  let mockFrom: jest.Mock;

  /**
   * Helper to build a chainable Supabase query mock (same pattern as spaces tests).
   */
  function buildChain(resolvedValue: { data: unknown; error: unknown }) {
    const chain: Record<string, jest.Mock> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockResolvedValue(resolvedValue);
    chain.single = jest.fn().mockResolvedValue(resolvedValue);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolvedValue);
    return chain;
  }

  /**
   * Builds an ISO timestamp N calendar days before today at local noon.
   * Anchoring to noon keeps the value inside the intended calendar day even
   * across DST shifts, so the time-group assertions stay deterministic.
   */
  function daysAgoIso(days: number): string {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - days);
    return d.toISOString();
  }

  beforeEach(() => {
    mockFrom = jest.fn();

    const supabaseAdmin = {
      getClient: () => ({
        from: mockFrom,
      }),
    } as unknown as SupabaseAdminService;

    service = new PreferencesService(supabaseAdmin, {
      logAction: jest.fn().mockResolvedValue(undefined),
    } as never);
  });

  // ── Recent Items ─────────────────────────────────────────────────────────

  describe('getRecentItems', () => {
    it('should return recent items ordered by accessed_at desc', async () => {
      // Ordering itself is delegated to the DB, so the rows arrive newest
      // first and the service preserves that order within each time group.
      const items = [
        {
          id: '1',
          item_type: 'space',
          item_name: 'Space A',
          accessed_at: daysAgoIso(0),
        },
        {
          id: '2',
          item_type: 'page',
          item_name: 'Page B',
          accessed_at: daysAgoIso(1),
        },
      ];
      const chain = buildChain({ data: items, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.getRecentItems('user-1', 'org-1');

      // Results are grouped by time period, in newest-group-first order.
      expect(result).toEqual([
        { group: 'today', label: 'Today', items: [items[0]] },
        { group: 'yesterday', label: 'Yesterday', items: [items[1]] },
      ]);
      expect(mockFrom).toHaveBeenCalledWith('user_recent_items');
      expect(chain.select).toHaveBeenCalledWith('*');
      expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-1');
      expect(chain.eq).toHaveBeenCalledWith('organization_id', 'org-1');
      expect(chain.order).toHaveBeenCalledWith('accessed_at', {
        ascending: false,
      });
    });

    it('should apply item_type filter when provided', async () => {
      const items = [
        {
          id: '1',
          item_type: 'space',
          item_name: 'Space A',
          accessed_at: daysAgoIso(0),
        },
      ];
      const chain = buildChain({ data: items, error: null });
      chain.limit.mockResolvedValue({ data: items, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.getRecentItems(
        'user-1',
        'org-1',
        10,
        'space',
      );

      expect(result).toEqual([
        { group: 'today', label: 'Today', items: [items[0]] },
      ]);
      expect(chain.eq).toHaveBeenCalledWith('item_type', 'space');
      expect(chain.limit).toHaveBeenCalledWith(10);
    });

    it('should return empty array when no items exist', async () => {
      const chain = buildChain({ data: null, error: null });
      chain.limit.mockResolvedValue({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.getRecentItems('user-1', 'org-1');

      expect(result).toEqual([]);
    });

    it('should throw InternalServerErrorException on db error', async () => {
      const chain = buildChain({ data: null, error: { message: 'DB error' } });
      chain.limit.mockResolvedValue({
        data: null,
        error: { message: 'DB error' },
      });
      mockFrom.mockReturnValue(chain);

      await expect(service.getRecentItems('user-1', 'org-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('trackAccess', () => {
    const trackData = {
      item_type: 'space',
      item_id: '550e8400-e29b-41d4-a716-446655440000',
      item_name: 'Project Alpha',
    };

    it('should insert a new recent item when none exists', async () => {
      // First call: find existing -> null
      const findChain = buildChain({ data: null, error: null });
      // Second call: insert -> new record
      const inserted = { id: 'new-1', ...trackData };
      const insertChain = buildChain({ data: inserted, error: null });

      mockFrom.mockReturnValueOnce(findChain).mockReturnValueOnce(insertChain);

      const result = await service.trackAccess('user-1', 'org-1', trackData);

      expect(result).toEqual(inserted);
      expect(mockFrom).toHaveBeenCalledWith('user_recent_items');
    });

    it('should update an existing recent item', async () => {
      // First call: find existing -> found
      const findChain = buildChain({
        data: { id: 'existing-1' },
        error: null,
      });
      // Second call: update -> updated record
      const updated = { id: 'existing-1', ...trackData };
      const updateChain = buildChain({ data: updated, error: null });

      mockFrom.mockReturnValueOnce(findChain).mockReturnValueOnce(updateChain);

      const result = await service.trackAccess('user-1', 'org-1', trackData);

      expect(result).toEqual(updated);
    });

    it('should throw InternalServerErrorException when find fails', async () => {
      const findChain = buildChain({
        data: null,
        error: { message: 'DB error' },
      });
      mockFrom.mockReturnValue(findChain);

      await expect(
        service.trackAccess('user-1', 'org-1', trackData),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw InternalServerErrorException when insert fails', async () => {
      const findChain = buildChain({ data: null, error: null });
      const insertChain = buildChain({
        data: null,
        error: { message: 'Insert error' },
      });

      mockFrom.mockReturnValueOnce(findChain).mockReturnValueOnce(insertChain);

      await expect(
        service.trackAccess('user-1', 'org-1', trackData),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw InternalServerErrorException when update fails', async () => {
      const findChain = buildChain({
        data: { id: 'existing-1' },
        error: null,
      });
      const updateChain = buildChain({
        data: null,
        error: { message: 'Update error' },
      });

      mockFrom.mockReturnValueOnce(findChain).mockReturnValueOnce(updateChain);

      await expect(
        service.trackAccess('user-1', 'org-1', trackData),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('clearAllRecentItems', () => {
    it('should delete all recent items for the user', async () => {
      const chain = buildChain({ data: null, error: null });
      // delete().eq() resolves directly (not via .single/.maybeSingle)
      chain.eq.mockResolvedValue({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.clearAllRecentItems('user-1');

      expect(result).toEqual({
        success: true,
        message: 'Recent items cleared',
      });
      expect(mockFrom).toHaveBeenCalledWith('user_recent_items');
    });

    it('should throw InternalServerErrorException on db error', async () => {
      const chain = buildChain({ data: null, error: null });
      chain.eq.mockResolvedValue({
        data: null,
        error: { message: 'DB error' },
      });
      mockFrom.mockReturnValue(chain);

      await expect(service.clearAllRecentItems('user-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('deleteRecentItem', () => {
    it('should delete a specific recent item', async () => {
      const chain = buildChain({ data: null, error: null });
      chain.eq.mockReturnValue(chain);
      // The final .eq in the chain resolves
      chain.eq.mockImplementation(() => chain);
      // Make the chain thenable for the final await
      (chain as Record<string, unknown>).then = (
        resolve: (v: unknown) => void,
      ) => {
        resolve({ data: null, error: null });
        return chain;
      };
      mockFrom.mockReturnValue(chain);

      const result = await service.deleteRecentItem(
        'user-1',
        'space',
        'item-1',
      );

      expect(result).toEqual({
        success: true,
        message: 'Recent item removed',
      });
    });

    it('should throw InternalServerErrorException on db error', async () => {
      const chain = buildChain({ data: null, error: null });
      chain.eq.mockImplementation(() => chain);
      (chain as Record<string, unknown>).then = (
        resolve: (v: unknown) => void,
      ) => {
        resolve({ data: null, error: { message: 'DB error' } });
        return chain;
      };
      mockFrom.mockReturnValue(chain);

      await expect(
        service.deleteRecentItem('user-1', 'space', 'item-1'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  // ── Sidebar Preferences ──────────────────────────────────────────────────

  describe('getSidebarPreferences', () => {
    it('should return sidebar preferences when they exist', async () => {
      // Saved prefs include all current default section ids so the merge logic
      // (which back-fills sections added after the user saved) has nothing to
      // add and the record passes through unchanged.
      const prefs = {
        id: 'pref-1',
        user_id: 'user-1',
        config: {
          sections: [
            { id: 'for_you', visible: true, order: 0 },
            { id: 'recent', visible: true, order: 1 },
            { id: 'starred', visible: true, order: 2 },
            { id: 'apps', visible: false, order: 3 },
            { id: 'plans', visible: false, order: 4 },
            { id: 'spaces', visible: true, order: 5 },
            { id: 'filters', visible: true, order: 6 },
            { id: 'dashboards', visible: true, order: 7 },
            { id: 'site_studio', visible: true, order: 8 },
            { id: 'portfolios', visible: true, order: 9 },
            { id: 'test_management', visible: true, order: 9 },
            { id: 'operations', visible: false, order: 10 },
            { id: 'external_links', visible: false, order: 11 },
            { id: 'settings', visible: true, order: 12 },
          ],
          spaces_expanded: false,
        },
      };
      const chain = buildChain({ data: prefs, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.getSidebarPreferences('user-1');

      expect(result).toEqual(prefs);
    });

    it('should return defaults when no preferences exist', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.getSidebarPreferences('user-1');

      expect(result).toEqual({
        config: {
          sections: [
            { id: 'for_you', visible: true, order: 0 },
            { id: 'recent', visible: true, order: 1 },
            { id: 'starred', visible: true, order: 2 },
            { id: 'apps', visible: false, order: 3 },
            { id: 'plans', visible: false, order: 4 },
            { id: 'spaces', visible: true, order: 5 },
            { id: 'filters', visible: true, order: 6 },
            { id: 'dashboards', visible: true, order: 7 },
            { id: 'site_studio', visible: true, order: 8 },
            { id: 'portfolios', visible: true, order: 9 },
            { id: 'test_management', visible: true, order: 9 },
            { id: 'operations', visible: false, order: 10 },
            { id: 'external_links', visible: false, order: 11 },
            { id: 'settings', visible: true, order: 12 },
          ],
          externalLinks: [],
          spacesExpanded: true,
          recentItemsCount: 10,
        },
      });
    });

    it('should throw InternalServerErrorException on db error', async () => {
      const chain = buildChain({
        data: null,
        error: { message: 'DB error' },
      });
      mockFrom.mockReturnValue(chain);

      await expect(service.getSidebarPreferences('user-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('updateSidebarPreferences', () => {
    const updateData = { spaces_expanded: false, recent_items_count: 10 };

    it('should update existing sidebar preferences', async () => {
      // First call: find existing
      const findChain = buildChain({
        data: {
          id: 'pref-1',
          config: {
            sections: ['spaces', 'recent', 'starred'],
            external_links: [],
            spaces_expanded: true,
            recent_items_count: 5,
          },
        },
        error: null,
      });
      // Second call: update
      const updated = {
        id: 'pref-1',
        config: {
          sections: ['spaces', 'recent', 'starred'],
          external_links: [],
          spaces_expanded: false,
          recent_items_count: 10,
        },
      };
      const updateChain = buildChain({ data: updated, error: null });

      mockFrom.mockReturnValueOnce(findChain).mockReturnValueOnce(updateChain);

      const result = await service.updateSidebarPreferences(
        'user-1',
        'org-1',
        updateData,
      );

      expect(result).toEqual(updated);
    });

    it('should insert new sidebar preferences when none exist', async () => {
      const findChain = buildChain({ data: null, error: null });
      const inserted = {
        id: 'new-1',
        config: {
          sections: ['spaces', 'recent', 'starred'],
          external_links: [],
          spaces_expanded: false,
          recent_items_count: 10,
        },
      };
      const insertChain = buildChain({ data: inserted, error: null });

      mockFrom.mockReturnValueOnce(findChain).mockReturnValueOnce(insertChain);

      const result = await service.updateSidebarPreferences(
        'user-1',
        'org-1',
        updateData,
      );

      expect(result).toEqual(inserted);
    });

    it('should throw InternalServerErrorException when find fails', async () => {
      const findChain = buildChain({
        data: null,
        error: { message: 'DB error' },
      });
      mockFrom.mockReturnValue(findChain);

      await expect(
        service.updateSidebarPreferences('user-1', 'org-1', updateData),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw InternalServerErrorException when update fails', async () => {
      const findChain = buildChain({
        data: { id: 'pref-1', config: {} },
        error: null,
      });
      const updateChain = buildChain({
        data: null,
        error: { message: 'Update error' },
      });

      mockFrom.mockReturnValueOnce(findChain).mockReturnValueOnce(updateChain);

      await expect(
        service.updateSidebarPreferences('user-1', 'org-1', updateData),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw InternalServerErrorException when insert fails', async () => {
      const findChain = buildChain({ data: null, error: null });
      const insertChain = buildChain({
        data: null,
        error: { message: 'Insert error' },
      });

      mockFrom.mockReturnValueOnce(findChain).mockReturnValueOnce(insertChain);

      await expect(
        service.updateSidebarPreferences('user-1', 'org-1', updateData),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  // ── Starred Spaces ───────────────────────────────────────────────────────

  describe('getStarredSpaces', () => {
    it('should return starred spaces with space details', async () => {
      const starred = [
        {
          id: 'star-1',
          space_id: 'space-1',
          spaces: { id: 'space-1', name: 'Engineering' },
        },
      ];
      const chain = buildChain({ data: starred, error: null });
      // getStarredSpaces calls select->eq->order which resolves directly
      chain.order.mockResolvedValue({ data: starred, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.getStarredSpaces('user-1');

      expect(result).toEqual(starred);
      expect(mockFrom).toHaveBeenCalledWith('starred_spaces');
    });

    it('should return empty array when no starred spaces', async () => {
      const chain = buildChain({ data: null, error: null });
      chain.order.mockResolvedValue({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.getStarredSpaces('user-1');

      expect(result).toEqual([]);
    });

    it('should throw InternalServerErrorException on db error', async () => {
      const chain = buildChain({ data: null, error: null });
      chain.order.mockResolvedValue({
        data: null,
        error: { message: 'DB error' },
      });
      mockFrom.mockReturnValue(chain);

      await expect(service.getStarredSpaces('user-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('toggleStar', () => {
    it('should star a space when not already starred', async () => {
      const spaceChain = buildChain({ data: { id: 'space-1' }, error: null });
      // First call: find -> not found
      const findChain = buildChain({ data: null, error: null });
      // Second call: insert -> success (resolves directly from insert, not via .single)
      const insertChain = buildChain({ data: null, error: null });
      // insert() resolves directly (no .select/.single)
      insertChain.insert.mockResolvedValue({ data: null, error: null });

      mockFrom
        .mockReturnValueOnce(spaceChain)
        .mockReturnValueOnce(findChain)
        .mockReturnValueOnce(insertChain);

      const result = await service.toggleStar('user-1', 'org-1', 'space-1');

      expect(result).toEqual({ is_starred: true, space_id: 'space-1' });
    });

    it('should unstar a space when already starred', async () => {
      const spaceChain = buildChain({ data: { id: 'space-1' }, error: null });
      // First call: find -> found
      const findChain = buildChain({
        data: { id: 'star-1' },
        error: null,
      });
      // Second call: delete -> success
      const deleteChain = buildChain({ data: null, error: null });
      deleteChain.eq.mockResolvedValue({ data: null, error: null });

      mockFrom
        .mockReturnValueOnce(spaceChain)
        .mockReturnValueOnce(findChain)
        .mockReturnValueOnce(deleteChain);

      const result = await service.toggleStar('user-1', 'org-1', 'space-1');

      expect(result).toEqual({ is_starred: false, space_id: 'space-1' });
    });

    it('should throw InternalServerErrorException when find fails', async () => {
      const spaceChain = buildChain({ data: { id: 'space-1' }, error: null });
      const findChain = buildChain({
        data: null,
        error: { message: 'DB error' },
      });
      mockFrom.mockReturnValueOnce(spaceChain).mockReturnValueOnce(findChain);

      await expect(
        service.toggleStar('user-1', 'org-1', 'space-1'),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw InternalServerErrorException when delete fails', async () => {
      const spaceChain = buildChain({ data: { id: 'space-1' }, error: null });
      const findChain = buildChain({
        data: { id: 'star-1' },
        error: null,
      });
      const deleteChain = buildChain({ data: null, error: null });
      deleteChain.eq.mockResolvedValue({
        data: null,
        error: { message: 'Delete error' },
      });

      mockFrom
        .mockReturnValueOnce(spaceChain)
        .mockReturnValueOnce(findChain)
        .mockReturnValueOnce(deleteChain);

      await expect(
        service.toggleStar('user-1', 'org-1', 'space-1'),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw InternalServerErrorException when insert fails', async () => {
      const spaceChain = buildChain({ data: { id: 'space-1' }, error: null });
      const findChain = buildChain({ data: null, error: null });
      const insertChain = buildChain({ data: null, error: null });
      insertChain.insert.mockResolvedValue({
        data: null,
        error: { message: 'Insert error' },
      });

      mockFrom
        .mockReturnValueOnce(spaceChain)
        .mockReturnValueOnce(findChain)
        .mockReturnValueOnce(insertChain);

      await expect(
        service.toggleStar('user-1', 'org-1', 'space-1'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });
});
