/**
 * @fileoverview Barrel for the source-agnostic normalized model — the boundary between
 * source adapters (which produce these) and mappers/stages (which consume them).
 * Adapters never leak Jira/Confluence-shaped JSON past this boundary.
 */

export * from './raw-body';
export * from './normalized-project';
export * from './normalized-issue-type';
export * from './normalized-field';
export * from './normalized-screen';
export * from './normalized-status';
export * from './normalized-priority';
export * from './normalized-resolution';
export * from './normalized-group';
export * from './normalized-workflow';
export * from './normalized-board';
export * from './normalized-sprint';
export * from './normalized-user';
export * from './normalized-watcher';
export * from './normalized-role';
export * from './normalized-issue';
export * from './normalized-comment';
export * from './normalized-history';
export * from './normalized-attachment';
export * from './normalized-link';
export * from './normalized-space';
export * from './normalized-page';
export * from './normalized-page-version';
export * from './normalized-macro';
