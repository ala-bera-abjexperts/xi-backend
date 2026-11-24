// Starts XISUITE's own test runs in Test Management after a deployment and waits for their result.
// GitLab variables (Settings → CI/CD → Variables, all Protected; mask only TM_API_KEY):
//   TM_API_URL, TM_SPACE_ID, TM_API_KEY (a key with "Can start test runs")
//   TM_CI_CONFIG_IDS + TM_CI_PLAN_IDS (GitHub settings), TM_CONFIG_IDS + TM_PLAN_IDS ("Run on this server", optional)
//   TM_CI_COMMIT_CONFIG_IDS / TM_COMMIT_CONFIG_IDS (GitHub / "Run on this server" settings shown with the deployed
//   commit), TM_DEPLOY_ENVIRONMENT (default production); every run also gets the environment and pipeline link
//   A "Run on this server" run tests what its setting points to, not the deployed commit, so there it is only a label.
//   TM_WAIT_MINUTES (default 150, counted from the job start, start retries included; 0 only starts the runs,
//   retrying starts for up to 15 minutes)
// A retried job reports the runs it already started; a new pipeline starts new ones. Waiting keeps a runner busy.
// Self-test mode (no id lists set): one call starts every self-test setting of TM_SPACE_ID with its own test plan.
//   "Connect deploy pipeline" on the XISUITE self-test tab saves the address, key and space id. TM_APP_URL (or
//   GitLab's CI_ENVIRONMENT_URL) reaches the tests as the deployed app's address. No commit is sent in this mode.
// XISUITE setup (the in-app guide on the Deployments tab covers the general steps):
//   Space "XISUITE Development" with plans Backend A–M, Backend N–Z and Frontend (each under 1,000 tests).
//   GitLab push mirror of xisuite-backend and risk-management-app to GitHub (protected branches only); the workflow
//   files live in GitLab, so never create them from the app. GitHub App on both repos: Actions read/write, Contents read.
//   GitHub CI job settings on xisuite-tests.yml: backend inputs part = backend-am / backend-nz and sha = {commitSha};
//   frontend has no inputs. Import each repository's test files into its plan from the setting's Overview.
//   Optional "Run on this server" settings for runs by hand need TM_RUNNER_MAX_DISK_MB=7000 on the runner.
import { createHash } from 'node:crypto';

const { TM_SPACE_ID } = process.env;

// Send to CI saves the address and key as XISUITE_URL and XISUITE_TM_KEY; the address ends in /api/v1.
const TM_API_URL = (process.env.TM_API_URL || process.env.XISUITE_URL || '')
  .replace(/\/+$/, '')
  .replace(/\/api\/v1$/, '');
const TM_API_KEY = process.env.TM_API_KEY || process.env.XISUITE_TM_KEY;
const pipeline = process.env.CI_PIPELINE_ID ?? 'local';

// A blank variable means the default; only an explicit 0 skips waiting.
const minutes = Number(process.env.TM_WAIT_MINUTES?.trim() || 150);
const waitMinutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : 150;

// Starts and waiting share one deadline, so the job reports before the GitLab timeout.
const deadline = Date.now() + (waitMinutes || 15) * 60_000;
const pollMs = (Number(process.env.TM_POLL_SECONDS) || 30) * 1000;

const stop = (message) => {
  console.error(message);
  process.exit(1);
};

const list = (value) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

// Which deploy started the runs; shown on each run in XISUITE. Values the API would refuse are left out.
const commitConfigs = [
  ...list(process.env.TM_CI_COMMIT_CONFIG_IDS),
  ...list(process.env.TM_COMMIT_CONFIG_IDS),
];
const commit = /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(
  process.env.CI_COMMIT_SHA ?? '',
)
  ? process.env.CI_COMMIT_SHA
  : null;
const environment = process.env.TM_DEPLOY_ENVIRONMENT || 'production';
const pipelineUrl = process.env.CI_PIPELINE_URL ?? '';

if (!/^[\w .:/-]{1,100}$/.test(environment)) {
  console.error(
    `TM_DEPLOY_ENVIRONMENT "${environment}" is left out: use up to 100 letters, digits, spaces and . : / - _`,
  );
}

// Only the listed settings get the commit, so another repo's run never shows a wrong commit.
const deployFor = (configId) => ({
  ...(/^[\w .:/-]{1,100}$/.test(environment) && { environment }),
  ...(/^https:\/\/\S{1,492}$/.test(pipelineUrl) && {
    pipeline_url: pipelineUrl,
  }),
  ...(commit && commitConfigs.includes(configId) && { commit_sha: commit }),
});

// "Run on this server" settings queue a run; CI job settings start their workflow through XISUITE.
const groups = [
  { configsName: 'TM_CONFIG_IDS', plansName: 'TM_PLAN_IDS', route: 'runs' },
  {
    configsName: 'TM_CI_CONFIG_IDS',
    plansName: 'TM_CI_PLAN_IDS',
    route: 'trigger',
  },
].map((group) => ({
  ...group,
  configs: list(process.env[group.configsName]),
  plans: list(process.env[group.plansName]),
}));

// Without id lists the space's self-test settings are started instead.
const selfTestMode = groups.every(
  (group) => group.configs.length === 0 && group.plans.length === 0,
);

// The deployed app's address for end-to-end tests; anything but https is left out.
const appUrl =
  [process.env.TM_APP_URL, process.env.CI_ENVIRONMENT_URL].find((value) =>
    /^https:\/\/\S{1,1990}$/.test(value ?? ''),
  ) ?? null;

if (!TM_API_URL || !TM_SPACE_ID || !TM_API_KEY) {
  stop(
    'Set TM_API_URL (or XISUITE_URL), TM_SPACE_ID and TM_API_KEY (or XISUITE_TM_KEY) in the CI variables; add TM_CONFIG_IDS + TM_PLAN_IDS and/or TM_CI_CONFIG_IDS + TM_CI_PLAN_IDS, or leave them out to start every self-test setting',
  );
}

for (const group of groups) {
  if (group.configs.length !== group.plans.length) {
    stop(
      `${group.configsName} and ${group.plansName} need the same number of ids, in the same order`,
    );
  }
}

// The same seed always gives the same id, so a retried job returns the run it already started.
const requestId = (seed) => {
  const hex = createHash('sha256').update(seed).digest('hex').split('');

  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);

  const id = hex.join('');

  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`;
};

const base = `${TM_API_URL.replace(/\/+$/, '')}/api/v1/spaces/${TM_SPACE_ID}/test-management/automation`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One start; a network error, 429, 5xx or a reply without a run id is tried again with the same id, so it never
// starts twice. A run of the same setting still going here is waited for until the deadline.
const send = async (route, configId, planId, seed) => {
  const target = {
    target: 'plan',
    target_id: planId,
    request_id: requestId(seed),
  };
  const url =
    route === 'runs' ? `${base}/runs` : `${base}/configs/${configId}/trigger`;
  const body = JSON.stringify({
    ...(route === 'runs' && { config_id: configId }),
    ...target,
    ...deployFor(configId),
  });

  let attempt = 0;

  while (Date.now() < deadline) {
    let wait = 0;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TM_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const reply = await response.json().catch(() => ({}));
      const run = reply?.data ?? reply;

      if (response.ok && typeof run?.id === 'string') return run;

      const going =
        response.status === 409 && reply?.code === 'RUN_ALREADY_GOING';

      console.error(
        `Setting ${configId}: ${response.status} ${response.ok ? 'reply has no run id' : (reply?.message ?? response.statusText)}`,
      );

      // Only a busy or unreachable server, an unreadable reply or a run still going is worth another try.
      if (
        !response.ok &&
        !going &&
        response.status !== 429 &&
        response.status < 500
      ) {
        return null;
      }

      if (!going) attempt += 1;

      // The limit is per minute and a going run takes minutes, so both wait one minute.
      wait = going || response.status === 429 ? 60_000 : attempt * 10_000;
    } catch (error) {
      console.error(`Setting ${configId}: ${error.message}`);
      attempt += 1;
      wait = attempt * 10_000;
    }

    if (attempt >= 3) return null;

    await sleep(Math.min(wait, deadline - Date.now()));
  }

  console.error(`Setting ${configId}: not started before the deadline`);

  return null;
};

const describe = (configId, run) =>
  run.status === 'ERROR'
    ? `Setting ${configId}: run ${run.id} could not start (${run.error_code ?? 'ERROR'}${run.error_message ? `: ${run.error_message}` : ''})`
    : `Setting ${configId}: run ${run.id} is ${run.status}`;

const start = async (route, configId, planId) => {
  const seed = `${route}:${pipeline}:${configId}:${planId}`;
  let run = await send(route, configId, planId, seed);

  // A failed start is replayed for the same id, so the second try needs a new one.
  if (run?.status === 'ERROR') {
    console.error(describe(configId, run));
    run = await send(route, configId, planId, `${seed}:again`);
  }

  if (!run) return null;

  if (run.status === 'ERROR') {
    console.error(describe(configId, run));

    return null;
  }

  console.log(describe(configId, run));

  if (run.result_summary?.ci?.state === 'untracked') {
    console.error(
      `Setting ${configId}: the CI tool gave no run id, so its results will not come back`,
    );

    return null;
  }

  return run;
};

// Self-test mode: one call starts every self-test setting; a retried job gets the same runs back.
const startSelfTest = async () => {
  const body = JSON.stringify({
    request_id: requestId(`self-test:${pipeline}`),
    ...(/^[\w .:/-]{1,100}$/.test(environment) && { environment }),
    ...(/^https:\/\/\S{1,492}$/.test(pipelineUrl) && {
      pipeline_url: pipelineUrl,
    }),
    ...(appUrl && { app_url: appUrl }),
  });

  let attempt = 0;

  while (Date.now() < deadline) {
    let wait = 0;

    try {
      const response = await fetch(`${base}/self-test/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TM_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      const reply = await response.json().catch(() => ({}));
      const result = reply?.data ?? reply;

      if (response.ok && Array.isArray(result?.runs)) {
        return { runs: result.runs, skipped: result.skipped ?? [] };
      }

      console.error(
        `Self-test start: ${response.status} ${reply?.code ? `${reply.code} ` : ''}${reply?.message ?? response.statusText}`,
      );

      // Every setting was refused; the reasons are listed and the job fails.
      const skipped = reply?.skipped ?? result?.skipped;

      if (response.status === 422 && Array.isArray(skipped)) {
        return { runs: [], skipped };
      }

      if (!response.ok && response.status !== 429 && response.status < 500) {
        return null;
      }

      attempt += 1;
      wait = response.status === 429 ? 60_000 : attempt * 10_000;
    } catch (error) {
      console.error(`Self-test start: ${error.message}`);
      attempt += 1;
      wait = attempt * 10_000;
    }

    if (attempt >= 3) return null;

    await sleep(Math.min(wait, deadline - Date.now()));
  }

  console.error('Self-test start: not started before the deadline');

  return null;
};

const IN_PROGRESS = ['queued', 'running', 'importing'];

// 'running', 'passed', or why the run did not pass.
const resultOf = (run) => {
  if (run.status === 'ERROR') return run.error_code ?? 'ERROR';

  if (run.kind === 'docker') {
    if (['QUEUED', 'RUNNING', 'UPLOADING'].includes(run.status))
      return 'running';

    return run.status === 'DONE' && run.outcome === 'passed'
      ? 'passed'
      : (run.outcome ?? run.status);
  }

  const ci = run.result_summary?.ci;

  if (
    run.result_summary?.send_pending ||
    !ci ||
    IN_PROGRESS.includes(ci.state)
  ) {
    return 'running';
  }

  return ci.state;
};

// A refusal will not change by waiting; a busy or unreachable server is asked again next round.
const read = async (run) => {
  try {
    const response = await fetch(`${base}/runs/${run.id}`, {
      headers: { Authorization: `Bearer ${TM_API_KEY}` },
      signal: AbortSignal.timeout(30_000),
    });
    const reply = await response.json().catch(() => ({}));
    const latest = reply?.data ?? reply;

    // An unreadable reply keeps the last good run, which is asked again next round.
    if (response.ok && typeof latest?.id === 'string') return latest;

    if ([401, 403, 404].includes(response.status)) {
      return {
        ...run,
        status: 'ERROR',
        error_code: `${response.status} ${reply?.message ?? response.statusText}`,
      };
    }
  } catch {
    // Asked again next round.
  }

  return run;
};

const started = [];
let failed = 0;

if (selfTestMode) {
  const result = await startSelfTest();

  if (!result) failed += 1;

  for (const skip of result?.skipped ?? []) {
    console.error(`Setting ${skip.name}: ${skip.code} ${skip.message}`);
    failed += 1;
  }

  for (const run of result?.runs ?? []) {
    const name = run.config_name ?? run.config_id;

    if (run.status === 'ERROR') {
      console.error(describe(name, run));
      failed += 1;
    } else if (run.result_summary?.ci?.state === 'untracked') {
      console.error(
        `Setting ${name}: the CI tool gave no run id, so its results will not come back`,
      );
      failed += 1;
    } else {
      console.log(describe(name, run));
      started.push({ configId: name, run });
    }
  }
}

for (const group of groups) {
  for (const [index, configId] of group.configs.entries()) {
    const run = await start(group.route, configId, group.plans[index]);

    if (run) started.push({ configId, run });
    else failed += 1;
  }
}

if (waitMinutes === 0) process.exit(failed === 0 ? 0 : 1);

let going = started;

while (going.length > 0 && Date.now() < deadline) {
  await sleep(pollMs);

  for (const item of going) item.run = await read(item.run);

  going = going.filter((item) => resultOf(item.run) === 'running');
}

for (const { configId, run } of started) {
  const result = resultOf(run);
  const counts = run.result_summary?.counts;
  const tally = counts
    ? ` (${counts.passed ?? 0} passed, ${counts.failed ?? 0} failed, ${counts.skipped ?? 0} skipped)`
    : '';
  const text =
    result === 'running'
      ? `still running after ${waitMinutes} minutes`
      : result;

  console.log(`Setting ${configId}: ${text}${tally}, run ${run.id}`);

  if (result !== 'passed') failed += 1;
}

const total = selfTestMode
  ? started.length + failed
  : groups.reduce((sum, group) => sum + group.configs.length, 0);

console.log(
  failed === 0
    ? 'Deploy result: passed'
    : `Deploy result: failed (${failed} of ${total} settings)`,
);
process.exit(failed === 0 ? 0 : 1);
