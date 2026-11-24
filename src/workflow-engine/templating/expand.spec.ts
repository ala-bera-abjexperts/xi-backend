/**
 * @fileoverview Unit tests for the workflow templating expand() function.
 * @module src/workflow-engine/templating/expand.spec
 * @author Rajbha Manek
 */

import { expand, safeGet } from './expand';

describe('expand', () => {
  const ctx = {
    task: { title: 'Fix login', priority: { name: 'High' }, assignee: null },
    user: { name: 'Alice', email: 'alice@example.com' },
    org: { name: 'Acme' },
  };

  it('substitutes a simple path', () => {
    expect(expand('Hello {{user.name}}!', ctx)).toBe('Hello Alice!');
  });

  it('preserves unknown tokens', () => {
    expect(expand('{{unknown.path}}', ctx)).toBe('{{unknown.path}}');
  });

  it('uses fallback when the path is missing', () => {
    expect(expand('{{task.assignee.name | Unassigned}}', ctx)).toBe(
      'Unassigned',
    );
  });

  it('coerces numbers and booleans to strings', () => {
    const c = { task: { count: 3, done: true } };

    expect(expand('{{task.count}} / {{task.done}}', c)).toBe('3 / true');
  });

  it('rejects prototype-pollution paths', () => {
    const c = { task: {} };

    expect(safeGet(c, '__proto__.polluted')).toBeUndefined();
    expect(safeGet(c, 'constructor.name')).toBeUndefined();
    expect(safeGet(c, 'prototype.foo')).toBeUndefined();
  });

  it('handles deeply nested paths', () => {
    expect(expand('Priority: {{task.priority.name}}', ctx)).toBe(
      'Priority: High',
    );
  });

  it('does NOT interpret HTML or scripts', () => {
    const c = { user: { name: '<script>alert(1)</script>' } };

    // expand() preserves the value as-is; XSS protection is the renderer's job.
    expect(expand('Hi {{user.name}}', c)).toBe('Hi <script>alert(1)</script>');
  });

  it('handles a template with multiple tokens', () => {
    expect(expand('Hi {{user.name}} from {{org.name}}', ctx)).toBe(
      'Hi Alice from Acme',
    );
  });

  it('returns ISO string for Date values', () => {
    const c = { task: { created_at: new Date('2026-01-15T10:00:00.000Z') } };

    expect(expand('{{task.created_at}}', c)).toBe('2026-01-15T10:00:00.000Z');
  });
});
