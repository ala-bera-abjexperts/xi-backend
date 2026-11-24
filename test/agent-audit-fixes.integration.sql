-- XE-T353 Robert audit fixes (2026-11-10): database checks.
-- Run only against a confirmed disposable database (local Supabase) with migration
-- 20261112130000_agent_audit_fixes applied. Everything is rolled back; it makes its own data:
--   psql -f test/agent-audit-fixes.integration.sql
-- Success prints "agent audit fixes integration: all checks passed"; any failure aborts with the reason.
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.ok(p_condition boolean, p_message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION 'CHECK FAILED: %', p_message;
  END IF;
END $$;

CREATE FUNCTION pg_temp.codes(p_blockers jsonb) RETURNS text
LANGUAGE sql AS $$
  SELECT coalesce(string_agg(e.item ->> 'code', ',' ORDER BY e.ord), '')
  FROM jsonb_array_elements(p_blockers) WITH ORDINALITY AS e (item, ord);
$$;

CREATE FUNCTION pg_temp.new_run(p_org uuid, p_conv uuid, p_user uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_run uuid := gen_random_uuid();
  v_trigger uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_seq bigint;
BEGIN
  SELECT m.message_seq INTO v_seq
  FROM chat_post_message(p_org, p_conv, v_trigger, p_user, '<p>@Robert</p>', '@Robert') m;
  PERFORM chat_append_message(p_org, p_conv, v_agent, 'agent', NULL, '', '', NULL, NULL, NULL,
    jsonb_build_object('run_id', v_run));
  INSERT INTO agent_runs (id, organization_id, conversation_id, trigger_message_id, agent_message_id,
    invoker_id, status, visibility, deadline_at, budget_month, budget_day, trigger_seq, finished_at)
  VALUES (v_run, p_org, p_conv, v_trigger, v_agent, p_user, 'completed', 'invoker', now(),
    date_trunc('month', now())::date, now()::date, v_seq, now());
  RETURN v_run;
END $$;

CREATE FUNCTION pg_temp.own(p_run uuid, p_kind text, p_entity uuid) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO agent_actions (organization_id, run_id, ordinal, kind, status, intent, entity_type, entity_id,
    executed_at, undo_until, expires_at)
  SELECT r.organization_id, r.id,
         (SELECT coalesce(max(a.ordinal), 0) + 1 FROM agent_actions a WHERE a.run_id = r.id),
         p_kind, 'executed', '{}'::jsonb,
         CASE WHEN p_kind IN ('task', 'subtask', 'plan_item') THEN 'task' ELSE p_kind END,
         p_entity, now(), now() + interval '10 minutes', now() + interval '24 hours'
  FROM agent_runs r WHERE r.id = p_run
  RETURNING id;
$$;

INSERT INTO organizations (id, name, slug, size) VALUES
  ('af000000-0000-4000-8000-00000000000a', 'Agent Audit IT A', 'agent-audit-it-a', '1-10');
INSERT INTO users (id, email, first_name, last_name, is_active) VALUES
  ('af000000-0000-4000-8000-000000000001', 'agent-audit-it-u1@example.invalid', 'Anna', 'Invoker', true),
  ('af000000-0000-4000-8000-000000000002', 'agent-audit-it-u2@example.invalid', 'Markus', 'Other', true);
INSERT INTO organization_members (organization_id, user_id, role) VALUES
  ('af000000-0000-4000-8000-00000000000a', 'af000000-0000-4000-8000-000000000001', 'member'),
  ('af000000-0000-4000-8000-00000000000a', 'af000000-0000-4000-8000-000000000002', 'member');
INSERT INTO spaces (id, organization_id, name, key) VALUES
  ('af000000-0000-4000-8000-0000000000e1', 'af000000-0000-4000-8000-00000000000a', 'Agent Audit IT', 'AGAUD1');

-- ---------------------------------------------------------------- every table a delete touches is classified
-- A table whose rows a task or plan delete removes (CASCADE) or rewrites (SET NULL) is either read by
-- agent_undo_blockers, or listed here as automatic or personal. A new table fails this check until
-- someone decides which it is.
DO $$
DECLARE
  v_body text := pg_get_functiondef('public.agent_undo_blockers(uuid, text, uuid, uuid, timestamptz, uuid)'::regprocedure);
  v_harmless text[] := ARRAY[
    'tasks', 'plans',                    -- the object itself and its own subtasks (has_subtasks)
    'workflow_outbox',                   -- events about the task, not work
    'board_issue_ranking',               -- a board's sort position, rebuilt by the board
    'automation_inbound_email_events',   -- an automation's log keeps its row
    'task_watchers',                     -- a personal subscription
    'task_key_aliases',                  -- old keys of the task itself
    'task_notification_mutes',           -- a personal setting
    'space_template_provisioning_runs',  -- automatic
    'plan_items_deprecated',             -- not written any more
    'plan_item_dependencies_deprecated'  -- not written any more
  ];
  v_missing text;
BEGIN
  SELECT string_agg(DISTINCT c.conrelid::regclass::text || '.' || a.attname, ', ')
  INTO v_missing
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[array_length(c.conkey, 1)]
  WHERE c.contype = 'f'
    AND c.confrelid IN ('public.tasks'::regclass, 'public.plans'::regclass)
    AND c.confdeltype IN ('c', 'n')
    AND a.attname <> 'organization_id'
    AND NOT (c.conrelid::regclass::text = ANY (v_harmless))
    AND position(c.conrelid::regclass::text IN v_body) = 0;
  PERFORM pg_temp.ok(v_missing IS NULL, 'tables a delete touches but Undo does not check: ' || coalesce(v_missing, ''));
END $$;

-- ---------------------------------------------------------------- task: the new blockers
DO $$
DECLARE
  a uuid := 'af000000-0000-4000-8000-00000000000a';
  u1 uuid := 'af000000-0000-4000-8000-000000000001';
  u2 uuid := 'af000000-0000-4000-8000-000000000002';
  s1 uuid := 'af000000-0000-4000-8000-0000000000e1';
  c uuid; r uuid; t uuid; p uuid;
  since timestamptz := now() - interval '1 minute';
BEGIN
  c := chat_create_group(a, u1, 'Agent Audit IT', ARRAY[u2]);
  r := pg_temp.new_run(a, c, u1);
  t := gen_random_uuid();
  INSERT INTO tasks (id, organization_id, space_id, task_type_id, summary, created_by, updated_by)
  VALUES (t, a, s1, 'task', 'Robert task', u1, u1);
  PERFORM pg_temp.own(r, 'task', t);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, since, r)) = '', 'a fresh task has no blockers');

  -- Rows whose foreign keys point elsewhere too: only the blocker rule is under test here.
  SET LOCAL session_replication_role = replica;

  INSERT INTO task_reminders (task_id, user_id, remind_at) VALUES (t, u1, now() + interval '1 day');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, since, r)) = 'has_links', 'a reminder blocks');
  DELETE FROM task_reminders WHERE task_id = t;

  INSERT INTO budget_splits (organization_id, overall_budget_id, task_id, amount) VALUES (a, gen_random_uuid(), t, 10);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, since, r)) = 'has_links', 'a budget split blocks');
  DELETE FROM budget_splits WHERE task_id = t;

  INSERT INTO test_executions (organization_id, space_id, task_id) VALUES (a, s1, t);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, since, r)) = 'has_links', 'a test execution blocks');
  DELETE FROM test_executions WHERE task_id = t;

  INSERT INTO test_ticket_links (organization_id, space_id, task_id, link_type, case_id)
  VALUES (a, s1, t, 'requirement', gen_random_uuid());
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, since, r)) = 'has_links', 'a test ticket link blocks');
  DELETE FROM test_ticket_links WHERE task_id = t;

  INSERT INTO portfolio_management_letters (organization_id, portfolio_id, plan_id, linked_task_id,
    reporting_period_start, reporting_period_end)
  VALUES (a, gen_random_uuid(), gen_random_uuid(), t, current_date, current_date);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, since, r)) = 'has_links',
    'a management letter linking the task blocks');
  DELETE FROM portfolio_management_letters WHERE linked_task_id = t;

  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, since, r)) = '', 'all clear again');

  -- ------------------------------------------------------------ plan: the new blockers
  p := gen_random_uuid();
  INSERT INTO plans (id, organization_id, space_id, name, created_by, status) VALUES (p, a, s1, 'Robert plan', u1, 'draft');
  INSERT INTO plan_permissions (plan_id, user_id, permission_level) VALUES (p, u1, 'admin');
  PERFORM pg_temp.own(r, 'plan', p);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = '', 'a fresh plan has no blockers');

  SET LOCAL session_replication_role = replica;
  INSERT INTO resource_budget_entries (organization_id, plan_id, entry_type, name, currency, effective_date)
  VALUES (a, p, 'planned', 'Licences', 'EUR', current_date);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'has_links', 'a budget entry blocks');
  DELETE FROM resource_budget_entries WHERE plan_id = p;

  INSERT INTO portfolio_management_letters (organization_id, portfolio_id, plan_id, reporting_period_start, reporting_period_end)
  VALUES (a, gen_random_uuid(), p, current_date, current_date);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'has_links', 'a management letter blocks');
  DELETE FROM portfolio_management_letters WHERE plan_id = p;
  SET LOCAL session_replication_role = origin;

  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = '', 'plan all clear again');
END $$;

-- ---------------------------------------------------------------- optional test-management tables
-- A database where test_ticket_links replaced the two old tables, and one where they are still there:
-- a missing table counts 0, a present one is read.
DO $$
DECLARE
  a uuid := 'af000000-0000-4000-8000-00000000000a';
  t uuid := gen_random_uuid();
BEGIN
  PERFORM pg_temp.ok(agent_count_if_exists('no_such_table_it', 'task_id', t) = 0, 'a missing table counts 0');
  IF to_regclass('public.test_run_defects') IS NULL THEN
    CREATE TABLE public.test_run_defects (task_id uuid);
    INSERT INTO public.test_run_defects VALUES (t);
    PERFORM pg_temp.ok(agent_count_if_exists('test_run_defects', 'task_id', t) = 1, 'a present old table is read');
    DROP TABLE public.test_run_defects;
  END IF;
  PERFORM pg_temp.ok(agent_count_if_exists('tasks', 'id', gen_random_uuid()) = 0, 'no row, 0');
END $$;

-- ---------------------------------------------------------------- P3: races and budgets
DO $$
DECLARE
  a uuid := 'af000000-0000-4000-8000-00000000000a';
  u1 uuid := 'af000000-0000-4000-8000-000000000001';
  u2 uuid := 'af000000-0000-4000-8000-000000000002';
  s1 uuid := 'af000000-0000-4000-8000-0000000000e1';
  c uuid; r uuid; t uuid; p uuid; act uuid; tok uuid; lease uuid := gen_random_uuid();
  since timestamptz := now() - interval '1 minute';
  before bigint; after bigint;
BEGIN
  c := chat_create_group(a, u1, 'Agent Audit IT P3', ARRAY[u2]);
  r := pg_temp.new_run(a, c, u1);

  -- A plan row updated after Robert's write, with no audit row for it: someone changed it.
  p := gen_random_uuid();
  INSERT INTO plans (id, organization_id, space_id, name, created_by, status) VALUES (p, a, s1, 'P3 plan', u1, 'draft');
  INSERT INTO plan_permissions (plan_id, user_id, permission_level) VALUES (p, u1, 'admin');
  PERFORM pg_temp.own(r, 'plan', p);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = '', 'untouched plan');
  SET LOCAL session_replication_role = replica;
  UPDATE plans SET name = 'Renamed', updated_at = now() + interval '1 minute' WHERE id = p;
  SET LOCAL session_replication_role = origin;
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'changed_by_other',
    'an unlogged edit of the plan blocks');
  -- The invoker's own edit, logged, explains it.
  INSERT INTO audit_logs (organization_id, user_id, action, entity_type, entity_id) VALUES (a, u1, 'update', 'plan', p);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = '', 'the invoker''s logged edit does not');

  -- No Undo while a Confirm of the run is creating; after it, yes.
  t := gen_random_uuid();
  INSERT INTO tasks (id, organization_id, space_id, task_type_id, summary, created_by, updated_by)
  VALUES (t, a, s1, 'task', 'P3 task', u1, u1);
  act := pg_temp.own(r, 'task', t);
  PERFORM agent_mark_confirming(a, r, true);
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_claim_undo(a, u1, false, ARRAY[act])) = 0, 'no Undo during a Confirm');
  PERFORM agent_mark_confirming(a, r, false);
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_claim_undo(a, u1, false, ARRAY[act])) = 1, 'Undo after the Confirm');
  -- A mark left by a crash ends by itself.
  UPDATE agent_runs SET confirming_until = now() - interval '1 second' WHERE id = r;
  PERFORM pg_temp.ok((SELECT confirming_until <= now() FROM agent_runs WHERE id = r), 'an old mark is over');

  -- The heartbeat keeps only this claim fresh.
  SELECT exec_token INTO tok FROM agent_actions WHERE id = act;
  UPDATE agent_actions SET exec_started_at = now() - interval '10 minutes' WHERE id = act;
  PERFORM pg_temp.ok(agent_touch_undo(a, ARRAY[act], ARRAY[gen_random_uuid()]) = 0, 'another token touches nothing');
  PERFORM pg_temp.ok(agent_touch_undo(a, ARRAY[act], ARRAY[tok]) = 1, 'its own token touches');
  PERFORM pg_temp.ok((SELECT exec_started_at > now() - interval '1 second' FROM agent_actions WHERE id = act), 'fresh again');

  -- Every model call counts for the person's day, also one of an instance that lost the run.
  UPDATE agent_runs SET status = 'running', lease_token = lease, finished_at = NULL, reserved_tokens = 50000 WHERE id = r;
  SELECT coalesce(max(used_tokens), 0) INTO before FROM agent_usage_counters
  WHERE organization_id = a AND scope = 'user_day' AND subject_id = u1 AND period_start = now()::date;
  PERFORM agent_record_model_call(r, lease, 100, 20, NULL, true, NULL, 5);
  PERFORM agent_record_model_call(r, gen_random_uuid(), 7, 3, NULL, true, NULL, 5);
  SELECT used_tokens INTO after FROM agent_usage_counters
  WHERE organization_id = a AND scope = 'user_day' AND subject_id = u1 AND period_start = now()::date;
  PERFORM pg_temp.ok(after - before = 130, 'the day got both calls: ' || (after - before));
  PERFORM pg_temp.ok((SELECT tokens_in + tokens_out FROM agent_runs WHERE id = r) = 120, 'the run only its own lease''s call');
  -- Finishing the run does not charge the person a second time.
  PERFORM agent_finalize_run(r, lease, 'completed', NULL, 'invoker', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb);
  PERFORM pg_temp.ok((SELECT used_tokens FROM agent_usage_counters
    WHERE organization_id = a AND scope = 'user_day' AND subject_id = u1 AND period_start = now()::date) = after,
    'finishing charges nothing more');
END $$;

\echo 'agent audit fixes integration: all checks passed'
ROLLBACK;
