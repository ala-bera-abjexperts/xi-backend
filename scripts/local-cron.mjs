/**
 * Local development cron simulator.
 * Fires the tick + work routes every 15 seconds so automations behave
 * the same as production without manual curl commands.
 *
 * Usage: pnpm dev:cron
 * Requires: CRON_SECRET env var (or set in .env)
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env from project root if present
try {
  const env = readFileSync(resolve(process.cwd(), '.env'), 'utf8');

  for (const line of env.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;

    const key = trimmed.slice(0, eq).trim();
    const val = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');

    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  // no .env file — rely on shell environment
}

const PORT = process.env.PORT ?? '3001';
const CRON_SECRET = process.env.CRON_SECRET ?? '';
const BASE_URL = `http://localhost:${PORT}`;
const TICK_URL = `${BASE_URL}/api/v1/automations/cron/tick`;
const WORK_URL = `${BASE_URL}/api/v1/automations/cron/work`;
const INTERVAL_MS = 15_000;

if (!CRON_SECRET) {
  console.warn('[dev:cron] ⚠  CRON_SECRET is not set — endpoints will reject requests.');
}

console.log(`Local cron started — firing every ${INTERVAL_MS / 1000}s against ${BASE_URL}`);

const headers = { Authorization: `Bearer ${CRON_SECRET}` };

async function tick() {
  try {
    const [tickRes, workRes] = await Promise.all([
      fetch(TICK_URL, { headers }),
      fetch(WORK_URL, { headers }),
    ]);

    const [tickBody, workBody] = await Promise.all([
      tickRes.json().catch(() => ({})),
      workRes.json().catch(() => ({})),
    ]);

    const ts = new Date().toLocaleTimeString();

    console.log(
      `[${ts}] tick → outbox:${tickBody.outboxRelayed ?? 0} schedules:${tickBody.schedulesFired ?? 0} | ` +
        `work → dispatched:${workBody.dispatched ?? 0} succeeded:${workBody.succeeded ?? 0} failed:${workBody.failed ?? 0}`,
    );
  } catch (err) {
    console.error('[cron] error — is the dev server running?', err.message);
  }
}

tick();
setInterval(tick, INTERVAL_MS);
