/**
 * @fileoverview Regression guard for the shared audit-action list.
 * @module src/audit-logs/dto/create-audit-log.dto.spec
 *
 * AUDIT_ACTIONS is edited by every module that needs a new action, and three parameter unions in
 * audit-logs.service.ts are maintained by hand alongside it. This asserts that widening the list
 * never drops an action another module already writes.
 */

import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateAuditLogDto } from './create-audit-log.dto';

/** Every action that existed before the backup module was added. */
const PRE_EXISTING_ACTIONS = [
  'create',
  'update',
  'delete',
  'calculate',
  'archive',
  'restore',
  'workflow.transition.executed',
  'workflow.draft.created',
  'workflow.draft.discarded',
  'workflow.published',
  'workflow.assignment.changed',
];

function validate(action: string) {
  const dto = plainToInstance(CreateAuditLogDto, {
    entity_type: 'backup_target',
    action,
  });

  return validateSync(dto);
}

describe('CreateAuditLogDto action list', () => {
  it.each(PRE_EXISTING_ACTIONS)(
    'still accepts the existing action %s',
    (action) => {
      expect(validate(action)).toHaveLength(0);
    },
  );

  it('accepts the backup action', () => {
    expect(validate('backup')).toHaveLength(0);
  });

  it('still rejects an unknown action', () => {
    expect(validate('definitely-not-an-action').length).toBeGreaterThan(0);
  });
});
