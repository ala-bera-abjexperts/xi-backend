#!/usr/bin/env node
/**
 * Local verification helper for XE-T353 (chat and Robert). LOCAL DEVELOPMENT ONLY:
 * it signs test tokens with the local Supabase JWT secret and talks to a backend on
 * localhost. It refuses any API URL that is not localhost.
 *
 * Usage (from xisuite-backend):
 *   node --env-file=.env scripts/robert-verify.mjs api <email> <METHOD> <path> [json-body]
 *   node --env-file=.env scripts/robert-verify.mjs smoke [email-a email-b]
 *   node --env-file=.env scripts/robert-verify.mjs race
 *   node --env-file=.env scripts/robert-verify.mjs plans-race   (1.22)
 *   node scripts/robert-verify.mjs undo-race
 *
 * Environment: SUPABASE_JWT_SECRET (from .env, never printed), VERIFY_API_URL
 * (default http://localhost:3001/api/v1), VERIFY_TENANT (default ambertech-solutions).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const API = process.env.VERIFY_API_URL ?? 'http://localhost:3001/api/v1';
const TENANT = process.env.VERIFY_TENANT ?? 'ambertech-solutions';

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(`${API}/`)) {
  throw new Error('robert-verify only talks to a backend on localhost');
}

const b64 = (value) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString(
    'base64url',
  );

/** Runs one statement against the local database and returns its rows as text. */
export function sql(statement) {
  return execFileSync(
    'docker',
    [
      'exec', '-i', 'supabase_db_2', 'psql', '-U', 'postgres', '-d', 'postgres',
      '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement,
    ],
    { encoding: 'utf8' },
  ).trim();
}

/**
 * Runs a script in its own psql session (each statement its own transaction) without
 * waiting, so several sessions can work at the same time. Resolves to the last row printed.
 */
function sqlSession(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'exec', '-i', 'supabase_db_2', 'psql', '-U', 'postgres', '-d', 'postgres',
      '-At', '-v', 'ON_ERROR_STOP=1',
    ]);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(out.trim().split('\n').filter(Boolean).at(-1) ?? '')
        : reject(new Error(err.trim() || `psql exited with ${code}`)),
    );
    child.stdin.end(script);
  });
}

/**
 * Runs the statements in parallel sessions that all wait for the same instant first, so
 * they really meet in the database and not one after the other.
 */
function together(statements) {
  const at = new Date(Date.now() + 2500).toISOString();
  return Promise.all(
    statements.map((statement) =>
      sqlSession(`select pg_sleep_until('${at}');\n${statement};\n`),
    ),
  );
}

const authIds = new Map();

/** The Supabase auth id behind a local user's email. */
function authUserId(email) {
  if (!/^[\w.+-]+@[\w.-]+$/.test(email)) throw new Error(`Not an email: ${email}`);
  if (!authIds.has(email)) {
    const id = sql(
      `select auth_user_id from public.users where lower(email) = lower('${email}')`,
    );
    if (!id) throw new Error(`No local user with email ${email}`);
    authIds.set(email, id);
  }
  return authIds.get(email);
}

/** A one-hour test token for a local user (aal2, as the local tenants require). */
export function token(email) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error('SUPABASE_JWT_SECRET is not set: run with node --env-file=.env');
  }
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: authUserId(email),
    role: 'authenticated',
    aud: 'authenticated',
    aal: 'aal2',
    amr: [{ method: 'totp', timestamp: now }],
    iat: now,
    exp: now + 3600,
  });
  const signature = createHmac('sha256', secret)
    .update(`${head}.${body}`)
    .digest('base64url');
  return `${head}.${body}.${signature}`;
}

/** Calls the local API as a user; returns the status and the unwrapped `data`. */
export async function api(email, method, path, body, tenant = TENANT) {
  const started = Date.now();
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token(email)}`,
      'x-tenant-slug': tenant,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  // Every response is wrapped as { statusCode, hasError, data, message }.
  const wrapped = parsed && typeof parsed === 'object' && 'hasError' in parsed;
  return {
    status: response.status,
    ms: Date.now() - started,
    data: wrapped ? parsed.data : parsed,
    message: wrapped ? parsed.message : undefined,
  };
}

const SMOKE_GROUP = 'QA smoke (automated)';

/**
 * Plain chat over real HTTP as two people: send, resend, unread, edit, react, pin,
 * search, read, realtime token, delete. The unit specs use doubles, so this is what
 * notices a broken send. It works in its own group and removes it afterwards.
 */
async function smoke(a = 'prince@abjexperts.com', b = 'alabera.abjexperts@gmail.com') {
  const failures = [];
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
    if (!ok) failures.push(name);
  };
  const call = async (name, email, method, path, body, expected = 200) => {
    const result = await api(email, method, path, body);
    check(
      `${name} (${result.status}, ${result.ms} ms)`,
      result.status === expected,
      JSON.stringify(result.message ?? result.data).slice(0, 200),
    );
    return result.data;
  };

  const bId = sql(`select id from public.users where lower(email) = lower('${b}')`);
  await call('inbox', a, 'GET', '/chat/conversations');
  const created = await call(
    'create group', a, 'POST', '/chat/groups',
    { title: SMOKE_GROUP, memberIds: [bId] }, 201,
  );
  const group = created?.id;
  if (!group) throw new Error('smoke: no group to work in');

  const id = crypto.randomUUID();
  const word = `smoke${id.slice(0, 8)}`;
  const base = `/chat/conversations/${group}`;
  const unreadOf = async () =>
    (await api(b, 'GET', '/chat/conversations')).data?.find?.((row) => row.id === group)
      ?.unreadCount;

  try {
    const before = await unreadOf();
    const sent = await call(
      'send', a, 'POST', `${base}/messages`, { id, bodyHtml: `<p>${word} one</p>` }, 201,
    );
    const again = await api(a, 'POST', `${base}/messages`, { id, bodyHtml: `<p>${word} one</p>` });
    check('resend is idempotent', again.data?.seq === sent?.seq, JSON.stringify(again).slice(0, 200));
    check('unread +1 for the other member', (await unreadOf()) === before + 1);

    const page = await call('list as the other member', b, 'GET', `${base}/messages?limit=5`);
    check('message is listed', page?.messages?.some((row) => row.id === id));

    const edited = await call('edit', a, 'PATCH', `/chat/messages/${id}`, { bodyHtml: `<p>${word} two</p>` });
    check('edit is counted', edited?.editCount === 1, JSON.stringify(edited).slice(0, 200));
    await call('react', b, 'PUT', `/chat/messages/${id}/reactions/${encodeURIComponent('👍')}`);
    await call('pin', a, 'PUT', `/chat/messages/${id}/pin`);

    const found = await call('search', b, 'GET', `/chat/search?q=${word}`);
    check('search finds it', found?.hits?.[0]?.message?.id === id, JSON.stringify(found).slice(0, 200));
    const window = await call('window around it', b, 'GET', `${base}/messages?aroundMessageId=${id}`);
    const row = window?.messages?.find((message) => message.id === id);
    check('reaction and pin are shown', row?.reactions?.length === 1 && !!row?.pinnedAt);

    await call('mark read', b, 'POST', `${base}/read`, { seq: sent?.seq });
    check('unread back to where it was', (await unreadOf()) === before);

    const token = await call('realtime token', a, 'POST', '/chat/realtime/token', { conversationIds: [group] });
    check('token is a string', typeof (token?.token ?? token) === 'string');

    await call('unpin', a, 'DELETE', `/chat/messages/${id}/pin`);
    await call('delete', a, 'DELETE', `/chat/messages/${id}`);
    const gone = await api(b, 'GET', `/chat/search?q=${word}`);
    check('a deleted message is not found', gone.data?.hits?.length === 0);
  } finally {
    // Its own rows only: the bell rows of its message, then its group (members and messages cascade).
    sql(`delete from public.notifications where reference_type = 'chat_message' and reference_id = '${id}'`);
    sql(`delete from public.chat_conversations where id = '${group}'`);
  }

  console.log(failures.length ? `smoke: ${failures.length} FAILED` : 'smoke: all checks passed');
  if (failures.length) process.exit(1);
}

/**
 * The races the integration SQL cannot check (one session, frozen clock): parallel starts
 * against a nearly full cap, parallel resends, two sweeps claiming at once, Stop against
 * the result, a late worker after a take-over, and five Confirms of one proposal. Works in a throwaway organization with
 * its own users and removes all of it afterwards, whatever happened.
 */
async function race() {
  const failures = [];
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
    if (!ok) failures.push(name);
  };

  const org = crypto.randomUUID();
  const [owner, member] = [crypto.randomUUID(), crypto.randomUUID()];
  const tag = `robert-race-${org.slice(0, 8)}`;
  const RESERVE = 1000;
  const NO_LIMIT = 1000000;

  // agent_claim_runs works across all tenants: refuse to run while another tenant has a
  // run it would pick up, so no other tenant's row is ever touched.
  const claimable = `
    select count(*) from public.agent_runs
    where organization_id <> '${org}' and deadline_at > now()
      and (status = 'queued'
        or (status = 'running' and lease_expires_at < now() and attempts < 2
            and cancel_requested_at is null))`;
  if (sql(claimable) !== '0') {
    throw new Error('race: another tenant has claimable runs; try again when they are done');
  }

  /** A request in a conversation, posted now; returns its message id. */
  const ask = (conversation = conversations[0]) => {
    const id = crypto.randomUUID();
    sql(`select public.chat_post_message('${org}', '${conversation}', '${id}', '${owner}', '<p>@Robert race</p>', '@Robert race', null)`);
    return id;
  };
  const start = (trigger, maxRunning = NO_LIMIT) =>
    `select public.agent_start_run('${org}', '${trigger}', '${owner}', ${RESERVE}, null, null, null, ${NO_LIMIT}, ${maxRunning})`;
  const finalize = (run, lease) =>
    `select public.agent_finalize_run('${run}', '${lease}', 'completed', null, 'conversation', '{}', '[]', null)`;
  const record = (run, lease) =>
    `select public.agent_record_model_call('${run}', '${lease}', 100, 10, 'race', true, null, 5)`;
  const run = (id) =>
    JSON.parse(sql(`select row_to_json(r) from public.agent_runs r where id = '${id}'`));
  // Every live run of the throwaway organization ends, so each case starts from nothing.
  const quiesce = () =>
    sql(`update public.agent_runs set status = 'failed', error_code = 'test', lease_token = null, lease_expires_at = null, finished_at = now()
         where organization_id = '${org}' and status in ('queued', 'running')`);

  let conversations = [];
  try {
    sql(`insert into public.organizations (id, name, slug, size) values ('${org}', 'Robert race (automated)', '${tag}', '1-10')`);
    sql(`insert into public.users (id, email, first_name) values
           ('${owner}', '${tag}-owner@example.invalid', 'Race'),
           ('${member}', '${tag}-member@example.invalid', 'Race')`);
    sql(`insert into public.organization_members (organization_id, user_id, role) values
           ('${org}', '${owner}', 'owner'), ('${org}', '${member}', 'member')`);
    conversations = [1, 2, 3, 4].map((n) =>
      sql(`select public.chat_create_group('${org}', '${owner}', 'Robert race ${n}', array['${member}']::uuid[])`),
    );

    // 1. Room in the monthly cap for exactly 7 reservations; 20 starts, 20 requests in 4 chats.
    sql(`insert into public.agent_settings (organization_id, monthly_token_cap) values ('${org}', ${7 * RESERVE})`);
    const triggers = Array.from({ length: 20 }, (_, n) => ask(conversations[n % 4]));
    const starts = (await together(triggers.map((trigger) => start(trigger)))).map((row) => JSON.parse(row));
    const started = starts.filter((result) => !result.refusal).length;
    const refusedOrg = starts.filter((result) => result.refusal === 'budget_org').length;
    const alerts = starts.filter((result) => result.alert100).length;
    check(`20 starts against the cap: 7 started (${started}), 13 budget_org (${refusedOrg}), alert100 once (${alerts})`,
      started === 7 && refusedOrg === 13 && alerts === 1, JSON.stringify(starts.map((result) => result.refusal)));
    check('the 100% marker is set on the counter',
      sql(`select count(*) from public.agent_usage_counters where organization_id = '${org}' and scope = 'org_month' and alert100_at is not null`) === '1');
    quiesce();
    sql(`update public.agent_settings set monthly_token_cap = null where organization_id = '${org}'`);

    // 2. One request sent ten times at once.
    const resent = ask();
    const resends = (await together(Array.from({ length: 10 }, () => start(resent)))).map((row) => JSON.parse(row));
    check(`10 starts of one request: 1 run, created once (${resends.filter((result) => result.created).length})`,
      new Set(resends.map((result) => result.run_id)).size === 1
        && resends.filter((result) => result.created).length === 1
        && sql(`select count(*) from public.agent_runs where trigger_message_id = '${resent}'`) === '1');
    quiesce();

    // 3. Two sweeps claim over 6 queued runs with room for 4 running.
    for (let n = 0; n < 6; n += 1) sql(start(ask(), 0));
    const claimed = (await together([1, 2].map(() =>
      `select coalesce(json_agg(json_build_object('id', id, 'org', organization_id)), '[]') from public.agent_claim_runs(6, 4)`,
    ))).flatMap((row) => JSON.parse(row));
    const ids = claimed.map((row) => row.id);
    check(`2 parallel claims: 4 claimed in total (${ids.length}), none twice, none of another tenant`,
      ids.length === 4 && new Set(ids).size === 4 && claimed.every((row) => row.org === org), JSON.stringify(claimed));
    check('4 running and 2 still queued',
      sql(`select count(*) filter (where status = 'running') || ':' || count(*) filter (where status = 'queued') from public.agent_runs where organization_id = '${org}'`) === '4:2');
    quiesce();

    // 4. Stop against the result. Stop tends to win a dead heat, so every other round it
    // comes a few milliseconds late and the result gets its chance too.
    for (let n = 1; n <= 6; n += 1) {
      const begun = JSON.parse(sql(start(ask())));
      await together([
        `select pg_sleep(${n % 2 ? 0 : 0.02}); select public.agent_cancel_run('${org}', '${begun.run_id}', '${owner}')`,
        finalize(begun.run_id, begun.lease_token),
      ]);
      const after = run(begun.run_id);
      const ends = sql(`select count(*) from public.agent_audit_events where run_id = '${begun.run_id}' and event in ('run.completed', 'run.cancelled')`);
      check(`stop against finish #${n}: ${after.status}, lease cleared, one end`,
        ['completed', 'cancelled'].includes(after.status)
          && (after.status === 'cancelled') === (after.cancel_requested_at !== null)
          && after.lease_token === null && after.lease_expires_at === null && ends === '1',
        JSON.stringify({ status: after.status, cancel: after.cancel_requested_at, lease: after.lease_token, ends }));
    }

    // 5. The worker lost its lease, the run was taken over; the late worker reports anyway.
    const lost = JSON.parse(sql(start(ask())));
    sql(`update public.agent_runs set lease_expires_at = now() - interval '1 second' where id = '${lost.run_id}'`);
    const takenOver = JSON.parse(sql(`select coalesce(json_agg(json_build_object('id', id, 'lease', lease_token)), '[]') from public.agent_claim_runs(1, 20)`));
    check('the run is taken over', takenOver.length === 1 && takenOver[0].id === lost.run_id, JSON.stringify(takenOver));
    const [lateRecord, lateFinal, newRecord] = (await together([
      record(lost.run_id, lost.lease_token),
      finalize(lost.run_id, lost.lease_token),
      record(lost.run_id, takenOver[0]?.lease),
    ])).map((row) => JSON.parse(row));
    const now = run(lost.run_id);
    check('the late worker books nothing and finishes nothing',
      lateRecord.recorded === false && lateFinal.finalized === false && newRecord.recorded === true
        && now.status === 'running' && now.lease_token === takenOver[0]?.lease && Number(now.tokens_in) === 100,
      JSON.stringify({ lateRecord, lateFinal, newRecord, status: now.status, tokensIn: now.tokens_in }));
    check('the new worker still finishes it',
      JSON.parse(sql(finalize(lost.run_id, takenOver[0]?.lease))).finalized === true);

    // 6. Five Confirms of one proposal at the same instant (1.14): exactly one claim.
    const proposing = JSON.parse(sql(start(ask())));
    sql(`select public.agent_finalize_run('${proposing.run_id}', '${proposing.lease_token}', 'completed', null, 'conversation', '{}',
         '[{"kind": "task", "intent": {"title": "race"}, "resolved": {"confirmable": true}}]', null)`);
    const action = sql(`select id from public.agent_actions where run_id = '${proposing.run_id}'`);
    const claims = (await together(Array.from({ length: 5 }, () =>
      `select count(*) from public.agent_claim_actions('${org}', '${proposing.run_id}', '${owner}', '{"${action}": 1}')`,
    ))).map(Number);
    const confirmed = sql(`select count(*) from public.agent_audit_events where action_id = '${action}' and event = 'action.confirmed'`);
    const state = sql(`select status || ':' || attempts from public.agent_actions where id = '${action}'`);
    check(`5 parallel confirms of one proposal: 1 claim (${claims.join('+')}), 1 action.confirmed (${confirmed}), executing once (${state})`,
      claims.reduce((a, b) => a + b, 0) === 1 && confirmed === '1' && state === 'executing:1');
  } finally {
    // Everything hangs off the organization (cascade); the bypass lets its sole owner go.
    sql(`begin; set local app.allow_orphan_org = 'true';
         delete from public.organizations where id = '${org}';
         delete from public.users where id in ('${owner}', '${member}');
         commit;`);
  }
  check('the throwaway organization and its users are gone',
    sql(`select (select count(*) from public.organizations where id = '${org}') + (select count(*) from public.users where id in ('${owner}', '${member}'))`) === '0');

  console.log(failures.length ? `robert race: ${failures.length} FAILED` : 'robert race: all checks passed');
  if (failures.length) process.exit(1);
}

/** Robert 1.21: Undo meeting another Undo, a comment or a new task, on committed rows of a throwaway org. */
async function undoRace() {
  const failures = [];
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
    if (!ok) failures.push(name);
  };
  const org = crypto.randomUUID();
  const [me, other, space, trigger, agent, run] = Array.from({ length: 6 }, () => crypto.randomUUID());
  const tag = `robert-undo-race-${org.slice(0, 8)}`;
  const conv = () => sql(`select id from public.chat_conversations where organization_id = '${org}' limit 1`);

  sql(`insert into public.organizations (id, name, slug, size) values ('${org}', '${tag}', '${tag}', '1-10');
       insert into public.users (id, email, first_name, last_name, is_active) values
         ('${me}', '${tag}-a@example.invalid', 'Anna', 'Race', true),
         ('${other}', '${tag}-b@example.invalid', 'Bert', 'Race', true);
       insert into public.organization_members (organization_id, user_id, role) values ('${org}', '${me}', 'owner'), ('${org}', '${other}', 'member');
       insert into public.spaces (id, organization_id, name, key) values ('${space}', '${org}', '${tag}', 'RACE${org.slice(0, 4).toUpperCase()}');
       select chat_create_group('${org}', '${me}', '${tag}', array['${other}']::uuid[]);`);
  const seq = sql(`select m.message_seq from chat_post_message('${org}', '${conv()}', '${trigger}', '${me}', '<p>@Robert</p>', '@Robert') m`);
  sql(`select chat_append_message('${org}', '${conv()}', '${agent}', 'agent', NULL, '', '', NULL, NULL, NULL, jsonb_build_object('run_id', '${run}'));
       insert into public.agent_runs (id, organization_id, conversation_id, trigger_message_id, agent_message_id, invoker_id, status, visibility, deadline_at, budget_month, budget_day, trigger_seq, finished_at)
       values ('${run}', '${org}', '${conv()}', '${trigger}', '${agent}', '${me}', 'completed', 'invoker', now(), date_trunc('month', now())::date, now()::date, ${seq}, now());`);

  let ordinal = 0;
  const own = (kind, id) =>
    sql(`insert into public.agent_actions (organization_id, run_id, ordinal, kind, status, intent, entity_type, entity_id, executed_at, undo_until, expires_at)
         values ('${org}', '${run}', ${++ordinal}, '${kind}', 'executed', '{}', '${kind === 'subtask' ? 'task' : kind}', '${id}', now(), now() + interval '10 minutes', now() + interval '1 day')
         returning id`);
  const task = () => {
    const id = crypto.randomUUID();
    sql(`insert into public.tasks (id, organization_id, space_id, task_type_id, summary, created_by, updated_by) values ('${id}', '${org}', '${space}', 'task', 'Race', '${me}', '${me}')`);
    own('task', id);
    return id;
  };
  const page = () => {
    const id = crypto.randomUUID();
    sql(`insert into public.wiki_pages (id, organization_id, space_id, title, slug, content, created_by, updated_by) values ('${id}', '${org}', '${space}', 'Race', 'race-${id}', '<p>x</p>', '${me}', '${me}')`);
    own('wiki_page', id);
    return id;
  };
  const process_ = () => {
    const id = crypto.randomUUID();
    sql(`insert into public.business_processes (id, organization_id, space_id, title, request_type, created_by, updated_by) values ('${id}', '${org}', '${space}', 'Race', 'Prozessbewertung', '${me}', '${me}')`);
    own('process', id);
    return id;
  };
  const undoTask = (id) => `select agent_undo_task('${org}', '${id}', '${me}', now(), '${run}')`;
  const undoPage = (id) => `select agent_undo_wiki_page('${org}', '${id}', '${me}', now(), '${run}')`;
  const undoProcess = (id) => `select agent_undo_process('${org}', '${id}', '${me}', now(), '${run}')`;
  const taskComment = (id) => `insert into public.task_comments (task_id, organization_id, content, created_by) values ('${id}', '${org}', 'race', '${other}')`;
  const held = (statement) => `begin; ${statement}; select pg_sleep(1.5); commit`;
  const after = (statement) => `select pg_sleep(0.5); ${statement}`;

  try {
    // Undo against Undo, at the same instant.
    let id = task();
    const at = new Date(Date.now() + 1500).toISOString();
    const both = await Promise.allSettled(
      [1, 2].map(() => sqlSession(`select pg_sleep_until('${at}');\n${undoTask(id)};\n`)),
    );
    check('Undo vs Undo: the task is gone once, and nothing is left', sql(`select count(*) from public.tasks where id = '${id}'`) === '0', JSON.stringify(both).slice(0, 200));

    // The claim is what stops a second press: exactly one wins.
    id = task();
    const act = sql(`select id from public.agent_actions where entity_id = '${id}'`);
    const claims = await Promise.all([1, 2].map(() =>
      sqlSession(`select pg_sleep_until('${new Date(Date.now() + 1500).toISOString()}'); select count(*) from agent_claim_undo('${org}', '${me}', false, array['${act}']::uuid[]);`)));
    check('Two claims at once: one wins', claims.map(Number).sort().join() === '0,1', claims.join());
    sql(`update public.agent_actions set status = 'executed', exec_token = null, undone_by = null where id = '${act}'`);

    // A comment first: Undo waits for it, sees it, and leaves the task.
    id = task();
    let [a, b] = await Promise.allSettled([sqlSession(held(taskComment(id))), sqlSession(after(undoTask(id)))]);
    check('Comment first: Undo reports it and the task stays',
      b.status === 'fulfilled' && b.value.includes('has_comments') && sql(`select count(*) from public.tasks where id = '${id}'`) === '1',
      JSON.stringify(b).slice(0, 200));

    // Undo first: the comment waits and fails on the key. No deleted task with a surviving comment.
    id = task();
    [a, b] = await Promise.allSettled([sqlSession(held(undoTask(id))), sqlSession(after(taskComment(id)))]);
    check('Undo first: the task goes and the comment is refused',
      a.status === 'fulfilled' && b.status === 'rejected' && sql(`select count(*) from public.tasks where id = '${id}'`) === '0',
      JSON.stringify([a, b]).slice(0, 240));

    // A task a person adds under a process, both ways. It is never deleted with the process.
    const addTask = (p, t) => `insert into public.tasks (id, organization_id, space_id, task_type_id, summary, process_id, created_by, updated_by) values ('${t}', '${org}', '${space}', 'task', 'theirs', '${p}', '${other}', '${other}')`;
    let p = process_();
    let theirs = crypto.randomUUID();
    [a, b] = await Promise.allSettled([sqlSession(held(addTask(p, theirs))), sqlSession(after(undoProcess(p)))]);
    check('Their task first: Undo of the process is blocked, and the task stands',
      b.status === 'fulfilled' && b.value.includes('has_tasks') && sql(`select count(*) from public.tasks where id = '${theirs}'`) === '1',
      JSON.stringify(b).slice(0, 200));
    p = process_();
    theirs = crypto.randomUUID();
    [a, b] = await Promise.allSettled([sqlSession(held(undoProcess(p))), sqlSession(after(addTask(p, theirs)))]);
    check('Undo of the process first: their task is refused, nothing half done',
      b.status === 'rejected' && sql(`select count(*) from public.business_processes where id = '${p}'`) === '0',
      JSON.stringify([a, b]).slice(0, 240));

    // A comment on a page, both ways. A page stays in the archive, so a late comment lands there.
    const pageComment = (w) => `insert into public.wiki_page_comments (wiki_page_id, content, created_by) values ('${w}', 'race', '${other}')`;
    let w = page();
    [a, b] = await Promise.allSettled([sqlSession(held(pageComment(w))), sqlSession(after(undoPage(w)))]);
    check('Comment on a page first: Undo reports it and the page stays',
      b.status === 'fulfilled' && b.value.includes('has_comments') && sql(`select is_archived from public.wiki_pages where id = '${w}'`) === 'f',
      JSON.stringify(b).slice(0, 200));
    w = page();
    [a, b] = await Promise.allSettled([sqlSession(held(undoPage(w))), sqlSession(after(pageComment(w)))]);
    check('Undo of a page first: archived, and a late comment is kept on it',
      a.status === 'fulfilled' && sql(`select is_archived from public.wiki_pages where id = '${w}'`) === 't',
      JSON.stringify(a).slice(0, 200));
  } finally {
    sql(`begin; set local app.allow_orphan_org = 'true';
         delete from public.tasks where organization_id = '${org}';
         delete from public.organizations where id = '${org}';
         delete from public.users where id in ('${me}', '${other}');
         commit;`);
  }
  console.log(failures.length ? `undo race: ${failures.length} FAILED` : 'undo race: all checks passed');
  if (failures.length) process.exit(1);
}

/** Robert 1.22: plans and plan items meeting a person or each other, on committed rows of a throwaway org. */
async function plansRace() {
  const failures = [];
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
    if (!ok) failures.push(name);
  };
  const org = crypto.randomUUID();
  const [me, other, space, trigger, agent, run] = Array.from({ length: 6 }, () => crypto.randomUUID());
  const tag = `robert-plans-race-${org.slice(0, 8)}`;
  const conv = () => sql(`select id from public.chat_conversations where organization_id = '${org}' limit 1`);

  sql(`insert into public.organizations (id, name, slug, size) values ('${org}', '${tag}', '${tag}', '1-10');
       insert into public.users (id, email, first_name, last_name, is_active) values
         ('${me}', '${tag}-a@example.invalid', 'Anna', 'Race', true),
         ('${other}', '${tag}-b@example.invalid', 'Bert', 'Race', true);
       insert into public.organization_members (organization_id, user_id, role) values ('${org}', '${me}', 'owner'), ('${org}', '${other}', 'member');
       insert into public.spaces (id, organization_id, name, key) values ('${space}', '${org}', '${tag}', 'PLR${org.slice(0, 4).toUpperCase()}');
       select chat_create_group('${org}', '${me}', '${tag}', array['${other}']::uuid[]);`);
  const seq = sql(`select m.message_seq from chat_post_message('${org}', '${conv()}', '${trigger}', '${me}', '<p>@Robert</p>', '@Robert') m`);
  sql(`select chat_append_message('${org}', '${conv()}', '${agent}', 'agent', NULL, '', '', NULL, NULL, NULL, jsonb_build_object('run_id', '${run}'));
       insert into public.agent_runs (id, organization_id, conversation_id, trigger_message_id, agent_message_id, invoker_id, status, visibility, deadline_at, budget_month, budget_day, trigger_seq, finished_at)
       values ('${run}', '${org}', '${conv()}', '${trigger}', '${agent}', '${me}', 'completed', 'invoker', now(), date_trunc('month', now())::date, now()::date, ${seq}, now());`);

  let ordinal = 0;
  const own = (kind, id) =>
    sql(`insert into public.agent_actions (organization_id, run_id, ordinal, kind, status, intent, entity_type, entity_id, executed_at, undo_until, expires_at)
         values ('${org}', '${run}', ${++ordinal}, '${kind}', 'executed', '{}', '${kind === 'plan_item' ? 'task' : kind}', '${id}', now(), now() + interval '10 minutes', now() + interval '1 day')
         returning id`);
  const plan = () => {
    const id = crypto.randomUUID();
    sql(`insert into public.plans (id, organization_id, space_id, name, created_by) values ('${id}', '${org}', '${space}', 'Race plan', '${me}');
         insert into public.plan_permissions (plan_id, user_id, permission_level) values ('${id}', '${me}', 'admin');`);
    own('plan', id);
    return id;
  };
  const newTask = (by = me) => {
    const id = crypto.randomUUID();
    sql(`insert into public.tasks (id, organization_id, space_id, task_type_id, summary, created_by, updated_by) values ('${id}', '${org}', '${space}', 'task', 'Race item', '${by}', '${by}')`);
    return id;
  };
  const link = (p, t) => `select agent_plan_item_link('${org}', '${p}', '${t}', 'task', null)`;
  const item = (p) => {
    const t = newTask();
    sql(link(p, t));
    own('plan_item', t);
    return t;
  };
  const undoPlan = (p) => `select agent_undo_plan('${org}', '${p}', '${me}', now() - interval '1 second', '${run}')`;
  const undoItem = (t) => `select agent_undo_plan_item('${org}', '${t}', '${me}', now() - interval '1 second', '${run}')`;
  const personAdds = (p, t) => `insert into public.plan_tasks (plan_id, task_id, item_type, sort_order) values ('${p}', '${t}', 'task', 99)`;
  const baseline = (p) => `insert into public.plan_baselines (plan_id, name, snapshot_data, created_by) values ('${p}', 'race', '{}', '${other}')`;
  const held = (statement) => `begin; ${statement}; select pg_sleep(1.5); commit`;
  const after = (statement) => `select pg_sleep(0.5); ${statement}`;

  try {
    // Ten Confirms put an item into the same plan at the same instant: ten places, no two alike.
    let p = plan();
    const tasks = Array.from({ length: 10 }, () => newTask());
    const at = new Date(Date.now() + 2000).toISOString();
    await Promise.all(tasks.map((t) => sqlSession(`select pg_sleep_until('${at}');\n${link(p, t)};\n`)));
    const orders = sql(`select string_agg(sort_order::text, ',' order by sort_order) from public.plan_tasks where plan_id = '${p}'`);
    check('Ten links at once: every item placed, ten different positions', orders === '1,2,3,4,5,6,7,8,9,10', orders);

    // A person's item first: Undo of the plan sees it and leaves everything.
    p = plan();
    let theirs = newTask(other);
    let [a, b] = await Promise.allSettled([sqlSession(held(personAdds(p, theirs))), sqlSession(after(undoPlan(p)))]);
    check('Their item first: Undo of the plan is blocked, plan and item stand',
      b.status === 'fulfilled' && b.value.includes('has_items') && sql(`select count(*) from public.plan_tasks where task_id = '${theirs}'`) === '1',
      JSON.stringify(b).slice(0, 200));

    // Undo of the plan first: the person's add waits, then fails on the key. Their task is untouched.
    p = plan();
    theirs = newTask(other);
    [a, b] = await Promise.allSettled([sqlSession(held(undoPlan(p))), sqlSession(after(personAdds(p, theirs)))]);
    check('Undo of the plan first: their add is refused, their task stands, no link left',
      a.status === 'fulfilled' && b.status === 'rejected' && sql(`select count(*) from public.plans where id = '${p}'`) === '0' &&
        sql(`select count(*) from public.tasks where id = '${theirs}'`) === '1',
      JSON.stringify([a, b]).slice(0, 240));

    // A baseline first: Undo of the item sees it. Undo first: the baseline waits and is taken after.
    p = plan();
    let t = item(p);
    [a, b] = await Promise.allSettled([sqlSession(held(baseline(p))), sqlSession(after(undoItem(t)))]);
    check('Baseline first: Undo of the item is blocked, the item stands',
      b.status === 'fulfilled' && b.value.includes('baseline_taken') && sql(`select count(*) from public.tasks where id = '${t}'`) === '1',
      JSON.stringify(b).slice(0, 200));
    p = plan();
    t = item(p);
    [a, b] = await Promise.allSettled([sqlSession(held(undoItem(t))), sqlSession(after(baseline(p)))]);
    check('Undo of the item first: the item goes, then the baseline is taken without it',
      a.status === 'fulfilled' && b.status === 'fulfilled' && sql(`select count(*) from public.tasks where id = '${t}'`) === '0',
      JSON.stringify([a, b]).slice(0, 240));

    // Undo against Undo of one item.
    p = plan();
    t = item(p);
    const at2 = new Date(Date.now() + 1500).toISOString();
    await Promise.allSettled([1, 2].map(() => sqlSession(`select pg_sleep_until('${at2}');\n${undoItem(t)};\n`)));
    check('Undo vs Undo of an item: gone once, its link with it',
      sql(`select count(*) from public.tasks where id = '${t}'`) === '0' && sql(`select count(*) from public.plan_tasks where task_id = '${t}'`) === '0');
  } finally {
    sql(`begin; set local app.allow_orphan_org = 'true';
         delete from public.plans where organization_id = '${org}';
         delete from public.tasks where organization_id = '${org}';
         delete from public.organizations where id = '${org}';
         delete from public.users where id in ('${me}', '${other}');
         commit;`);
  }
  check('the throwaway organization is gone', sql(`select count(*) from public.organizations where id = '${org}'`) === '0');
  console.log(failures.length ? `plans race: ${failures.length} FAILED` : 'plans race: all checks passed');
  if (failures.length) process.exit(1);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'smoke') return smoke(...args);
  if (command === 'race') return race();
  if (command === 'plans-race') return plansRace();
  if (command === 'undo-race') return undoRace();

  if (command === 'api') {
    const [email, method, path, json] = args;
    if (!email || !method || !path) {
      throw new Error('Usage: api <email> <METHOD> <path> [json-body]');
    }
    const result = await api(
      email,
      method.toUpperCase(),
      path,
      json === undefined ? undefined : JSON.parse(json),
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error('Commands: api <email> <METHOD> <path> [json-body] | smoke [email-a email-b] | race | undo-race | plans-race');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
