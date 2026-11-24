import {
  ISSUE_GROUP_MAX_OPTIONS,
  isSingleIssueGroup,
  issueGroupOptionsError,
  issueGroupValueError,
} from './issue-group.util';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const opt = (value: string, label: string, status?: string) => ({
  value,
  label,
  status,
});

describe('issue-group.util', () => {
  it('treats a missing mode as multi', () => {
    expect(isSingleIssueGroup(null)).toBe(false);
    expect(isSingleIssueGroup({})).toBe(false);
    expect(
      isSingleIssueGroup({ issue_group: { selection_mode: 'single' } }),
    ).toBe(true);
  });

  it.each([
    ['not an array', null, 'Options are required'],
    ['no active option', [opt(A, 'A', 'archived')], 'At least one active'],
    ['a non-UUID id', [opt('x', 'A')], 'Invalid option id'],
    ['a duplicate id', [opt(A, 'A'), opt(A, 'B')], 'unique'],
    ['an empty name', [opt(A, '  ')], 'name is required'],
    [
      'a duplicate name (any case)',
      [opt(A, 'Alpha'), opt(B, 'alpha')],
      'Duplicate',
    ],
    [
      'too many options',
      Array.from({ length: ISSUE_GROUP_MAX_OPTIONS + 1 }, () => opt(A, 'A')),
      'at most',
    ],
  ])('rejects options with %s', (_, options, message) => {
    expect(issueGroupOptionsError(options)).toContain(message);
  });

  it('accepts a valid option list', () => {
    expect(
      issueGroupOptionsError([opt(A, 'A'), opt(B, 'B', 'archived')]),
    ).toBeNull();
  });

  const field = (mode?: 'single' | 'multi') => ({
    name: 'Release',
    options: [opt(A, 'A'), opt(B, 'B')],
    validation_rules: mode ? { issue_group: { selection_mode: mode } } : {},
  });

  it.each([
    ['a non-array', A, undefined, 'must be an array'],
    ['an unknown id', [A, 'nope'], undefined, 'unknown option'],
    ['two ids in single mode', [A, B], 'single' as const, 'only one value'],
  ])('rejects %s value', (_, value, mode, message) => {
    expect(issueGroupValueError(field(mode), value)).toContain(message);
  });

  it('accepts an empty array and known ids', () => {
    expect(issueGroupValueError(field('single'), [])).toBeNull();
    expect(issueGroupValueError(field(), [A, B])).toBeNull();
  });
});
