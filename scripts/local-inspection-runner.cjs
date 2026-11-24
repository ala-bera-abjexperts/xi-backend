// Local-only API bootstrap for inspecting a seeded Supabase database.
// It disables background workers before Nest constructs AppModule.

if (process.env.LOCAL_INSPECTION !== '1') {
  throw new Error('Refusing to run: set LOCAL_INSPECTION=1 explicitly');
}

const supabaseUrl = process.env.SUPABASE_URL ?? '';

if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(?:\/|$)/i.test(supabaseUrl)) {
  throw new Error('Refusing to run: SUPABASE_URL must point to local Supabase');
}

const disableInit = (path, exportName, label) => {
  const Service = require(path)[exportName];

  if (typeof Service !== 'function') throw new Error(`Missing ${exportName}`);

  Service.prototype.onModuleInit = function localInspectionDisabled() {
    this.logger?.log?.(`${label} disabled for local inspection`);
  };
};

// These services start setInterval loops or execute DB work immediately.
disableInit('../dist/automations/automation-cron.service.js', 'AutomationCronService', 'Automation cron');
// Event-driven kicks otherwise bypass the disabled startup timers and drain
// unrelated tenants' queues while inspecting a seeded local database.
require('../dist/automations/automation-cron.service.js').AutomationCronService.prototype.triggerImmediately = function localInspectionNoImmediateTick() {};
disableInit('../dist/inbound-email/inbound-email-cron.service.js', 'InboundEmailCronService', 'Inbound email polling');
disableInit('../dist/migration/engine/migration-cron.service.js', 'MigrationCronService', 'Migration engine');

// Prevent all Nest @Cron callbacks (outbox, cleanup, dispatchers, etc.) from
// being mounted. The HTTP API and its controllers remain available.
const orchestrator = require('@nestjs/schedule/dist/scheduler.orchestrator.js');
orchestrator.SchedulerOrchestrator.prototype.mountCron = function localInspectionNoop() {};

require('../dist/main.js');
