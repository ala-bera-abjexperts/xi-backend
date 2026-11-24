import { SPACE_PERMISSION_COLUMN_KEYS, SPACE_ROLE_BASE_PERMISSIONS, spaceGrantAllows } from './space-permissions.model';
import { DEFAULT_PERMISSIONS_BY_ROLE } from './access-control.model';
import { MODULE_PERMISSION_KEYS } from './module-permission-keys';
describe('SLA permissions', () => {
  it('registers independently configurable capabilities with staff-only publication', () => {
    for (const key of ['view_sla', 'manage_sla', 'publish_customer_replies']) {
      expect(SPACE_PERMISSION_COLUMN_KEYS.has(key)).toBe(true);
      expect(MODULE_PERMISSION_KEYS).toContain(`can_${key}`);
    }
    for (const role of ['owner', 'admin', 'member', 'viewer']) {
      expect(SPACE_ROLE_BASE_PERMISSIONS[role].view_sla).toBe(SPACE_ROLE_BASE_PERMISSIONS[role].view_custom_fields_tasks);
      expect(SPACE_ROLE_BASE_PERMISSIONS[role].publish_customer_replies).toBe(SPACE_ROLE_BASE_PERMISSIONS[role].edit_tasks);
      expect(SPACE_ROLE_BASE_PERMISSIONS[role].manage_sla).toBe(['owner', 'admin'].includes(role));
      expect(DEFAULT_PERMISSIONS_BY_ROLE[role].can_manage_sla).toBe(['owner', 'admin'].includes(role));
    }
  });
  it('honors explicit SLA denial and never grants nonmembers access', () => {
    const grant = { isAdmin: false, isMember: true, spaceRole: 'member', explicit: { view_sla: false }, basePermissions: { view_sla: true } };
    expect(spaceGrantAllows(grant, 'view_sla')).toBe(false);
    expect(spaceGrantAllows({ ...grant, isMember: false, explicit: { view_sla: true } }, 'view_sla')).toBe(false);
  });
});
