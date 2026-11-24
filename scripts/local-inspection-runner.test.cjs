const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runner = path.resolve(__dirname, 'local-inspection-runner.cjs');
const originalLoad = Module._load;
const originalInspection = process.env.LOCAL_INSPECTION;
const originalSupabase = process.env.SUPABASE_URL;
let mainLoaded = false;

const refused = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(runner)})`], {
  env: { ...process.env, LOCAL_INSPECTION: '', SUPABASE_URL: 'http://127.0.0.1:54321' },
  encoding: 'utf8',
});
assert.notEqual(refused.status, 0);
assert.match(refused.stderr, /LOCAL_INSPECTION=1/);

const services = {
  AutomationCronService: class AutomationCronService {
    onModuleInit() {}
    triggerImmediately() { throw new Error('Background trigger must not run'); }
  },
  InboundEmailCronService: class InboundEmailCronService {
    onModuleInit() {}
  },
  MigrationCronService: class MigrationCronService {
    onModuleInit() {}
  },
};
const orchestrator = {
  SchedulerOrchestrator: class SchedulerOrchestrator {
    mountCron() {}
  },
};

Module._load = function load(request, parent, isMain) {
  if (request.endsWith('/automation-cron.service.js')) {
    return { AutomationCronService: services.AutomationCronService };
  }
  if (request.endsWith('/inbound-email-cron.service.js')) {
    return { InboundEmailCronService: services.InboundEmailCronService };
  }
  if (request.endsWith('/migration-cron.service.js')) {
    return { MigrationCronService: services.MigrationCronService };
  }
  if (request === '@nestjs/schedule/dist/scheduler.orchestrator.js') {
    return orchestrator;
  }
  if (request === '../dist/main.js') {
    mainLoaded = true;
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  process.env.LOCAL_INSPECTION = '1';
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
  delete require.cache[runner];
  require(runner);

  assert.equal(mainLoaded, true);
  assert.doesNotThrow(() => new services.AutomationCronService().triggerImmediately());
  for (const Service of Object.values(services)) {
    assert.notEqual(Service.prototype.onModuleInit.toString(), 'onModuleInit() {}');
  }
  assert.notEqual(
    orchestrator.SchedulerOrchestrator.prototype.mountCron.toString(),
    'mountCron() {}',
  );
} finally {
  Module._load = originalLoad;
  if (originalInspection === undefined) delete process.env.LOCAL_INSPECTION;
  else process.env.LOCAL_INSPECTION = originalInspection;
  if (originalSupabase === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalSupabase;
}

console.log('local-inspection-runner: ok');
