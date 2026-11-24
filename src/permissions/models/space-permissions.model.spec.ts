import {
  SPACE_PERMISSION_COLUMN_KEYS,
  normalizeSpacePermissions,
  SPACE_ROLE_BASE_PERMISSIONS,
} from './space-permissions.model';

describe('Space Permissions Model', () => {
  describe('SPACE_PERMISSION_COLUMN_KEYS', () => {
    it('should contain core permission keys', () => {
      expect(SPACE_PERMISSION_COLUMN_KEYS.has('view_processes')).toBe(true);
      expect(SPACE_PERMISSION_COLUMN_KEYS.has('edit_tasks')).toBe(true);
      expect(SPACE_PERMISSION_COLUMN_KEYS.has('delete_lists')).toBe(true);
      expect(SPACE_PERMISSION_COLUMN_KEYS.has('view_filters')).toBe(true);
      expect(SPACE_PERMISSION_COLUMN_KEYS.has('share_filters')).toBe(true);
    });

    it('should NOT contain keys with can_ prefix', () => {
      expect(SPACE_PERMISSION_COLUMN_KEYS.has('can_view_processes')).toBe(
        false,
      );
    });

    it('should NOT contain non-existent keys', () => {
      expect(SPACE_PERMISSION_COLUMN_KEYS.has('fake_permission')).toBe(false);
      expect(SPACE_PERMISSION_COLUMN_KEYS.has('superadmin')).toBe(false);
    });
  });

  describe('normalizeSpacePermissions', () => {
    it('should set view_tasks=true when edit_tasks=true', () => {
      const result = normalizeSpacePermissions({ edit_tasks: true });
      expect(result.view_tasks).toBe(true);
      expect(result.edit_tasks).toBe(true);
    });

    it('should set view_processes=true when create_processes=true', () => {
      const result = normalizeSpacePermissions({ create_processes: true });
      expect(result.view_processes).toBe(true);
    });

    it('should not change already-true views', () => {
      const result = normalizeSpacePermissions({
        view_tasks: true,
        edit_tasks: true,
      });
      expect(result.view_tasks).toBe(true);
    });

    it('should not set view when action is false', () => {
      const result = normalizeSpacePermissions({ edit_tasks: false });
      expect(result.view_tasks).toBeUndefined();
    });

    it('should handle manage_module_permissions implies view_module_permissions', () => {
      const result = normalizeSpacePermissions({
        manage_module_permissions: true,
      });
      expect(result.view_module_permissions).toBe(true);
    });

    it('should handle invite_members implies view_space', () => {
      const result = normalizeSpacePermissions({ invite_members: true });
      expect(result.view_space).toBe(true);
    });

    it('should handle multiple normalization rules at once', () => {
      const result = normalizeSpacePermissions({
        edit_tasks: true,
        create_processes: true,
        delete_wiki_pages: true,
      });
      expect(result.view_tasks).toBe(true);
      expect(result.view_processes).toBe(true);
      expect(result.view_wiki_pages).toBe(true);
    });
  });

  describe('SPACE_ROLE_BASE_PERMISSIONS', () => {
    it('owner should have all core permissions true', () => {
      const owner = SPACE_ROLE_BASE_PERMISSIONS['owner'];
      expect(owner.view_processes).toBe(true);
      expect(owner.delete_space).toBe(true);
      expect(owner.manage_members).toBe(true);
      expect(owner.delete_tasks).toBe(true);
      expect(owner.share_filters).toBe(true);
    });

    it('viewer should have view_* true but create/edit/delete false', () => {
      const viewer = SPACE_ROLE_BASE_PERMISSIONS['viewer'];
      expect(viewer.view_processes).toBe(true);
      expect(viewer.view_tasks).toBe(true);
      expect(viewer.view_dashboards).toBe(true);
      expect(viewer.create_processes).toBe(false);
      expect(viewer.edit_tasks).toBe(false);
      expect(viewer.delete_tasks).toBe(false);
      expect(viewer.manage_members).toBe(false);
    });

    it('member should create but not delete', () => {
      const member = SPACE_ROLE_BASE_PERMISSIONS['member'];
      expect(member.create_tasks).toBe(true);
      expect(member.edit_tasks).toBe(true);
      expect(member.delete_tasks).toBe(false);
      expect(member.manage_members).toBe(false);
      expect(member.delete_space).toBe(false);
    });

    it('admin cannot delete_space but can manage most things', () => {
      const admin = SPACE_ROLE_BASE_PERMISSIONS['admin'];
      expect(admin.delete_space).toBe(false);
      expect(admin.edit_space_settings).toBe(true);
      expect(admin.manage_members).toBe(true);
      expect(admin.delete_processes).toBe(true);
    });
  });
});
