-- XE-T353 Robert: database integration checks for runs, budgets, proposed actions (edit, confirm,
-- link, undo, cancel, expiry), the audit trail and Robert's private conversation.
-- Run only against a confirmed disposable database (local Supabase or the xisuite-infra harness)
-- with migrations 20261014130000 and 20261014130100 applied. Everything is rolled back. It creates
-- its own two organizations, users, spaces and conversations, so it needs no parameters:
--   psql -f test/chat-agent.integration.sql
-- Success prints "chat-agent integration: all checks passed"; any failure aborts with the reason.
--
-- Two limits decide what can be checked here. The script is ONE session in ONE transaction, so
-- now() is frozen: every time rule is checked by backdating rows. And nothing here can race:
-- parallel starts against a nearly full cap, parallel resends, two sweeps claiming at once and a
-- late worker writing after a take-over are checked by scripts/robert-verify.mjs. The same holds
-- for actions: parallel Confirms of one run (exactly one gets each action), Confirm against
-- Re-run, Cancel, Undo or the expiry sweep, two edits at the same version, two Undos, two sweeps
-- at once, and a late instance reporting after its claim was handed out again.
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.ok(p_condition boolean, p_message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION 'CHECK FAILED: %', p_message;
  END IF;
END $$;

-- Runs p_sql and requires it to fail with SQLSTATE p_state.
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_state text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> p_state THEN
      RAISE EXCEPTION 'CHECK FAILED: expected SQLSTATE % but got % (%) for: %', p_state, SQLSTATE, SQLERRM, p_sql;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'CHECK FAILED: expected SQLSTATE % but statement succeeded: %', p_state, p_sql;
END $$;

-- Posts a typed message (a request to Robert) and returns its id.
CREATE FUNCTION pg_temp.say(p_org uuid, p_conversation uuid, p_author uuid, p_thread_root uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  PERFORM public.chat_post_message(p_org, p_conversation, v_id, p_author, '<p>@Robert bitte</p>', '@Robert bitte', p_thread_root);
  RETURN v_id;
END $$;

-- agent_start_run with test defaults, so each check only names what it sets: the clock is
-- frozen, so without them every run of this script would count towards "6 per minute".
CREATE FUNCTION pg_temp.start(
  p_org uuid, p_trigger uuid, p_invoker uuid, p_reserve bigint DEFAULT 1000, p_timezone text DEFAULT NULL,
  p_rerun_of uuid DEFAULT NULL, p_refusal text DEFAULT NULL, p_rate int DEFAULT 1000000, p_max_running int DEFAULT 1000000
) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT public.agent_start_run(p_org, p_trigger, p_invoker, p_reserve, p_timezone, p_rerun_of, p_refusal, p_rate, p_max_running);
$$;

-- Finishes a run with whatever lease it holds right now.
CREATE FUNCTION pg_temp.finish(p_run uuid, p_status text DEFAULT 'completed', p_actions jsonb DEFAULT '[]'::jsonb, p_result jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT public.agent_finalize_run(p_run, (SELECT r.lease_token FROM public.agent_runs r WHERE r.id = p_run), p_status, NULL, NULL, p_result, p_actions, NULL);
$$;

-- p_n task proposals.
CREATE FUNCTION pg_temp.actions(p_n int) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'task', 'intent', jsonb_build_object('n', i)) ORDER BY i), '[]'::jsonb)
  FROM generate_series(1, p_n) AS i;
$$;

-- The refusal code of a start, forgetting the refused run so the same request can be tried again.
CREATE FUNCTION pg_temp.refusal_then_forget(p_res jsonb) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.agent_runs r WHERE r.id = (p_res ->> 'run_id')::uuid AND r.status = 'refused';
  RETURN p_res ->> 'refusal';
END $$;

-- Ends every live run of the two test organizations, so a block starts from "nothing running".
CREATE FUNCTION pg_temp.quiesce() RETURNS void
LANGUAGE sql AS $$
  UPDATE public.agent_runs r
  SET status = 'failed', error_code = 'test', lease_token = NULL, lease_expires_at = NULL, finished_at = now()
  WHERE r.status IN ('queued', 'running')
    AND r.organization_id IN ('a9e00000-0000-4000-8000-00000000000a', 'a9e00000-0000-4000-8000-00000000000b');
$$;

-- Robert settings of an organization (defaults = switched on, no caps), and counters back to zero.
CREATE FUNCTION pg_temp.settings(
  p_org uuid, p_enabled boolean DEFAULT true, p_allow_in_dms boolean DEFAULT true,
  p_monthly bigint DEFAULT NULL, p_daily bigint DEFAULT NULL, p_store_prompts boolean DEFAULT false
) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO public.agent_settings (organization_id, enabled, allow_in_dms, monthly_token_cap, user_daily_token_cap, store_prompts)
  VALUES (p_org, p_enabled, p_allow_in_dms, p_monthly, p_daily, p_store_prompts)
  ON CONFLICT (organization_id) DO UPDATE
  SET enabled = EXCLUDED.enabled, allow_in_dms = EXCLUDED.allow_in_dms, monthly_token_cap = EXCLUDED.monthly_token_cap,
      user_daily_token_cap = EXCLUDED.user_daily_token_cap, store_prompts = EXCLUDED.store_prompts;
  UPDATE public.agent_usage_counters c
  SET used_tokens = 0, alert80_at = NULL, alert100_at = NULL
  WHERE c.organization_id = p_org;
$$;

CREATE FUNCTION pg_temp.conv(p_title text) RETURNS uuid
LANGUAGE sql AS $$
  SELECT c.id FROM public.chat_conversations c
  WHERE c.title = p_title
    AND c.organization_id IN ('a9e00000-0000-4000-8000-00000000000a', 'a9e00000-0000-4000-8000-00000000000b');
$$;

-- A finished run of p_user in p_conversation with p_n task proposals; returns the run id.
CREATE FUNCTION pg_temp.proposed(p_org uuid, p_conversation uuid, p_user uuid, p_n int DEFAULT 1, p_visibility text DEFAULT 'conversation') RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_run uuid := (pg_temp.start(p_org, pg_temp.say(p_org, p_conversation, p_user), p_user) ->> 'run_id')::uuid;
BEGIN
  PERFORM public.agent_finalize_run(v_run, (SELECT r.lease_token FROM public.agent_runs r WHERE r.id = v_run),
    'completed', NULL, p_visibility, '{}', pg_temp.actions(p_n), NULL);
  RETURN v_run;
END $$;

-- The action at position p_ordinal of a run, as it is stored right now.
CREATE FUNCTION pg_temp.act(p_run uuid, p_ordinal int) RETURNS public.agent_actions
LANGUAGE sql AS $$
  SELECT a.* FROM public.agent_actions a WHERE a.run_id = p_run AND a.ordinal = p_ordinal;
$$;

-- What Confirm sends: {"<action id>": version} for the actions of a run (all, or the positions named).
CREATE FUNCTION pg_temp.versions(p_run uuid, p_ordinals int[] DEFAULT NULL) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT coalesce(jsonb_object_agg(a.id::text, a.version), '{}'::jsonb)
  FROM public.agent_actions a
  WHERE a.run_id = p_run AND (p_ordinals IS NULL OR a.ordinal = ANY (p_ordinals));
$$;

-- Confirm and outcome in one go, as the invoker of the run.
CREATE FUNCTION pg_temp.confirm(p_run uuid, p_ordinal int, p_outcome text DEFAULT 'executed', p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_run public.agent_runs;
  v_claim public.agent_actions;
BEGIN
  SELECT * INTO v_run FROM public.agent_runs r WHERE r.id = p_run;
  SELECT * INTO v_claim FROM public.agent_claim_actions(v_run.organization_id, p_run, v_run.invoker_id, pg_temp.versions(p_run, ARRAY[p_ordinal]));
  PERFORM pg_temp.ok(v_claim.id IS NOT NULL, format('helper: action %s claimed', p_ordinal));
  PERFORM pg_temp.ok((public.agent_complete_action(v_claim.id, v_claim.exec_token, p_outcome, p_reason, NULL, NULL) ->> 'completed')::boolean,
    format('helper: action %s is %s', p_ordinal, p_outcome));
END $$;

-- "status:reason" of every action of a run, in card order.
CREATE FUNCTION pg_temp.states(p_run uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT string_agg(a.status || ':' || coalesce(a.reason, '-'), ',' ORDER BY a.ordinal) FROM public.agent_actions a WHERE a.run_id = p_run;
$$;

CREATE FUNCTION pg_temp.rev(p_run uuid) RETURNS bigint
LANGUAGE sql AS $$
  SELECT r.rev FROM public.agent_runs r WHERE r.id = p_run;
$$;

-- How many audit rows a run has for an event.
CREATE FUNCTION pg_temp.audits(p_run uuid, p_event text) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*) FROM public.agent_audit_events e WHERE e.run_id = p_run AND e.event = p_event;
$$;

-- ---------------------------------------------------------------- fixtures
-- Org A: u1 owner, u2..u4 members.  Org B: u9 owner, and u1 is a member there too (the same
-- person in two organizations).  s1, s2 = spaces of A, s9 = space of B.
INSERT INTO organizations (id, name, slug, size) VALUES
  ('a9e00000-0000-4000-8000-00000000000a', 'Agent IT A', 'agent-it-a', '1-10'),
  ('a9e00000-0000-4000-8000-00000000000b', 'Agent IT B', 'agent-it-b', '1-10');
INSERT INTO users (id, email, first_name) VALUES
  ('a9e00000-0000-4000-8000-000000000001', 'agent-it-u1@example.invalid', 'U1'),
  ('a9e00000-0000-4000-8000-000000000002', 'agent-it-u2@example.invalid', 'U2'),
  ('a9e00000-0000-4000-8000-000000000003', 'agent-it-u3@example.invalid', 'U3'),
  ('a9e00000-0000-4000-8000-000000000004', 'agent-it-u4@example.invalid', 'U4'),
  ('a9e00000-0000-4000-8000-000000000009', 'agent-it-u9@example.invalid', 'U9');
INSERT INTO organization_members (organization_id, user_id, role) VALUES
  ('a9e00000-0000-4000-8000-00000000000a', 'a9e00000-0000-4000-8000-000000000001', 'owner'),
  ('a9e00000-0000-4000-8000-00000000000a', 'a9e00000-0000-4000-8000-000000000002', 'member'),
  ('a9e00000-0000-4000-8000-00000000000a', 'a9e00000-0000-4000-8000-000000000003', 'member'),
  ('a9e00000-0000-4000-8000-00000000000a', 'a9e00000-0000-4000-8000-000000000004', 'member'),
  ('a9e00000-0000-4000-8000-00000000000b', 'a9e00000-0000-4000-8000-000000000009', 'owner'),
  ('a9e00000-0000-4000-8000-00000000000b', 'a9e00000-0000-4000-8000-000000000001', 'member');
INSERT INTO spaces (id, organization_id, name, key) VALUES
  ('a9e00000-0000-4000-8000-0000000000e1', 'a9e00000-0000-4000-8000-00000000000a', 'Agent IT Space', 'AGIT1'),
  ('a9e00000-0000-4000-8000-0000000000e2', 'a9e00000-0000-4000-8000-00000000000a', 'Agent IT Second', 'AGIT2'),
  ('a9e00000-0000-4000-8000-0000000000e9', 'a9e00000-0000-4000-8000-00000000000b', 'Agent IT B Space', 'AGIT9');

DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
BEGIN
  PERFORM chat_create_group(a, 'a9e00000-0000-4000-8000-000000000001', 'Agent IT main',
    ARRAY['a9e00000-0000-4000-8000-000000000002', 'a9e00000-0000-4000-8000-000000000003']::uuid[]);
  PERFORM chat_create_group(a, 'a9e00000-0000-4000-8000-000000000004', 'Agent IT budget',
    ARRAY['a9e00000-0000-4000-8000-000000000003']::uuid[]);
  PERFORM chat_create_group(b, 'a9e00000-0000-4000-8000-000000000009', 'Agent IT B',
    ARRAY['a9e00000-0000-4000-8000-000000000001']::uuid[]);
END $$;

-- ---------------------------------------------------------------- grants and wiring
DO $$
DECLARE
  t text;
  f record;
  every text := 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER';
BEGIN
  FOREACH t IN ARRAY ARRAY['public.agent_settings', 'public.agent_runs', 'public.agent_actions',
                           'public.agent_audit_events', 'public.agent_usage_counters', 'public.agent_object_origins'] LOOP
    PERFORM pg_temp.ok((SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass), t || ' has RLS enabled');
    PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = t::regclass), t || ' has no policies');
    PERFORM pg_temp.ok(NOT has_table_privilege('anon', t, every) AND NOT has_table_privilege('authenticated', t, every)
      AND NOT has_table_privilege('public', t, every), t || ' is closed to anon, authenticated and PUBLIC');
    PERFORM pg_temp.ok(has_table_privilege('service_role', t, 'SELECT') AND has_table_privilege('service_role', t, 'INSERT'),
      t || ' can be read and added to by service_role');
    PERFORM pg_temp.ok(t = 'public.agent_audit_events'
      OR (has_table_privilege('service_role', t, 'UPDATE') AND has_table_privilege('service_role', t, 'DELETE')),
      t || ' can be changed by service_role');
  END LOOP;

  -- The audit trail: add and read only, one foreign key (the organization), one trigger (BEFORE UPDATE, per row).
  PERFORM pg_temp.ok(NOT has_table_privilege('service_role', 'public.agent_audit_events', 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
    'service_role holds nothing but SELECT and INSERT on the audit trail');
  PERFORM pg_temp.ok(NOT has_sequence_privilege('service_role', 'public.agent_audit_events_seq_seq', 'USAGE, SELECT, UPDATE')
    AND NOT has_sequence_privilege('anon', 'public.agent_audit_events_seq_seq', 'USAGE, SELECT, UPDATE')
    AND NOT has_sequence_privilege('authenticated', 'public.agent_audit_events_seq_seq', 'USAGE, SELECT, UPDATE'),
    'nobody but the owner can move the audit sequence');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(confrelid = 'public.organizations'::regclass AND confdeltype = 'c')
    FROM pg_constraint WHERE conrelid = 'public.agent_audit_events'::regclass AND contype = 'f'),
    'the audit trail references the organization only');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(confrelid = 'public.organizations'::regclass AND confdeltype = 'c')
    FROM pg_constraint WHERE conrelid = 'public.agent_object_origins'::regclass AND contype = 'f'),
    'origin rows reference the organization only');
  -- tgtype 19 = ROW (1) + BEFORE (2) + UPDATE (16): no DELETE or TRUNCATE trigger.
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(tgname = 'agent_audit_events_immutable' AND tgtype = 19 AND tgenabled = 'O')
    FROM pg_trigger WHERE tgrelid = 'public.agent_audit_events'::regclass AND NOT tgisinternal),
    'the audit trail has exactly one trigger: BEFORE UPDATE per row');

  -- Functions: one of each, caller's rights, fixed search_path, service_role only, and the argument
  -- names the backend calls them by.
  FOR f IN
    SELECT e.name, e.args, e.result, p.oid, count(p.oid) OVER (PARTITION BY e.name) AS n
    FROM (VALUES
      ('agent_start_run', 'p_organization_id uuid, p_trigger_message_id uuid, p_invoker_id uuid, p_reserve bigint, p_timezone text DEFAULT NULL::text, '
        || 'p_rerun_of uuid DEFAULT NULL::uuid, p_refusal text DEFAULT NULL::text, p_rate integer DEFAULT 6, p_max_running integer DEFAULT 20', 'jsonb'),
      ('agent_claim_runs', 'p_limit integer, p_max_running integer DEFAULT 20', 'SETOF agent_runs'),
      ('agent_heartbeat', 'p_lease_tokens uuid[]', 'TABLE(run_id uuid, cancel_requested boolean)'),
      ('agent_set_step', 'p_run_id uuid, p_lease_token uuid, p_step text', 'boolean'),
      ('agent_record_model_call', 'p_run_id uuid, p_lease_token uuid, p_tokens_in bigint, p_tokens_out bigint, p_prompt_hash text, p_ok boolean, '
        || 'p_error_kind text, p_duration_ms integer', 'jsonb'),
      ('agent_finalize_run', 'p_run_id uuid, p_lease_token uuid, p_status text, p_error_code text, p_visibility text, p_result jsonb, p_actions jsonb, p_audit jsonb', 'jsonb'),
      ('agent_reap_runs', '', 'SETOF agent_runs'),
      ('agent_cancel_run', 'p_organization_id uuid, p_run_id uuid, p_actor_id uuid', 'jsonb'),
      ('agent_patch_action', 'p_organization_id uuid, p_action_id uuid, p_actor_id uuid, p_version integer, p_overrides jsonb, p_resolved jsonb, p_target_space_id uuid, '
        || 'p_scope jsonb, p_narrow boolean, p_audit jsonb', 'jsonb'),
      ('agent_claim_actions', 'p_organization_id uuid, p_run_id uuid, p_actor_id uuid, p_versions jsonb', 'SETOF agent_actions'),
      ('agent_complete_action', 'p_action_id uuid, p_exec_token uuid, p_outcome text, p_reason text, p_reason_params jsonb, p_audit jsonb', 'jsonb'),
      ('agent_link_action', 'p_organization_id uuid, p_action_id uuid, p_actor_id uuid, p_version integer, p_linked_entity_type text, p_linked_entity_id uuid, '
        || 'p_scope jsonb, p_narrow boolean', 'jsonb'),
      ('agent_claim_undo', 'p_organization_id uuid, p_actor_id uuid, p_is_admin boolean, p_action_ids uuid[]', 'SETOF agent_actions'),
      ('agent_complete_undo', 'p_action_id uuid, p_exec_token uuid, p_outcome text, p_reason text, p_reason_params jsonb, p_actor_id uuid', 'jsonb'),
      ('agent_cancel_actions', 'p_organization_id uuid, p_reason text, p_action_ids uuid[] DEFAULT NULL::uuid[], p_trigger_message_id uuid DEFAULT NULL::uuid, '
        || 'p_conversation_id uuid DEFAULT NULL::uuid, p_user_id uuid DEFAULT NULL::uuid, p_actor_id uuid DEFAULT NULL::uuid', 'integer'),
      ('agent_expire_actions', 'p_limit integer', 'integer'),
      ('agent_reclaim_stuck_actions', 'p_limit integer', 'SETOF agent_actions'),
      ('chat_get_or_create_agent_dm', 'p_organization_id uuid, p_user_id uuid, p_agent_id uuid', 'uuid')
    ) AS e (name, args, result)
    LEFT JOIN pg_proc p ON p.pronamespace = 'public'::regnamespace AND p.proname = e.name
  LOOP
    PERFORM pg_temp.ok(f.n = 1, f.name || ' exists exactly once (no PostgREST overload)');
    PERFORM pg_temp.ok(pg_get_function_arguments(f.oid) = f.args,
      format('%s keeps its argument names and defaults, got (%s)', f.name, pg_get_function_arguments(f.oid)));
    PERFORM pg_temp.ok(replace(pg_get_function_result(f.oid), 'public.', '') = f.result,
      format('%s returns %s, got %s', f.name, f.result, pg_get_function_result(f.oid)));
    PERFORM pg_temp.ok((SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public'] FROM pg_proc p WHERE p.oid = f.oid),
      f.name || ' runs with the caller''s rights and a fixed search_path');
    PERFORM pg_temp.ok(has_function_privilege('service_role', f.oid, 'EXECUTE') AND NOT has_function_privilege('anon', f.oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', f.oid, 'EXECUTE') AND NOT has_function_privilege('public', f.oid, 'EXECUTE'),
      f.name || ' is executable by service_role only');
  END LOOP;

  PERFORM pg_temp.ok((SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
    'agent_runs_active_idx', 'agent_runs_conversation_idx', 'agent_runs_invoker_idx', 'agent_actions_proposed_idx',
    'agent_actions_inflight_idx', 'agent_audit_events_org_seq_idx', 'agent_audit_events_run_idx')) = 7, 'agent indexes exist');
  PERFORM pg_temp.ok(pg_get_indexdef('public.agent_runs_active_idx'::regclass)
    LIKE '%(organization_id, created_at) WHERE (status = ANY (ARRAY[''queued''::text, ''running''::text]))', 'the live-runs index is partial');
END $$;

-- ---------------------------------------------------------------- existing tables (contract 2.1)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  g uuid := pg_temp.conv('Agent IT main');
  meta jsonb := jsonb_build_object('run_id', gen_random_uuid());
  bare uuid;
  typed uuid;
  append text := 'SELECT chat_append_message(%L, %L, NULL, %L, %L, %L, %L, NULL, NULL, NULL, %L)';
BEGIN
  PERFORM pg_temp.ok((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.chat_messages'::regclass AND conname = 'chat_messages_kind_ck')
    = 'CHECK ((kind = ANY (ARRAY[''user''::text, ''system''::text, ''agent''::text])))', 'chat_messages.kind allows user, system and agent');
  PERFORM pg_temp.ok((SELECT bool_and(convalidated) AND count(*) = 2 FROM pg_constraint WHERE conrelid = 'public.chat_messages'::regclass
    AND conname IN ('chat_messages_kind_ck', 'chat_messages_agent_shape_ck')), 'both chat_messages checks are validated');

  -- A Robert message: no author, no text, only the run id.
  bare := (chat_append_message(a, g, NULL, 'agent', NULL, '', '', NULL, NULL, NULL, meta)).id;
  PERFORM pg_temp.expect_error(format(append, a, g, 'agent', NULL, '<p>leak</p>', '', meta), '23514');  -- formatted text
  PERFORM pg_temp.expect_error(format(append, a, g, 'agent', NULL, '', 'leak', meta), '23514');          -- plain text
  PERFORM pg_temp.expect_error(format(append, a, g, 'agent', u1, '', '', meta), '23514');                -- an author
  PERFORM pg_temp.expect_error(format(append, a, g, 'agent', NULL, '', '', '{}'), '23514');              -- no run id
  PERFORM pg_temp.expect_error(format(append, a, g, 'robot', NULL, '', '', meta), '23514');              -- unknown kind
  -- ... and it can never get one afterwards.
  PERFORM pg_temp.expect_error(format('UPDATE chat_messages SET body_text = ''leak'' WHERE id = %L', bare), '23514');
  PERFORM pg_temp.expect_error(format('UPDATE chat_messages SET body_html = ''<p>leak</p>'' WHERE id = %L', bare), '23514');
  PERFORM pg_temp.expect_error(format('UPDATE chat_messages SET author_id = %L WHERE id = %L', u1, bare), '23514');
  PERFORM pg_temp.expect_error(format('UPDATE chat_messages SET metadata = ''{}'' WHERE id = %L', bare), '23514');

  -- The message functions treat it like a system note: no edit, no delete, no reply, no quote.
  PERFORM pg_temp.expect_error(format('SELECT chat_edit_message(%L, %L, %L, %L, %L)', a, bare, u1, 'x', 'x'), '42501');
  PERFORM pg_temp.expect_error(format('SELECT chat_delete_message(%L, %L, %L, true)', a, bare, u1), '42501');
  PERFORM pg_temp.expect_error(format('SELECT * FROM chat_post_message(%L, %L, %L, %L, %L, %L, %L)', a, g, gen_random_uuid(), u1, 'x', 'x', bare), '22023');
  PERFORM pg_temp.expect_error(format('SELECT * FROM chat_post_message(%L, %L, %L, %L, %L, %L, NULL, %L)', a, g, gen_random_uuid(), u1, 'x', 'x', bare), '22023');

  -- Typed messages and system notes are as before.
  typed := pg_temp.say(a, g, u1);
  PERFORM pg_temp.ok((SELECT kind = 'user' AND author_id = u1 AND body_text = '@Robert bitte' AND metadata = '{}'::jsonb FROM chat_messages WHERE id = typed),
    'a typed message keeps author and text');
  PERFORM chat_edit_message(a, typed, u1, '<p>edited</p>', 'edited');
  PERFORM pg_temp.ok(chat_delete_message(a, typed, u1), 'a typed message can still be edited and deleted');
  PERFORM pg_temp.ok((SELECT kind = 'system' AND author_id = u1 AND metadata ->> 'event' = 'group_created' FROM chat_messages WHERE conversation_id = g AND seq = 1),
    'a system note keeps its actor and event');

  -- ai_provider_configs.model: optional, 1 to 128 characters. (A row of this test's own organization.)
  INSERT INTO ai_provider_configs (organization_id, provider_name, encrypted_api_key, encryption_iv, encryption_tag)
  VALUES (a, 'openai', 'not-a-key', 'x', 'x');
  PERFORM pg_temp.ok((SELECT model IS NULL FROM ai_provider_configs WHERE organization_id = a), 'model is empty by default');
  UPDATE ai_provider_configs SET model = repeat('m', 128) WHERE organization_id = a;
  PERFORM pg_temp.expect_error(format('UPDATE ai_provider_configs SET model = '''' WHERE organization_id = %L', a), '23514');
  PERFORM pg_temp.expect_error(format('UPDATE ai_provider_configs SET model = repeat(''m'', 129) WHERE organization_id = %L', a), '23514');
  UPDATE ai_provider_configs SET model = NULL WHERE organization_id = a;
END $$;

-- ---------------------------------------------------------------- start a run (ROB-02)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  u3 uuid := 'a9e00000-0000-4000-8000-000000000003';
  g uuid := pg_temp.conv('Agent IT main');
  month date := date_trunc('month', timezone('utc', now()))::date;
  day date := timezone('utc', now())::date;
  t1 uuid; root uuid; t2 uuid; t3 uuid; gone uuid;
  res jsonb; again jsonb;
  r agent_runs; m chat_messages;
  seq0 bigint; unread1 bigint; unread2 bigint; unread3 bigint; runs0 bigint;
BEGIN
  t1 := pg_temp.say(a, g, u1);
  SELECT last_seq INTO seq0 FROM chat_conversations WHERE id = g;
  SELECT unread_count INTO unread1 FROM chat_unread_summary(a, u1) WHERE conversation_id = g;
  SELECT unread_count INTO unread2 FROM chat_unread_summary(a, u2) WHERE conversation_id = g;
  SELECT unread_count INTO unread3 FROM chat_unread_summary(a, u3) WHERE conversation_id = g;

  res := pg_temp.start(a, t1, u1, p_reserve => 60000, p_timezone => 'Europe/Vienna');
  SELECT * INTO r FROM agent_runs WHERE id = (res ->> 'run_id')::uuid;
  SELECT * INTO m FROM chat_messages WHERE id = r.agent_message_id;

  PERFORM pg_temp.ok(res ?& ARRAY['run_id', 'agent_message_id', 'seq', 'thread_root_id', 'status', 'lease_token', 'created', 'refusal', 'alert100', 'first'],
    'start returns every agreed key');
  PERFORM pg_temp.ok((res ->> 'created')::boolean AND res ->> 'status' = 'running' AND (res ->> 'lease_token')::uuid = r.lease_token
    AND (res ->> 'agent_message_id')::uuid = m.id AND (res ->> 'seq')::bigint = seq0 + 1 AND res ->> 'thread_root_id' IS NULL
    AND res ->> 'refusal' IS NULL AND NOT (res ->> 'alert100')::boolean AND (res ->> 'first')::boolean,
    format('first start: created, running, with a lease, got %s', res));
  PERFORM pg_temp.ok(r.organization_id = a AND r.conversation_id = g AND r.trigger_message_id = t1 AND r.run_no = 1 AND r.invoker_id = u1
    AND r.status = 'running' AND r.visibility = 'pending' AND r.rev = 1 AND r.error_code IS NULL AND r.is_first_for_invoker,
    'run row: who, where, running, audience undecided');
  PERFORM pg_temp.ok(r.attempts = 1 AND r.lease_token IS NOT NULL AND r.lease_expires_at = now() + interval '30 seconds'
    AND r.deadline_at = now() + interval '150 seconds' AND r.started_at = now() AND r.finished_at IS NULL AND r.cancel_requested_at IS NULL,
    'run row: lease of 30 seconds, deadline of 150 seconds');
  PERFORM pg_temp.ok(r.budget_month = month AND r.budget_day = day AND r.reserved_tokens = 60000 AND r.tokens_in = 0 AND r.tokens_out = 0
    AND r.model_calls = 0 AND r.timezone = 'Europe/Vienna', 'run row: reservation and UTC budget periods');
  PERFORM pg_temp.ok(r.trigger_seq = seq0 AND r.thread_root_id IS NULL AND r.trigger_edit_count = 0 AND r.context_message_ids = '{}'::uuid[]
    AND r.scope = '{"spaces":[],"refs":[]}'::jsonb, 'run row: the request as it was');

  -- Robert's message is empty and moves everybody's unread count by one.
  PERFORM pg_temp.ok(m.kind = 'agent' AND m.author_id IS NULL AND m.body_html = '' AND m.body_text = '' AND m.metadata = jsonb_build_object('run_id', r.id)
    AND m.seq = seq0 + 1 AND m.thread_root_id IS NULL AND m.conversation_id = g AND m.organization_id = a, 'Robert message: empty, only the run id');
  PERFORM pg_temp.ok((SELECT unread_count FROM chat_unread_summary(a, u2) WHERE conversation_id = g) = unread2 + 1
    AND (SELECT unread_count FROM chat_unread_summary(a, u3) WHERE conversation_id = g) = unread3 + 1
    AND (SELECT unread_count FROM chat_unread_summary(a, u1) WHERE conversation_id = g) = unread1 + 1,
    'a started run moves the unread count of every member by exactly one');
  PERFORM pg_temp.ok((SELECT last_message_id = m.id AND last_message_kind = 'agent' AND last_message_author_id IS NULL AND last_message_preview = ''
    FROM chat_unread_summary(a, u2) WHERE conversation_id = g), 'the inbox preview of a Robert message is empty');

  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(e.actor_id = u1 AND e.conversation_id = g AND e.organization_id = a AND e.space_id IS NULL
      AND (e.data ->> 'trigger_message_id')::uuid = t1 AND e.data ->> 'status' = 'running' AND (e.data ->> 'reserved_tokens')::bigint = 60000
      AND e.data -> 'member_ids' = (SELECT jsonb_agg(x ORDER BY x) FROM unnest(ARRAY[u1, u2, u3]) AS x))
    FROM agent_audit_events e WHERE e.run_id = r.id AND e.event = 'run.started'), 'audit: one run.started row with the audience at that moment');
  PERFORM pg_temp.ok((SELECT count(*) = 2 AND bool_and(used_tokens = 0 AND alert80_at IS NULL AND alert100_at IS NULL) FROM agent_usage_counters
    WHERE organization_id = a AND ((scope = 'org_month' AND subject_id = a AND period_start = month) OR (scope = 'user_day' AND subject_id = u1 AND period_start = day))),
    'both counter rows are created on demand');

  -- Sent twice (or the send retried): the same run, no second message, and no lease handed out again.
  again := pg_temp.start(a, t1, u1, p_reserve => 60000);
  PERFORM pg_temp.ok(NOT (again ->> 'created')::boolean AND again ->> 'run_id' = res ->> 'run_id' AND again ->> 'agent_message_id' = res ->> 'agent_message_id'
    AND again ->> 'lease_token' IS NULL AND again ->> 'status' = 'running' AND (again ->> 'seq')::bigint = seq0 + 1 AND (again ->> 'first')::boolean
    AND again ->> 'refusal' IS NULL, format('resend returns the same run without the lease, got %s', again));
  -- A gate that fails now does not turn the stored run into a refusal either.
  again := pg_temp.start(a, t1, u1, p_refusal => 'not_licensed');
  PERFORM pg_temp.ok(NOT (again ->> 'created')::boolean AND again ->> 'run_id' = res ->> 'run_id' AND again ->> 'refusal' IS NULL, 'resend with a failed gate still returns the stored run');
  PERFORM pg_temp.ok((SELECT last_seq FROM chat_conversations WHERE id = g) = seq0 + 1
    AND (SELECT count(*) FROM agent_runs WHERE trigger_message_id = t1) = 1
    AND (SELECT count(*) FROM agent_audit_events WHERE run_id = r.id) = 1
    AND (SELECT unread_count FROM chat_unread_summary(a, u2) WHERE conversation_id = g) = unread2 + 1, 'a resend changes nothing');

  -- In a thread Robert answers in the same thread and the root counts his reply.
  root := pg_temp.say(a, g, u2);
  t2 := pg_temp.say(a, g, u1, root);
  res := pg_temp.start(a, t2, u1);
  SELECT * INTO r FROM agent_runs WHERE id = (res ->> 'run_id')::uuid;
  PERFORM pg_temp.ok((res ->> 'thread_root_id')::uuid = root AND r.thread_root_id = root
    AND (SELECT thread_root_id FROM chat_messages WHERE id = r.agent_message_id) = root
    AND (SELECT reply_count = 2 AND last_reply_at IS NOT NULL FROM chat_messages WHERE id = root), 'thread: Robert replies in the thread and is counted on the root');
  PERFORM pg_temp.ok(NOT (res ->> 'first')::boolean AND NOT r.is_first_for_invoker, 'only the first run of a person is marked first');

  -- The run remembers how often the request had been edited.
  t3 := pg_temp.say(a, g, u1);
  PERFORM chat_edit_message(a, t3, u1, '<p>one</p>', 'one');
  PERFORM chat_edit_message(a, t3, u1, '<p>two</p>', 'two');
  res := pg_temp.start(a, t3, u1);
  PERFORM pg_temp.ok((SELECT trigger_edit_count FROM agent_runs WHERE id = (res ->> 'run_id')::uuid) = 2, 'trigger_edit_count is taken from the request');

  -- Not a request this person may start from: not found, and nothing is stored.
  gone := pg_temp.say(a, g, u1);
  PERFORM chat_delete_message(a, gone, u1);
  SELECT count(*) INTO runs0 FROM agent_runs;
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L)', a, gen_random_uuid(), u1), 'P0002');   -- no such message
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L)', a, t1, u2), 'P0002');                  -- not the author
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, NULL)', a, t1), 'P0002');                    -- nobody
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L)', a, gone, u1), 'P0002');                -- deleted request
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L)', a,
    (SELECT id FROM chat_messages WHERE conversation_id = g AND kind = 'system' AND author_id = u1 LIMIT 1), u1), 'P0002');  -- a system note
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L)', a, m.id, u1), 'P0002');                -- a Robert message
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L, p_reserve => -1)', a, t1, u1), '22023');
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L, p_reserve => NULL)', a, t1, u1), '22023');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_runs) = runs0, 'a start that is not found stores nothing');
END $$;

-- ---------------------------------------------------------------- refusals: every reason, in order
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  d uuid := chat_get_or_create_dm(a, u1, u2);
  month date := date_trunc('month', timezone('utc', now()))::date;
  t uuid; r0 uuid;
  res jsonb; again jsonb;
  r agent_runs;
  seq0 bigint; unread2 bigint; msgs bigint; marked timestamptz;
BEGIN
  PERFORM pg_temp.quiesce();
  t := pg_temp.say(a, d, u1);
  r0 := (pg_temp.start(a, t, u1) ->> 'run_id')::uuid;      -- run 1 of the request, still running

  -- Every reason applies at once; they are then taken away one by one.
  PERFORM pg_temp.settings(a, p_enabled => false, p_allow_in_dms => false, p_monthly => 1, p_daily => 1);
  SELECT unread_count INTO unread2 FROM chat_unread_summary(a, u2) WHERE conversation_id = d;   -- (the inbox leaves archived conversations out)
  UPDATE chat_conversations SET archived_at = now() WHERE id = d;
  SELECT last_seq INTO seq0 FROM chat_conversations WHERE id = d;
  SELECT count(*) INTO msgs FROM chat_messages WHERE conversation_id = d;

  -- 1. A gate the backend already failed wins over everything.
  res := pg_temp.start(a, t, u1, p_rerun_of => r0, p_refusal => 'no_permission', p_rate => 0);
  SELECT * INTO r FROM agent_runs WHERE id = (res ->> 'run_id')::uuid;
  PERFORM pg_temp.ok(res ->> 'refusal' = 'no_permission' AND (res ->> 'created')::boolean AND res ->> 'status' = 'refused'
    AND res ->> 'agent_message_id' IS NULL AND res ->> 'seq' IS NULL AND res ->> 'lease_token' IS NULL
    AND NOT (res ->> 'alert100')::boolean AND NOT (res ->> 'first')::boolean, format('p_refusal wins, got %s', res));
  PERFORM pg_temp.ok(r.status = 'refused' AND r.error_code = 'no_permission' AND r.visibility = 'invoker' AND r.agent_message_id IS NULL
    AND r.run_no = 2 AND r.invoker_id = u1 AND r.trigger_message_id = t AND r.conversation_id = d AND r.lease_token IS NULL
    AND r.reserved_tokens = 0 AND r.finished_at = now() AND NOT r.is_first_for_invoker, 'a refusal is a run row for the invoker only');
  PERFORM pg_temp.ok((SELECT last_seq FROM chat_conversations WHERE id = d) = seq0
    AND (SELECT count(*) FROM chat_messages WHERE conversation_id = d) = msgs, 'a refusal adds no chat message');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(e.actor_id = u1 AND e.conversation_id = d AND e.data ->> 'reason' = 'no_permission'
      AND (e.data ->> 'rerun_of')::uuid = r0) FROM agent_audit_events e WHERE e.run_id = r.id AND e.event = 'run.refused'), 'audit: run.refused');
  -- Asked again: the stored refusal comes back, whatever would apply now.
  again := pg_temp.start(a, t, u1, p_rerun_of => r0, p_rate => 0);
  PERFORM pg_temp.ok(NOT (again ->> 'created')::boolean AND again ->> 'run_id' = res ->> 'run_id' AND again ->> 'refusal' = 'no_permission',
    'a repeated refused start returns the stored refusal');
  PERFORM pg_temp.refusal_then_forget(res);

  -- 2. to 6.
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, t, u1, p_rerun_of => r0, p_rate => 0)) = 'read_only', 'then read_only');
  UPDATE chat_conversations SET archived_at = NULL WHERE id = d;
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, t, u1, p_rerun_of => r0, p_rate => 0)) = 'disabled', 'then disabled');
  PERFORM pg_temp.ok(unread2 = 2 AND (SELECT unread_count FROM chat_unread_summary(a, u2) WHERE conversation_id = d) = unread2
    AND (SELECT last_seq FROM chat_conversations WHERE id = d) = seq0, 'three refusals later nobody''s unread count has moved');
  PERFORM pg_temp.settings(a, p_allow_in_dms => false, p_monthly => 1, p_daily => 1);
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, t, u1, p_rerun_of => r0, p_rate => 0)) = 'dm_disabled', 'then dm_disabled');
  PERFORM pg_temp.settings(a, p_monthly => 1, p_daily => 1);
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, t, u1, p_rerun_of => r0, p_rate => 0)) = 'not_rerunnable', 'then not_rerunnable');
  PERFORM pg_temp.ok((pg_temp.finish(r0) ->> 'finalized')::boolean, 'run 1 finished');
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, t, u1, p_rerun_of => r0, p_rate => 0)) = 'rate_limited', 'then rate_limited');

  -- 7. budget_org: the first refusal of the month raises the 100% alert, the next ones do not.
  PERFORM pg_temp.ok((SELECT alert100_at IS NULL FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month),
    'no 100% marker before the first budget refusal');
  res := pg_temp.start(a, t, u1, p_rerun_of => r0);
  PERFORM pg_temp.ok(res ->> 'refusal' = 'budget_org' AND (res ->> 'alert100')::boolean, format('then budget_org with the alert, got %s', res));
  SELECT alert100_at INTO marked FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month;
  PERFORM pg_temp.ok(marked = now(), 'the 100% marker is set at the first budget_org refusal');
  PERFORM pg_temp.refusal_then_forget(res);
  UPDATE agent_usage_counters SET alert100_at = now() - interval '1 hour' WHERE organization_id = a AND scope = 'org_month' AND period_start = month;
  res := pg_temp.start(a, t, u1, p_rerun_of => r0);
  PERFORM pg_temp.ok(res ->> 'refusal' = 'budget_org' AND NOT (res ->> 'alert100')::boolean
    AND (SELECT alert100_at = now() - interval '1 hour' FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month),
    'the second budget_org refusal of the month raises no second alert');
  PERFORM pg_temp.refusal_then_forget(res);

  -- 8. and 9.
  PERFORM pg_temp.settings(a, p_daily => 1);
  res := pg_temp.start(a, t, u1, p_rerun_of => r0);
  PERFORM pg_temp.ok(res ->> 'refusal' = 'budget_user' AND NOT (res ->> 'alert100')::boolean
    AND (SELECT alert100_at IS NULL FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month),
    'then budget_user, which never raises the tenant alert');
  PERFORM pg_temp.refusal_then_forget(res);
  PERFORM pg_temp.settings(a);
  res := pg_temp.start(a, t, u1, p_rerun_of => r0);
  PERFORM pg_temp.ok((res ->> 'created')::boolean AND res ->> 'status' = 'running' AND res ->> 'refusal' IS NULL
    AND (SELECT run_no FROM agent_runs WHERE id = (res ->> 'run_id')::uuid) = 2, 'with nothing in the way the re-run starts as run 2');
END $$;

-- ---------------------------------------------------------------- refusals: read-only, DMs, rate limit
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  u3 uuid := 'a9e00000-0000-4000-8000-000000000003';
  u4 uuid := 'a9e00000-0000-4000-8000-000000000004';
  s2 uuid := 'a9e00000-0000-4000-8000-0000000000e2';
  robert uuid := '0b3e7000-0000-4000-8000-000000000001';
  g uuid := pg_temp.conv('Agent IT main');
  gb uuid := pg_temp.conv('Agent IT budget');
  ch uuid := chat_get_or_create_space_channel(a, s2);
  t uuid; res jsonb; i int;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);

  -- read_only through the space of a channel: archived, or being deleted.
  t := pg_temp.say(a, ch, u2);
  UPDATE spaces SET is_archived = true WHERE id = s2;
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, t, u2)) = 'read_only', 'archived space: read_only');
  UPDATE spaces SET is_archived = false, deleting_at = now() WHERE id = s2;
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, t, u2)) = 'read_only', 'space being deleted: read_only');
  UPDATE spaces SET deleting_at = NULL WHERE id = s2;
  res := pg_temp.start(a, t, u2);
  PERFORM pg_temp.ok(res ->> 'status' = 'running' AND (SELECT count(*) = 1 AND bool_and(e.space_id = s2 AND NOT e.data ? 'member_ids'
      AND e.data ->> 'conversation_kind' = 'space') FROM agent_audit_events e WHERE e.run_id = (res ->> 'run_id')::uuid AND e.event = 'run.started'),
    'active space: the run starts and the audit row names the space');

  -- dm_disabled: only DMs between people. Groups, channels and the person's own Robert conversation go on.
  PERFORM pg_temp.settings(a, p_allow_in_dms => false);
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, pg_temp.say(a, chat_get_or_create_dm(a, u1, u2), u1), u1)) = 'dm_disabled', 'DM between two people: dm_disabled');
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, pg_temp.say(a, chat_get_or_create_dm(a, u1, u1), u1), u1)) = 'dm_disabled', 'notes to self: dm_disabled');
  PERFORM pg_temp.ok(pg_temp.start(a, pg_temp.say(a, g, u1), u1) ->> 'status' = 'running', 'group: not a DM');
  PERFORM pg_temp.ok(pg_temp.start(a, pg_temp.say(a, ch, u2), u2) ->> 'status' = 'running', 'space channel: not a DM');
  PERFORM pg_temp.ok(pg_temp.start(a, pg_temp.say(a, chat_get_or_create_agent_dm(a, u1, robert), u1), u1) ->> 'status' = 'running', 'Robert conversation: always allowed');
  PERFORM pg_temp.settings(a);

  -- Rate limit: runs of one person in the last minute; refused runs do not count.
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.ok(pg_temp.start(a, pg_temp.say(a, gb, u3), u3, p_refusal => 'not_configured', p_rate => 1) ->> 'refusal' = 'not_configured', 'refused once');
  PERFORM pg_temp.ok(pg_temp.start(a, pg_temp.say(a, gb, u3), u3, p_refusal => 'not_configured', p_rate => 1) ->> 'refusal' = 'not_configured', 'refused twice');
  t := pg_temp.say(a, gb, u3);
  res := pg_temp.start(a, t, u3, p_rate => 1);
  PERFORM pg_temp.ok(res ->> 'status' = 'running', 'refused runs do not count towards the rate limit');
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, pg_temp.say(a, gb, u3), u3, p_rate => 1)) = 'rate_limited', 'one run in the last minute: the limit of 1 is reached');
  PERFORM pg_temp.ok(pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_rate => 1) ->> 'status' = 'running', 'the limit is per person');
  -- A run that ended still counts until its minute is over.
  PERFORM pg_temp.finish((res ->> 'run_id')::uuid, 'failed');
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, pg_temp.say(a, gb, u3), u3, p_rate => 1)) = 'rate_limited', 'a finished run still counts within its minute');
  UPDATE agent_runs SET created_at = now() - interval '61 seconds' WHERE id = (res ->> 'run_id')::uuid;
  PERFORM pg_temp.ok(pg_temp.start(a, pg_temp.say(a, gb, u3), u3, p_rate => 1) ->> 'status' = 'running', 'after a minute the person may start again');
  -- The built-in default is 6 per minute: one run is inside the minute, five more pass, the next is refused.
  FOR i IN 1..5 LOOP
    PERFORM pg_temp.ok(agent_start_run(a, pg_temp.say(a, gb, u3), u3, 1000) ->> 'status' = 'running', format('default rate: run %s of 6 starts', i + 1));
  END LOOP;
  PERFORM pg_temp.ok(agent_start_run(a, pg_temp.say(a, gb, u3), u3, 1000) ->> 'refusal' = 'rate_limited', 'default rate: the seventh run in a minute is refused');
END $$;

-- ---------------------------------------------------------------- budgets (ADM-03)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u3 uuid := 'a9e00000-0000-4000-8000-000000000003';
  u4 uuid := 'a9e00000-0000-4000-8000-000000000004';
  u9 uuid := 'a9e00000-0000-4000-8000-000000000009';
  gb uuid := pg_temp.conv('Agent IT budget');
  gbb uuid := pg_temp.conv('Agent IT B');
  month date := date_trunc('month', timezone('utc', now()))::date;
  day date := timezone('utc', now())::date;
  r1 uuid; r2 uuid; q uuid; res jsonb;
BEGIN
  PERFORM pg_temp.quiesce();
  -- Another organization's live runs and usage never count here.
  PERFORM pg_temp.ok(pg_temp.start(b, pg_temp.say(b, gbb, u9), u9, p_reserve => 1000000000) ->> 'status' = 'running', 'organization B holds a huge reservation');

  -- Tenant cap 10,000, reservation 4,000 per run: two fit, the third does not.
  PERFORM pg_temp.settings(a, p_monthly => 10000);
  r1 := (pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_reserve => 4000) ->> 'run_id')::uuid;
  q := (pg_temp.start(a, pg_temp.say(a, gb, u3), u3, p_reserve => 4000, p_max_running => 0) ->> 'run_id')::uuid;
  PERFORM pg_temp.ok((SELECT status FROM agent_runs WHERE id = r1) = 'running' AND (SELECT status FROM agent_runs WHERE id = q) = 'queued', 'one running, one queued');
  res := pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_reserve => 4000);
  PERFORM pg_temp.ok(res ->> 'refusal' = 'budget_org' AND (res ->> 'alert100')::boolean,
    'used 0 + reserved 8,000 (a queued run reserves too) + 4,000 passes the cap of 10,000');
  PERFORM pg_temp.ok((pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_reserve => 2001) ->> 'refusal') = 'budget_org', 'one token over the cap is refused');
  r2 := (pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_reserve => 2000) ->> 'run_id')::uuid;
  PERFORM pg_temp.ok((SELECT status FROM agent_runs WHERE id = r2) = 'running', 'exactly up to the cap is allowed');

  -- Booked tokens move from "reserved" to "used": what the tenant has committed stays 10,000.
  PERFORM agent_record_model_call(r1, (SELECT lease_token FROM agent_runs WHERE id = r1), 1000, 500, NULL, true, NULL, NULL);
  PERFORM pg_temp.ok((SELECT used_tokens FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month) = 1500, 'tenant counter: 1,500 used');
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_reserve => 1)) = 'budget_org', 'what a running run may still spend stays reserved');
  PERFORM pg_temp.ok(pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_reserve => 0) ->> 'status' = 'running', 'tokens a running run already booked are not counted twice');
  -- A finished run reserves nothing; only what it really spent stays.
  PERFORM pg_temp.finish(r1);
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_reserve => 2501)) = 'budget_org', 'after the run: 1,500 used + 6,000 reserved + 2,501 is over');
  PERFORM pg_temp.ok(pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_reserve => 2500) ->> 'status' = 'running', 'after the run: 2,500 fit again');
  -- A cancelled queued run gives its reservation back at once.
  PERFORM agent_cancel_run(a, q, u3);
  PERFORM pg_temp.ok(pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_reserve => 4000) ->> 'status' = 'running', 'a cancelled run reserves nothing');
  -- No cap never refuses.
  PERFORM pg_temp.settings(a);
  PERFORM pg_temp.ok(pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_reserve => 1000000000000) ->> 'status' = 'running', 'no cap: never refused');

  -- Per person and day, cap 5,000.
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a, p_daily => 5000);
  r1 := (pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_reserve => 3000) ->> 'run_id')::uuid;
  res := pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_reserve => 2001);
  PERFORM pg_temp.ok(res ->> 'refusal' = 'budget_user' AND NOT (res ->> 'alert100')::boolean, 'own live run 3,000 + 2,001 passes the personal cap of 5,000');
  PERFORM pg_temp.ok(pg_temp.start(a, pg_temp.say(a, gb, u3), u3, p_reserve => 5000) ->> 'status' = 'running', 'the personal cap is per person');
  -- A completed run charges the person with what it spent; a failed one does not (ADM-03 BR-4).
  PERFORM agent_record_model_call(r1, (SELECT lease_token FROM agent_runs WHERE id = r1), 1000, 200, NULL, true, NULL, NULL);
  PERFORM pg_temp.finish(r1);
  PERFORM pg_temp.ok((SELECT used_tokens FROM agent_usage_counters WHERE organization_id = a AND scope = 'user_day' AND subject_id = u4 AND period_start = day) = 1200,
    'a completed run charges the person');
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_reserve => 3801)) = 'budget_user', '1,200 used + 3,801 is over');
  r2 := (pg_temp.start(a, pg_temp.say(a, gb, u4), u4, p_reserve => 3800) ->> 'run_id')::uuid;
  PERFORM agent_record_model_call(r2, (SELECT lease_token FROM agent_runs WHERE id = r2), 900, 0, NULL, false, 'provider_down', NULL);
  PERFORM pg_temp.finish(r2, 'failed');
  PERFORM pg_temp.ok((SELECT used_tokens FROM agent_usage_counters WHERE organization_id = a AND scope = 'user_day' AND subject_id = u4 AND period_start = day) = 1200,
    'a failed run does not charge the person');
  PERFORM pg_temp.ok((SELECT used_tokens FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month) = 2100,
    'the tenant counter holds what was really spent, failed calls included');

  -- Organization B saw none of it.
  PERFORM pg_temp.ok((SELECT coalesce(sum(used_tokens), 0) FROM agent_usage_counters WHERE organization_id = b) = 0, 'organization B''s counters are untouched');
  PERFORM pg_temp.settings(a);
END $$;

-- ---------------------------------------------------------------- re-run (ROB-02 BR-7)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  g uuid := pg_temp.conv('Agent IT main');
  t uuid; other uuid; r1 uuid; r2 uuid; r3 uuid; r4 uuid; act uuid;
  res jsonb; again jsonb; rev1 bigint; st text;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  t := pg_temp.say(a, g, u1);
  r1 := (pg_temp.start(a, t, u1) ->> 'run_id')::uuid;

  -- While run 1 is still working the request cannot be run again; the refusal is stored as run 2.
  res := pg_temp.start(a, t, u1, p_rerun_of => r1);
  r2 := (res ->> 'run_id')::uuid;
  PERFORM pg_temp.ok(res ->> 'refusal' = 'not_rerunnable' AND (SELECT run_no = 2 AND status = 'refused' FROM agent_runs WHERE id = r2), 'a running run cannot be re-run');

  -- Run 1 proposes five objects; they end up in five different states.
  PERFORM pg_temp.ok((pg_temp.finish(r1, 'completed', pg_temp.actions(5)) ->> 'finalized')::boolean, 'run 1 finished with five proposals');
  UPDATE agent_actions SET status = 'failed', reason = 'no_create_permission' WHERE run_id = r1 AND ordinal = 2;
  UPDATE agent_actions SET status = 'cancelled', reason = 'user' WHERE run_id = r1 AND ordinal = 3;
  UPDATE agent_actions SET status = 'expired' WHERE run_id = r1 AND ordinal = 4;
  UPDATE agent_actions SET status = 'undone' WHERE run_id = r1 AND ordinal = 5;
  SELECT rev INTO rev1 FROM agent_runs WHERE id = r1;

  -- Re-run from the refused run 2: run 3 starts, and the open proposals of run 1 are superseded.
  res := pg_temp.start(a, t, u1, p_rerun_of => r2);
  r3 := (res ->> 'run_id')::uuid;
  PERFORM pg_temp.ok((res ->> 'created')::boolean AND res ->> 'status' = 'running' AND (SELECT run_no FROM agent_runs WHERE id = r3) = 3, 're-run starts as run 3');
  PERFORM pg_temp.ok((SELECT string_agg(status || ':' || coalesce(reason, '-'), ',' ORDER BY ordinal) FROM agent_actions WHERE run_id = r1)
    = 'cancelled:superseded,cancelled:superseded,cancelled:user,expired:-,undone:-', 'proposed and failed proposals are superseded, the others stay');
  PERFORM pg_temp.ok((SELECT rev FROM agent_runs WHERE id = r1) = rev1 + 1, 'the superseded run gets a new rev');
  PERFORM pg_temp.ok((SELECT count(*) = 2 AND bool_and(e.actor_id = u1 AND e.data ->> 'reason' = 'superseded' AND (e.data ->> 'superseded_by')::uuid = r3)
    FROM agent_audit_events e WHERE e.run_id = r1 AND e.event = 'action.cancelled'), 'audit: one action.cancelled row per superseded proposal');

  -- Re-run clicked twice: the same run, no second one.
  again := pg_temp.start(a, t, u1, p_rerun_of => r2);
  PERFORM pg_temp.ok(NOT (again ->> 'created')::boolean AND (again ->> 'run_id')::uuid = r3 AND again ->> 'lease_token' IS NULL, 'second click returns run 3');
  again := pg_temp.start(a, t, u1, p_rerun_of => r1);
  PERFORM pg_temp.ok(NOT (again ->> 'created')::boolean AND (again ->> 'run_id')::uuid = r2 AND again ->> 'refusal' = 'not_rerunnable', 're-run of run 1 is still run 2');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_runs WHERE trigger_message_id = t) = 3, 'three runs for the request, not more');

  -- p_rerun_of must be a run of this request by this person.
  other := pg_temp.say(a, g, u1);
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L, p_rerun_of => %L)', a, other, u1, r3), 'P0002');             -- run of another request
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L, p_rerun_of => %L)', a, t, u1, gen_random_uuid()), 'P0002');  -- no such run
  UPDATE agent_runs SET invoker_id = u2 WHERE id = r3;
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L, p_rerun_of => %L)', a, t, u1, r3), 'P0002');                 -- somebody else's run
  UPDATE agent_runs SET invoker_id = u1 WHERE id = r3;

  -- An object that is being created, was created, was linked or is being undone blocks the re-run.
  PERFORM pg_temp.finish(r3, 'completed', pg_temp.actions(1));
  SELECT id INTO act FROM agent_actions WHERE run_id = r3;
  FOREACH st IN ARRAY ARRAY['executing', 'executed', 'linked', 'undoing'] LOOP
    UPDATE agent_actions SET status = st, exec_token = CASE WHEN st IN ('executing', 'undoing') THEN gen_random_uuid() END WHERE id = act;
    PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, t, u1, p_rerun_of => r3)) = 'not_rerunnable', format('an action that is %s blocks the re-run', st));
  END LOOP;
  -- ... also through a refused re-run in between.
  UPDATE agent_actions SET status = 'executed', exec_token = NULL WHERE id = act;
  r4 := (pg_temp.start(a, t, u1, p_rerun_of => r3) ->> 'run_id')::uuid;
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, t, u1, p_rerun_of => r4)) = 'not_rerunnable', 'a refused re-run in between does not unblock the request');
  DELETE FROM agent_runs WHERE id = r4;
  -- An undone object does not block.
  UPDATE agent_actions SET status = 'undone' WHERE id = act;
  r4 := (pg_temp.start(a, t, u1, p_rerun_of => r3) ->> 'run_id')::uuid;
  PERFORM pg_temp.ok((SELECT status = 'running' AND run_no = 4 FROM agent_runs WHERE id = r4), 'after an undo the request can be run again');

  -- A request has at most ten runs.
  PERFORM pg_temp.finish(r4);
  UPDATE agent_runs SET run_no = 10 WHERE id = r4;
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L, p_rerun_of => %L)', a, t, u1, r4), '22023');
END $$;

-- ---------------------------------------------------------------- lease: keep-alive, step, booking, result
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  s1 uuid := 'a9e00000-0000-4000-8000-0000000000e1';
  g uuid := pg_temp.conv('Agent IT main');
  month date := date_trunc('month', timezone('utc', now()))::date;
  day date := timezone('utc', now())::date;
  bogus uuid := gen_random_uuid();
  t uuid; r uuid; lease uuid; m2 uuid;
  res jsonb; rec jsonb; fin jsonb;
  run agent_runs; rev0 bigint; audits bigint; day_used bigint;
  fin_call text := 'SELECT agent_finalize_run(%L, %L, %L, NULL, %L, %L, %L, NULL)';
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a, p_monthly => 1000);
  t := pg_temp.say(a, g, u1);
  m2 := pg_temp.say(a, g, u1);
  res := pg_temp.start(a, t, u1, p_reserve => 900);
  r := (res ->> 'run_id')::uuid;
  lease := (res ->> 'lease_token')::uuid;

  -- Keep-alive: renews what is still ours and tells us what is not.
  UPDATE agent_runs SET lease_expires_at = now() + interval '1 second' WHERE id = r;
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(h.run_id = r AND NOT h.cancel_requested) FROM agent_heartbeat(ARRAY[bogus, lease]) AS h),
    'keep-alive answers for the runs that are still ours');
  PERFORM pg_temp.ok((SELECT lease_expires_at FROM agent_runs WHERE id = r) = now() + interval '30 seconds', 'keep-alive renews the lease for 30 seconds');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_heartbeat(ARRAY[bogus])) AND NOT EXISTS (SELECT 1 FROM agent_heartbeat(ARRAY[]::uuid[]))
    AND NOT EXISTS (SELECT 1 FROM agent_heartbeat(NULL)) AND NOT EXISTS (SELECT 1 FROM agent_heartbeat(ARRAY[NULL]::uuid[])),
    'an unknown token renews nothing (and NULL never matches a queued run)');
  -- A lease that ran out but was not taken over yet is still ours.
  UPDATE agent_runs SET lease_expires_at = now() - interval '5 seconds' WHERE id = r;
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM agent_heartbeat(ARRAY[lease])), 'an expired lease nobody took over can be renewed');

  -- Thinking step.
  SELECT rev INTO rev0 FROM agent_runs WHERE id = r;
  -- (State is always read in a statement of its own: a statement does not see what a function it calls has written.)
  PERFORM pg_temp.ok(agent_set_step(r, lease, 'reading'), 'the lease holder may set the step');
  PERFORM pg_temp.ok((SELECT step = 'reading' AND rev = rev0 + 1 FROM agent_runs WHERE id = r), 'the step is stored and rev moves');
  PERFORM pg_temp.ok(NOT agent_set_step(r, bogus, 'checking') AND NOT agent_set_step(gen_random_uuid(), lease, 'checking') AND NOT agent_set_step(r, NULL, 'checking'),
    'without the lease the step is refused');
  PERFORM pg_temp.ok((SELECT step = 'reading' AND rev = rev0 + 1 FROM agent_runs WHERE id = r), 'without the lease the step is not stored');

  -- Booking model calls. Cap 1,000, so 80% is 800.
  rec := agent_record_model_call(r, lease, 300, 200, 'hash-1', true, NULL, 1234);
  PERFORM pg_temp.ok((rec ->> 'recorded')::boolean AND (rec ->> 'remaining')::bigint = 400 AND NOT (rec ->> 'alert80')::boolean, format('first call booked, got %s', rec));
  PERFORM pg_temp.ok((SELECT tokens_in = 300 AND tokens_out = 200 AND model_calls = 1 FROM agent_runs WHERE id = r)
    AND (SELECT used_tokens = 500 AND alert80_at IS NULL FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month),
    'tokens are added to the run and to the tenant counter');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(e.actor_id = u1 AND e.organization_id = a AND (e.data ->> 'call_no')::int = 1 AND (e.data ->> 'tokens_in')::int = 300
      AND (e.data ->> 'tokens_out')::int = 200 AND (e.data ->> 'ok')::boolean AND (e.data ->> 'duration_ms')::int = 1234 AND e.data ->> 'prompt_hash' = 'hash-1'
      AND e.data ->> 'step' = 'reading' AND NOT e.data ? 'error_kind') FROM agent_audit_events e WHERE e.run_id = r AND e.event = 'run.model_call'), 'audit: run.model_call');

  -- A failed call is booked as well, and this one reaches 80%: the alert is returned exactly once.
  rec := agent_record_model_call(r, lease, 250, 50, 'hash-2', false, 'rate_limited', 10);
  PERFORM pg_temp.ok((rec ->> 'recorded')::boolean AND (rec ->> 'remaining')::bigint = 100 AND (rec ->> 'alert80')::boolean, format('failed call booked, 80%% reached, got %s', rec));
  PERFORM pg_temp.ok((SELECT used_tokens = 800 AND alert80_at = now() AND alert100_at IS NULL FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month),
    'the 80% marker is set');
  PERFORM pg_temp.ok((SELECT count(*) = 1 FROM agent_audit_events e WHERE e.run_id = r AND e.event = 'run.model_call'
    AND NOT (e.data ->> 'ok')::boolean AND e.data ->> 'error_kind' = 'rate_limited'), 'audit: the failed call with its error kind');
  UPDATE agent_usage_counters SET alert80_at = now() - interval '1 hour' WHERE organization_id = a AND scope = 'org_month' AND period_start = month;
  rec := agent_record_model_call(r, lease, 300, 0, NULL, true, NULL, NULL);
  PERFORM pg_temp.ok((rec ->> 'recorded')::boolean AND (rec ->> 'remaining')::bigint = -200 AND NOT (rec ->> 'alert80')::boolean
    AND (SELECT used_tokens = 1100 AND alert80_at = now() - interval '1 hour' FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month),
    format('no second 80%% alert in the same month; remaining may go below zero, got %s', rec));
  -- Missing or negative counts are zero.
  rec := agent_record_model_call(r, lease, NULL, -5, NULL, NULL, NULL, NULL);
  PERFORM pg_temp.ok((rec ->> 'recorded')::boolean AND (SELECT tokens_in = 850 AND tokens_out = 250 AND model_calls = 4 FROM agent_runs WHERE id = r), 'missing and negative token counts are zero');

  -- Without the lease nothing is booked.
  SELECT count(*) INTO audits FROM agent_audit_events WHERE run_id = r;
  rec := agent_record_model_call(r, bogus, 100, 100, 'hash-x', true, NULL, 1);
  PERFORM pg_temp.ok(NOT (rec ->> 'recorded')::boolean AND (rec ->> 'remaining')::bigint = 0 AND NOT (rec ->> 'alert80')::boolean, format('lost lease: not recorded, got %s', rec));
  PERFORM pg_temp.ok((SELECT tokens_in = 850 AND tokens_out = 250 AND model_calls = 4 FROM agent_runs WHERE id = r)
    AND (SELECT used_tokens FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month) = 1100
    AND (SELECT count(*) FROM agent_audit_events WHERE run_id = r) = audits, 'lost lease: no tokens, no audit row');

  -- A result that does not fit is refused as invalid input and changes nothing.
  PERFORM pg_temp.expect_error(format(fin_call, r, lease, 'done', 'invoker', '{}', '[]'), '22023');                                   -- unknown status
  PERFORM pg_temp.expect_error(format(fin_call, r, lease, 'refused', 'invoker', '{}', '[]'), '22023');                                -- not a status a worker may set
  PERFORM pg_temp.expect_error(format(fin_call, r, lease, 'completed', 'everyone', '{}', '[]'), '22023');                             -- unknown audience
  PERFORM pg_temp.expect_error(format(fin_call, r, lease, 'completed', 'pending', '{}', '[]'), '22023');                              -- the audience must be decided
  PERFORM pg_temp.expect_error(format(fin_call, r, lease, 'completed', 'invoker', '[]', '[]'), '22023');                              -- result is not an object
  PERFORM pg_temp.expect_error(format(fin_call, r, lease, 'completed', 'invoker', '{}', '{"kind":"task"}'), '22023');                 -- actions are not an array
  PERFORM pg_temp.expect_error(format(fin_call, r, lease, 'completed', 'invoker', '{}', pg_temp.actions(21)), '22023');               -- more than 20 actions
  PERFORM pg_temp.expect_error(format(fin_call, r, lease, 'completed', 'invoker', '{}', '[{"kind":"email","intent":{}}]'), '22023');  -- unknown kind
  PERFORM pg_temp.expect_error(format(fin_call, r, lease, 'completed', 'invoker', '{}', '[{"kind":"task"}]'), '22023');               -- no intent
  PERFORM pg_temp.expect_error(format(fin_call, r, lease, 'completed', 'invoker', '{}', '[{"kind":"task","intent":"text"}]'), '22023'); -- intent is not an object
  PERFORM pg_temp.expect_error(format(fin_call, r, lease, 'completed', 'invoker', '{}', '[{"kind":"task","intent":{},"target_space_id":"x"}]'), '22023');
  PERFORM pg_temp.expect_error(format(fin_call, r, lease, 'completed', 'invoker', '{}', '[{"kind":"task","intent":{},"entity_type":"plan"}]'), '22023');
  PERFORM pg_temp.expect_error(format(fin_call, r, lease, 'completed', 'invoker', '{"context_message_ids":["x"]}', '[]'), '22023');
  PERFORM pg_temp.expect_error(format(fin_call, r, lease, 'completed', 'invoker', '{"more_items":"maybe"}', '[]'), '22023');
  -- A late worker without the lease is ignored.
  fin := agent_finalize_run(r, bogus, 'completed', NULL, 'conversation', '{"reply_text":"late"}', pg_temp.actions(1), NULL);
  PERFORM pg_temp.ok(NOT (fin ->> 'finalized')::boolean AND fin ->> 'status' IS NULL, format('lost lease: not finalized, got %s', fin));
  PERFORM pg_temp.ok((SELECT status = 'running' AND lease_token = lease AND reply_text IS NULL FROM agent_runs WHERE id = r)
    AND NOT EXISTS (SELECT 1 FROM agent_actions WHERE run_id = r), 'after every refused result the run is untouched and still ours');

  -- The result.
  SELECT rev INTO rev0 FROM agent_runs WHERE id = r;
  SELECT coalesce(sum(used_tokens), 0) INTO day_used FROM agent_usage_counters WHERE organization_id = a AND scope = 'user_day' AND subject_id = u1 AND period_start = day;
  fin := agent_finalize_run(r, lease, 'completed', NULL, 'conversation',
    jsonb_build_object('reply_text', repeat('x', 4100), 'reply_lang', 'de', 'object_lang', 'en', 'more_items', true, 'unsupported', 'delete',
      'context_message_ids', jsonb_build_array(t, m2), 'context_min_seq', 3, 'context_capped', true,
      'scope', jsonb_build_object('spaces', jsonb_build_array(jsonb_build_object('id', s1, 'perm', 'view_tasks')), 'refs', '[]'::jsonb),
      'provider', 'openai', 'model', 'gpt-test', 'prompt_version', 'v1', 'prompt_hash', 'abc', 'prompt_text', 'the whole prompt'),
    jsonb_build_array(
      jsonb_build_object('kind', 'task', 'intent', '{"title":"A"}'::jsonb, 'resolved', '{"confirmable":true}'::jsonb, 'target_space_id', s1, 'entity_type', 'task'),
      jsonb_build_object('kind', 'subtask', 'intent', '{"title":"B"}'::jsonb, 'depends_on', 1),
      jsonb_build_object('kind', 'wiki_page', 'intent', '{}'::jsonb),
      jsonb_build_object('kind', 'asset_object', 'intent', '{}'::jsonb),
      jsonb_build_object('kind', 'plan_item', 'intent', '{}'::jsonb)),
    '{"reply_hash":"ff","status":"overridden by the database"}');
  SELECT * INTO run FROM agent_runs WHERE id = r;
  PERFORM pg_temp.ok((fin ->> 'finalized')::boolean AND fin ->> 'status' = 'completed', format('finalized, got %s', fin));
  PERFORM pg_temp.ok(run.status = 'completed' AND run.lease_token IS NULL AND run.lease_expires_at IS NULL AND run.finished_at = now() AND run.rev = rev0 + 1
    AND run.visibility = 'conversation' AND run.error_code IS NULL, 'run: completed, lease cleared, audience stored');
  PERFORM pg_temp.ok(char_length(run.reply_text) = 4000 AND run.reply_lang = 'de' AND run.object_lang = 'en' AND run.more_items AND run.unsupported = 'delete'
    AND run.context_message_ids = ARRAY[t, m2] AND run.context_min_seq = 3 AND run.context_capped AND run.scope #>> '{spaces,0,perm}' = 'view_tasks'
    AND run.provider = 'openai' AND run.model = 'gpt-test' AND run.prompt_version = 'v1' AND run.prompt_hash = 'abc', 'run: the result fields are stored (reply cut at 4,000)');
  PERFORM pg_temp.ok(run.prompt_text IS NULL, 'the prompt text is not kept unless the organization opted in');
  PERFORM pg_temp.ok((SELECT string_agg(ordinal || ':' || kind || ':' || entity_type, ',' ORDER BY ordinal) FROM agent_actions WHERE run_id = r)
    = '1:task:task,2:subtask:task,3:wiki_page:wiki_page,4:asset_object:asset_object,5:plan_item:task', 'actions: ordinal = position; a subtask and a plan item are tasks');
  PERFORM pg_temp.ok((SELECT bool_and(status = 'proposed' AND version = 1 AND organization_id = a AND expires_at = now() + interval '24 hours' AND overrides = '{}'::jsonb
      AND exec_token IS NULL AND entity_id IS NOT NULL) AND count(DISTINCT entity_id) = 5 FROM agent_actions WHERE run_id = r),
    'actions: proposed, expire in 24 hours, each with its own reserved object id');
  PERFORM pg_temp.ok((SELECT intent = '{"title":"A"}'::jsonb AND resolved = '{"confirmable":true}'::jsonb AND target_space_id = s1 AND depends_on IS NULL FROM agent_actions WHERE run_id = r AND ordinal = 1)
    AND (SELECT depends_on = 1 AND resolved = '{}'::jsonb AND target_space_id IS NULL FROM agent_actions WHERE run_id = r AND ordinal = 2), 'actions: intent, resolved, parent and space are stored');
  PERFORM pg_temp.ok((SELECT coalesce(sum(used_tokens), 0) FROM agent_usage_counters WHERE organization_id = a AND scope = 'user_day' AND subject_id = u1 AND period_start = day) = day_used + 1100,
    'the person is charged with all tokens of the completed run');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(l.organization_id = a AND l.user_id = u1 AND l.provider_name = 'openai' AND l.tokens_used = 1100
      AND l.metadata ->> 'model' = 'gpt-test' AND l.metadata ->> 'status' = 'completed' AND (l.metadata ->> 'tokens_in')::int = 850)
    FROM ai_usage_logs l WHERE l.operation_type = 'robert_run' AND (l.metadata ->> 'run_id')::uuid = r), 'one ai_usage_logs row for the run');
  PERFORM pg_temp.ok((SELECT count(*) = 5 AND bool_and(e.actor_id = u1 AND e.entity_id = x.entity_id AND e.entity_type = x.entity_type
      AND e.space_id IS NOT DISTINCT FROM x.target_space_id AND (e.data ->> 'ordinal')::int = x.ordinal AND e.data ->> 'kind' = x.kind)
    FROM agent_audit_events e JOIN agent_actions x ON x.id = e.action_id WHERE e.run_id = r AND e.event = 'run.proposed'), 'audit: one run.proposed row per action');
  PERFORM pg_temp.ok((SELECT array_agg((e.data ->> 'ordinal')::int ORDER BY e.seq) FROM agent_audit_events e WHERE e.run_id = r AND e.event = 'run.proposed') = ARRAY[1, 2, 3, 4, 5]
    AND (SELECT max(seq) FROM agent_audit_events WHERE run_id = r AND event = 'run.proposed') < (SELECT seq FROM agent_audit_events WHERE run_id = r AND event = 'run.completed'),
    'audit: proposals in card order, then the run');
  PERFORM pg_temp.ok((SELECT e.data ->> 'reply_hash' = 'ff' AND e.data ->> 'status' = 'completed' AND (e.data ->> 'tokens_in')::int = 850 AND (e.data ->> 'tokens_out')::int = 250
      AND (e.data ->> 'actions')::int = 5 AND e.data ->> 'provider' = 'openai' AND e.data ->> 'prompt_hash' = 'abc' AND e.data ->> 'visibility' = 'conversation'
      AND e.data -> 'context_message_ids' = jsonb_build_array(t, m2) AND NOT e.data ? 'prompt_text' AND e.actor_id = u1
    FROM agent_audit_events e WHERE e.run_id = r AND e.event = 'run.completed'), 'audit: run.completed keeps the caller''s data, the facts come from the database');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_audit_events e WHERE e.organization_id = a AND e.data::text LIKE '%the whole prompt%'), 'the audit trail never holds the prompt text');

  -- The run is over: the lease opens nothing any more.
  fin := agent_finalize_run(r, lease, 'failed', 'timeout', NULL, NULL, NULL, NULL);
  PERFORM pg_temp.ok(NOT (fin ->> 'finalized')::boolean AND (SELECT status = 'completed' AND error_code IS NULL FROM agent_runs WHERE id = r), 'a second result is ignored');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_heartbeat(ARRAY[lease])) AND NOT agent_set_step(r, lease, 'checking')
    AND NOT (agent_record_model_call(r, lease, 1, 1, NULL, true, NULL, NULL) ->> 'recorded')::boolean, 'after the result the old lease is dead');

  -- A failed run: code stored, nothing proposed, only the invoker sees it, the person is not charged.
  PERFORM pg_temp.settings(a, p_store_prompts => true);
  res := pg_temp.start(a, pg_temp.say(a, g, u1), u1);
  r := (res ->> 'run_id')::uuid;
  lease := (res ->> 'lease_token')::uuid;
  PERFORM agent_record_model_call(r, lease, 100, 50, NULL, false, 'provider_down', 5);
  fin := agent_finalize_run(r, lease, 'failed', 'provider_down', NULL, '{"provider":"openai","prompt_text":"the whole prompt"}', pg_temp.actions(2), NULL);
  SELECT * INTO run FROM agent_runs WHERE id = r;
  PERFORM pg_temp.ok(fin ->> 'status' = 'failed' AND run.status = 'failed' AND run.error_code = 'provider_down' AND run.visibility = 'invoker' AND run.lease_token IS NULL
    AND NOT EXISTS (SELECT 1 FROM agent_actions WHERE run_id = r), 'failed run: code stored, no actions, invoker only');
  PERFORM pg_temp.ok(run.prompt_text = 'the whole prompt', 'the prompt text is kept when the organization opted in');
  -- (pg_temp.settings above put both counters back to zero.)
  PERFORM pg_temp.ok((SELECT used_tokens FROM agent_usage_counters WHERE organization_id = a AND scope = 'user_day' AND subject_id = u1 AND period_start = day) = 0
    AND (SELECT used_tokens FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month) = 150,
    'failed run: the tenant counter has the 150 tokens, the person is not charged');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(l.tokens_used = 150 AND l.metadata ->> 'status' = 'failed') FROM ai_usage_logs l
      WHERE l.operation_type = 'robert_run' AND (l.metadata ->> 'run_id')::uuid = r)
    AND (SELECT count(*) = 1 AND bool_and(e.data ->> 'error_code' = 'provider_down' AND (e.data ->> 'actions')::int = 0) FROM agent_audit_events e WHERE e.run_id = r AND e.event = 'run.failed'),
    'failed run: usage row and audit row');
  PERFORM pg_temp.settings(a);
END $$;

-- ---------------------------------------------------------------- queue and claim (NFR-08)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  u9 uuid := 'a9e00000-0000-4000-8000-000000000009';
  g uuid := pg_temp.conv('Agent IT main');
  gbb uuid := pg_temp.conv('Agent IT B');
  ids uuid[] := '{}';
  res jsonb; run agent_runs;
  late uuid; old_lease uuid; new_lease uuid; second uuid;
  unread2 bigint; i int;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  SELECT unread_count INTO unread2 FROM chat_unread_summary(a, u2) WHERE conversation_id = g;

  -- Tenant cap 2: the third run and the ones after it wait.
  FOR i IN 1..5 LOOP
    res := pg_temp.start(a, pg_temp.say(a, g, u1), u1, p_max_running => 2);
    ids := ids || (res ->> 'run_id')::uuid;
    PERFORM pg_temp.ok(res ->> 'status' = CASE WHEN i <= 2 THEN 'running' ELSE 'queued' END AND (res ->> 'lease_token' IS NULL) = (i > 2)
      AND (res ->> 'created')::boolean AND res ->> 'agent_message_id' IS NOT NULL, format('run %s of 5 with a cap of 2: %s', i, res ->> 'status'));
  END LOOP;
  SELECT * INTO run FROM agent_runs WHERE id = ids[3];
  PERFORM pg_temp.ok(run.status = 'queued' AND run.lease_token IS NULL AND run.lease_expires_at IS NULL AND run.attempts = 0 AND run.started_at IS NULL
    AND run.deadline_at = now() + interval '5 minutes' AND run.reserved_tokens = 1000, 'a queued run: no lease, at most 5 minutes in the queue');
  PERFORM pg_temp.ok((SELECT unread_count FROM chat_unread_summary(a, u2) WHERE conversation_id = g) = unread2 + 10, 'a queued run has its Robert message like a running one');

  -- The queue is served oldest first. (Far in the past, so that runs of real tenants in a shared database come later.)
  UPDATE agent_runs SET created_at = now() - interval '10 years' WHERE id = ids[4];
  UPDATE agent_runs SET created_at = now() - interval '9 years' WHERE id = ids[5];
  UPDATE agent_runs SET created_at = now() - interval '8 years' WHERE id = ids[3];

  -- Organization B has two waiting runs. A is at its cap and gets nothing; B is served.
  FOR i IN 1..2 LOOP
    PERFORM pg_temp.ok(pg_temp.start(b, pg_temp.say(b, gbb, u9), u9, p_max_running => 0) ->> 'status' = 'queued', 'organization B: queued');
  END LOOP;
  UPDATE agent_runs SET created_at = now() - interval '7 years' WHERE organization_id = b AND status = 'queued';
  PERFORM pg_temp.ok((SELECT count(*) = 2 AND bool_and(c.organization_id = b AND c.status = 'running' AND c.lease_token IS NOT NULL AND c.attempts = 1
      AND c.lease_expires_at = now() + interval '30 seconds' AND c.deadline_at = now() + interval '150 seconds' AND c.started_at = now() AND c.rev = 2)
    FROM agent_claim_runs(1000, 2) AS c WHERE c.organization_id IN (a, b)), 'a tenant at its cap gets nothing; the other tenant is served with fresh leases');

  -- No capacity asked for, or the queue switched off: nothing.
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_runs(0, 1000)) AND NOT EXISTS (SELECT 1 FROM agent_claim_runs(NULL, 1000))
    AND NOT EXISTS (SELECT 1 FROM agent_claim_runs(1000, 0) AS c WHERE c.organization_id IN (a, b)), 'no capacity, nothing claimed');

  -- One run of A ends: exactly one slot, and it goes to the oldest waiting run.
  PERFORM pg_temp.finish(ids[1]);
  PERFORM pg_temp.ok((SELECT array_agg(c.id) FROM agent_claim_runs(1000, 2) AS c WHERE c.organization_id IN (a, b)) = ARRAY[ids[4]], 'one free slot: the oldest waiting run');
  -- Cap 4 leaves room for two, but the instance has capacity for one.
  PERFORM pg_temp.ok((SELECT array_agg(c.id) FROM agent_claim_runs(1, 4) AS c) = ARRAY[ids[5]], 'p_limit caps the claim: the next oldest');
  PERFORM pg_temp.ok((SELECT array_agg(c.id) FROM agent_claim_runs(1000, 4) AS c WHERE c.organization_id IN (a, b)) = ARRAY[ids[3]], 'then the last one');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_runs(1000, 1000) AS c WHERE c.organization_id IN (a, b)), 'the queue is empty');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_runs WHERE organization_id = a AND status = 'running') = 4, 'four runs of A are running, as the cap of 4 allows');

  -- A run that waited past its deadline is not started any more (the sweep ends it as busy).
  late := (pg_temp.start(a, pg_temp.say(a, g, u1), u1, p_max_running => 0) ->> 'run_id')::uuid;
  UPDATE agent_runs SET deadline_at = now() - interval '1 second', created_at = now() - interval '10 years' WHERE id = late;
  second := (pg_temp.start(a, pg_temp.say(a, g, u1), u1, p_max_running => 0) ->> 'run_id')::uuid;
  PERFORM pg_temp.ok((SELECT array_agg(c.id) FROM agent_claim_runs(1000, 1000) AS c WHERE c.organization_id IN (a, b)) = ARRAY[second],
    'a run past its queue deadline is not claimed; the one waiting behind it is');
  PERFORM pg_temp.finish(second);

  -- Take-over: the worker of ids[2] died (its lease ran out). It is claimed once more, also when the queue is closed.
  SELECT lease_token INTO old_lease FROM agent_runs WHERE id = ids[2];
  UPDATE agent_runs SET lease_expires_at = now() - interval '1 second', created_at = now() - interval '10 years' WHERE id = ids[2];
  UPDATE agent_runs SET lease_expires_at = now() - interval '1 second', created_at = now() - interval '9 years' WHERE id = ids[4];
  PERFORM pg_temp.ok((SELECT array_agg(c.id) FROM agent_claim_runs(1, 0) AS c) = ARRAY[ids[2]], 'take-over: the oldest abandoned run first, within p_limit');
  SELECT * INTO run FROM agent_runs WHERE id = ids[2];
  new_lease := run.lease_token;
  PERFORM pg_temp.ok(run.status = 'running' AND run.attempts = 2 AND new_lease <> old_lease AND run.lease_expires_at = now() + interval '30 seconds'
    AND run.deadline_at = now() + interval '150 seconds', 'take-over: new lease, second attempt, fresh deadline');
  -- The worker that lost the run can write nothing.
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_heartbeat(ARRAY[old_lease])) AND NOT agent_set_step(ids[2], old_lease, 'checking')
    AND NOT (agent_record_model_call(ids[2], old_lease, 5, 5, NULL, true, NULL, NULL) ->> 'recorded')::boolean
    AND NOT (agent_finalize_run(ids[2], old_lease, 'completed', NULL, 'invoker', '{}', pg_temp.actions(1), NULL) ->> 'finalized')::boolean,
    'the old worker lost the run: keep-alive, step, booking and result are refused');
  PERFORM pg_temp.ok((SELECT status = 'running' AND lease_token = new_lease AND tokens_in = 0 AND step IS NULL FROM agent_runs WHERE id = ids[2])
    AND NOT EXISTS (SELECT 1 FROM agent_actions WHERE run_id = ids[2]), 'and it changed nothing');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM agent_heartbeat(ARRAY[new_lease])), 'the new worker holds it');

  -- Not taken over: a run the invoker stopped, and a run past its deadline (both are for the sweep).
  PERFORM agent_cancel_run(a, ids[4], u1);
  second := ids[5];
  UPDATE agent_runs SET lease_expires_at = now() - interval '1 second', deadline_at = now() - interval '1 second' WHERE id = second;
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_runs(1000, 1000) AS c WHERE c.organization_id IN (a, b)), 'stopped or timed-out runs are not taken over');

  -- A second loss is final: not claimed again, the sweep ends it as interrupted.
  UPDATE agent_runs SET lease_expires_at = now() - interval '1 second' WHERE id = ids[2];
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_runs(1000, 1000) AS c WHERE c.organization_id IN (a, b)), 'a run is taken over only once');
  PERFORM pg_temp.ok((SELECT status = 'failed' AND error_code = 'interrupted' AND lease_token IS NULL AND finished_at = now() FROM agent_reap_runs() AS x WHERE x.id = ids[2]),
    'second lease loss: failed as interrupted');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_heartbeat(ARRAY[new_lease])), 'and its lease is gone');
END $$;

-- ---------------------------------------------------------------- sweep (ROB-15 BR-4)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u9 uuid := 'a9e00000-0000-4000-8000-000000000009';
  g uuid := pg_temp.conv('Agent IT main');
  gbb uuid := pg_temp.conv('Agent IT B');
  q_busy uuid; q_ok uuid; r_timeout uuid; r_ok uuid; r_first_loss uuid; r_stop_dead uuid; r_stop_live uuid; r_stop_late uuid; r_spent uuid; b_timeout uuid;
  audits bigint; rev0 bigint; reaped uuid[];
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  q_busy := (pg_temp.start(a, pg_temp.say(a, g, u1), u1, p_max_running => 0) ->> 'run_id')::uuid;
  q_ok := (pg_temp.start(a, pg_temp.say(a, g, u1), u1, p_max_running => 0) ->> 'run_id')::uuid;
  r_timeout := (pg_temp.start(a, pg_temp.say(a, g, u1), u1) ->> 'run_id')::uuid;
  r_ok := (pg_temp.start(a, pg_temp.say(a, g, u1), u1) ->> 'run_id')::uuid;
  r_first_loss := (pg_temp.start(a, pg_temp.say(a, g, u1), u1) ->> 'run_id')::uuid;
  r_stop_dead := (pg_temp.start(a, pg_temp.say(a, g, u1), u1) ->> 'run_id')::uuid;
  r_stop_live := (pg_temp.start(a, pg_temp.say(a, g, u1), u1) ->> 'run_id')::uuid;
  r_stop_late := (pg_temp.start(a, pg_temp.say(a, g, u1), u1) ->> 'run_id')::uuid;
  r_spent := (pg_temp.start(a, pg_temp.say(a, g, u1), u1) ->> 'run_id')::uuid;
  b_timeout := (pg_temp.start(b, pg_temp.say(b, gbb, u9), u9) ->> 'run_id')::uuid;

  UPDATE agent_runs SET deadline_at = now() - interval '1 second' WHERE id IN (q_busy, r_timeout, r_stop_late, r_spent, b_timeout);
  UPDATE agent_runs SET lease_expires_at = now() - interval '1 second' WHERE id IN (r_first_loss, r_stop_dead);
  PERFORM agent_cancel_run(a, r_stop_dead, u1);
  PERFORM agent_cancel_run(a, r_stop_live, u1);
  PERFORM agent_cancel_run(a, r_stop_late, u1);
  PERFORM agent_record_model_call(r_spent, (SELECT lease_token FROM agent_runs WHERE id = r_spent), 70, 30, NULL, true, NULL, NULL);
  SELECT count(*) INTO audits FROM agent_audit_events WHERE organization_id IN (a, b) AND event IN ('run.failed', 'run.cancelled');
  SELECT rev INTO rev0 FROM agent_runs WHERE id = r_timeout;

  SELECT array_agg(x.id) INTO reaped FROM agent_reap_runs() AS x WHERE x.organization_id IN (a, b);
  PERFORM pg_temp.ok(reaped @> ARRAY[q_busy, r_timeout, r_stop_dead, r_stop_late, r_spent, b_timeout] AND cardinality(reaped) = 6,
    format('the sweep ends exactly the six stuck runs, got %s', reaped));
  PERFORM pg_temp.ok((SELECT status = 'failed' AND error_code = 'busy' AND finished_at = now() FROM agent_runs WHERE id = q_busy), 'waited past the queue deadline: failed, busy');
  PERFORM pg_temp.ok((SELECT status = 'failed' AND error_code = 'timeout' AND lease_token IS NULL AND lease_expires_at IS NULL AND finished_at = now() AND rev = rev0 + 1
    FROM agent_runs WHERE id = r_timeout), 'running past the deadline, lease still alive: failed, timeout');
  PERFORM pg_temp.ok((SELECT status = 'cancelled' AND error_code IS NULL AND lease_token IS NULL FROM agent_runs WHERE id = r_stop_dead), 'stopped and the worker is gone: cancelled');
  PERFORM pg_temp.ok((SELECT status = 'cancelled' AND error_code IS NULL FROM agent_runs WHERE id = r_stop_late), 'stopped and past the deadline: cancelled, not timeout');
  PERFORM pg_temp.ok((SELECT bool_and(status = 'running' AND lease_token IS NOT NULL) FROM agent_runs WHERE id IN (r_ok, r_first_loss, r_stop_live))
    AND (SELECT status = 'queued' FROM agent_runs WHERE id = q_ok),
    'untouched: a healthy run, a first lease loss (that is a take-over), a stopped run whose worker is alive, a run still waiting');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_audit_events WHERE organization_id IN (a, b) AND event IN ('run.failed', 'run.cancelled')) = audits + 6
    AND (SELECT count(*) = 1 AND bool_and(e.organization_id = b AND e.actor_id = u9 AND e.data ->> 'error_code' = 'timeout' AND e.data ->> 'by' = 'sweep')
         FROM agent_audit_events e WHERE e.run_id = b_timeout AND e.event = 'run.failed')
    AND (SELECT count(*) = 1 AND bool_and(e.organization_id = a AND e.actor_id = u1 AND NOT e.data ? 'error_code') FROM agent_audit_events e WHERE e.run_id = r_stop_dead AND e.event = 'run.cancelled'),
    'audit: one row per ended run, in its own organization');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(l.user_id = u1 AND l.tokens_used = 100 AND l.metadata ->> 'status' = 'failed') FROM ai_usage_logs l
      WHERE l.operation_type = 'robert_run' AND (l.metadata ->> 'run_id')::uuid = r_spent)
    AND NOT EXISTS (SELECT 1 FROM ai_usage_logs l WHERE l.operation_type = 'robert_run' AND (l.metadata ->> 'run_id')::uuid = r_timeout),
    'a swept run that spent tokens gets its usage row; one that spent nothing gets none');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_reap_runs() AS x WHERE x.organization_id IN (a, b)), 'a second sweep finds nothing');
  -- The first lease loss is picked up by the claim instead.
  PERFORM pg_temp.ok((SELECT array_agg(c.id) FROM agent_claim_runs(1000, 0) AS c WHERE c.organization_id IN (a, b)) = ARRAY[r_first_loss], 'the first lease loss is a take-over');
END $$;

-- ---------------------------------------------------------------- stop (ROB-02 BR-9)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  u9 uuid := 'a9e00000-0000-4000-8000-000000000009';
  g uuid := pg_temp.conv('Agent IT main');
  day date := timezone('utc', now())::date;
  rq uuid; rr uuid; done uuid; lease uuid;
  run agent_runs; fin jsonb; rev0 bigint; day_used bigint;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  rq := (pg_temp.start(a, pg_temp.say(a, g, u1), u1, p_max_running => 0) ->> 'run_id')::uuid;
  rr := (pg_temp.start(a, pg_temp.say(a, g, u1), u1) ->> 'run_id')::uuid;
  done := (pg_temp.start(a, pg_temp.say(a, g, u1), u1) ->> 'run_id')::uuid;
  PERFORM pg_temp.finish(done);
  SELECT lease_token, rev INTO lease, rev0 FROM agent_runs WHERE id = rr;

  -- Only the invoker, in their own organization; for everyone else the run does not exist.
  PERFORM pg_temp.expect_error(format('SELECT agent_cancel_run(%L, %L, %L)', a, rr, u2), 'P0002');                 -- a colleague
  PERFORM pg_temp.expect_error(format('SELECT agent_cancel_run(%L, %L, %L)', b, rr, u1), 'P0002');                 -- the invoker, through another organization
  PERFORM pg_temp.expect_error(format('SELECT agent_cancel_run(%L, %L, %L)', b, rr, u9), 'P0002');                 -- another organization's owner
  PERFORM pg_temp.expect_error(format('SELECT agent_cancel_run(%L, %L, NULL)', a, rr), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT agent_cancel_run(%L, %L, %L)', a, gen_random_uuid(), u1), 'P0002');
  PERFORM pg_temp.ok((SELECT cancel_requested_at IS NULL AND cancelled_by IS NULL AND rev = rev0 FROM agent_runs WHERE id = rr), 'a refused stop changes nothing');

  -- A waiting run is cancelled at once.
  PERFORM pg_temp.ok(agent_cancel_run(a, rq, u1) = '{"status":"cancelled"}'::jsonb, 'stop on a queued run answers cancelled');
  SELECT * INTO run FROM agent_runs WHERE id = rq;
  PERFORM pg_temp.ok(run.status = 'cancelled' AND run.cancel_requested_at = now() AND run.cancelled_by = u1 AND run.finished_at = now() AND run.lease_token IS NULL AND run.rev = 2,
    'a queued run is cancelled at once');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(e.actor_id = u1 AND e.data ->> 'was' = 'queued') FROM agent_audit_events e WHERE e.run_id = rq AND e.event = 'run.cancelled'),
    'audit: run.cancelled for the queued run');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_runs(1000, 1000) AS c WHERE c.id = rq), 'a cancelled run is never claimed');

  -- A running run is only marked, once.
  PERFORM pg_temp.ok(agent_cancel_run(a, rr, u1) = '{"status":"running"}'::jsonb, 'stop on a running run answers running');
  SELECT * INTO run FROM agent_runs WHERE id = rr;
  PERFORM pg_temp.ok(run.status = 'running' AND run.cancel_requested_at = now() AND run.cancelled_by = u1 AND run.lease_token = lease AND run.rev = rev0 + 1
    AND NOT EXISTS (SELECT 1 FROM agent_audit_events e WHERE e.run_id = rr AND e.event = 'run.cancelled'), 'a running run is marked; it is not cancelled yet');
  UPDATE agent_runs SET cancel_requested_at = now() - interval '10 seconds' WHERE id = rr;
  PERFORM pg_temp.ok(agent_cancel_run(a, rr, u1) ->> 'status' = 'running', 'stop pressed again still answers running');
  PERFORM pg_temp.ok((SELECT cancel_requested_at = now() - interval '10 seconds' AND rev = rev0 + 1 FROM agent_runs WHERE id = rr), 'stop pressed again changes nothing');
  PERFORM pg_temp.ok((SELECT h.cancel_requested FROM agent_heartbeat(ARRAY[lease]) AS h WHERE h.run_id = rr), 'the worker learns about the stop at its next keep-alive');

  -- Whatever the worker reports now, the run ends as cancelled: nothing is proposed, the person is not charged.
  PERFORM agent_record_model_call(rr, lease, 40, 10, NULL, true, NULL, NULL);
  SELECT coalesce(sum(used_tokens), 0) INTO day_used FROM agent_usage_counters WHERE organization_id = a AND scope = 'user_day' AND subject_id = u1 AND period_start = day;
  fin := agent_finalize_run(rr, lease, 'completed', 'failed', 'conversation', '{"reply_text":"too late"}', pg_temp.actions(3), NULL);
  SELECT * INTO run FROM agent_runs WHERE id = rr;
  PERFORM pg_temp.ok((fin ->> 'finalized')::boolean AND fin ->> 'status' = 'cancelled' AND run.status = 'cancelled' AND run.error_code IS NULL AND run.lease_token IS NULL
    AND NOT EXISTS (SELECT 1 FROM agent_actions WHERE run_id = rr), format('a stopped run ends as cancelled with no proposals, got %s', fin));
  PERFORM pg_temp.ok((SELECT coalesce(sum(used_tokens), 0) FROM agent_usage_counters WHERE organization_id = a AND scope = 'user_day' AND subject_id = u1 AND period_start = day) = day_used,
    'a cancelled run does not charge the person');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(e.actor_id = u1 AND (e.data ->> 'actions')::int = 0) FROM agent_audit_events e WHERE e.run_id = rr AND e.event = 'run.cancelled')
    AND (SELECT count(*) = 1 AND bool_and(l.tokens_used = 50 AND l.metadata ->> 'status' = 'cancelled') FROM ai_usage_logs l
         WHERE l.operation_type = 'robert_run' AND (l.metadata ->> 'run_id')::uuid = rr), 'audit and usage rows of the cancelled run');

  -- A run that is over stays as it is.
  PERFORM pg_temp.ok(agent_cancel_run(a, rr, u1) ->> 'status' = 'cancelled' AND agent_cancel_run(a, done, u1) ->> 'status' = 'completed',
    'stop on a finished run answers its status');
  PERFORM pg_temp.ok((SELECT status = 'completed' AND cancel_requested_at IS NULL AND cancelled_by IS NULL FROM agent_runs WHERE id = done), 'stop on a finished run changes nothing');
END $$;

-- ---------------------------------------------------------------- month and day change
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  g uuid := pg_temp.conv('Agent IT main');
  month date := date_trunc('month', timezone('utc', now()))::date;
  day date := timezone('utc', now())::date;
  last_month date := (date_trunc('month', timezone('utc', now())) - interval '1 month')::date;
  yesterday date := timezone('utc', now())::date - 1;
  r_new uuid; r_old uuid; lease uuid; rec jsonb; res jsonb;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a, p_monthly => 10000);
  -- Last month ended far over the cap and with its 100% alert sent; yesterday the person was far over too.
  INSERT INTO agent_usage_counters (organization_id, scope, subject_id, period_start, used_tokens, alert100_at) VALUES
    (a, 'org_month', a, last_month, 999999, now() - interval '20 days'),
    (a, 'user_day', u1, yesterday, 999999, NULL),
    (a, 'user_day', u2, yesterday, 999999, NULL);

  -- A new month starts from zero.
  r_new := (pg_temp.start(a, pg_temp.say(a, g, u1), u1, p_reserve => 4000) ->> 'run_id')::uuid;
  PERFORM pg_temp.ok((SELECT status = 'running' AND budget_month = month AND budget_day = day FROM agent_runs WHERE id = r_new), 'last month''s usage does not refuse this month');

  -- A run that started last month and is still working: it reserves nothing from this month ...
  r_old := (pg_temp.start(a, pg_temp.say(a, g, u1), u1, p_reserve => 4000) ->> 'run_id')::uuid;
  UPDATE agent_runs SET budget_month = last_month, budget_day = yesterday WHERE id = r_old;
  res := pg_temp.start(a, pg_temp.say(a, g, u1), u1, p_reserve => 6001);
  PERFORM pg_temp.ok(res ->> 'refusal' = 'budget_org', 'this month: 4,000 reserved + 6,001 is over');
  -- The alert markers belong to the month: this month's first refusal raises its own 100% alert.
  PERFORM pg_temp.ok((res ->> 'alert100')::boolean
    AND (SELECT alert100_at = now() FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month)
    AND (SELECT alert100_at = now() - interval '20 days' FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = last_month),
    'the new month raises its own 100% alert; last month''s marker is untouched');
  PERFORM pg_temp.ok(pg_temp.start(a, pg_temp.say(a, g, u1), u1, p_reserve => 6000) ->> 'status' = 'running', 'this month: 4,000 reserved + 6,000 fits, the old run does not count');
  -- ... and is settled against the month and day stored on it. No 80% alert for a month that is over.
  SELECT lease_token INTO lease FROM agent_runs WHERE id = r_old;
  rec := agent_record_model_call(r_old, lease, 700, 300, NULL, true, NULL, NULL);
  PERFORM pg_temp.ok((rec ->> 'recorded')::boolean AND NOT (rec ->> 'alert80')::boolean
    AND (SELECT used_tokens = 1000999 AND alert80_at IS NULL FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = last_month)
    AND (SELECT used_tokens = 0 FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month),
    format('tokens of the old run go to last month, without an alert, got %s', rec));
  PERFORM pg_temp.finish(r_old);
  PERFORM pg_temp.ok((SELECT used_tokens = 1000999 FROM agent_usage_counters WHERE organization_id = a AND scope = 'user_day' AND subject_id = u1 AND period_start = yesterday)
    AND (SELECT used_tokens = 0 FROM agent_usage_counters WHERE organization_id = a AND scope = 'user_day' AND subject_id = u1 AND period_start = day),
    'the person is charged on the day the run started');

  -- The same for 80%: this month's usage reaches it and the alert is raised, once.
  SELECT lease_token INTO lease FROM agent_runs WHERE id = r_new;
  rec := agent_record_model_call(r_new, lease, 8000, 0, NULL, true, NULL, NULL);
  PERFORM pg_temp.ok((rec ->> 'alert80')::boolean AND (SELECT alert80_at = now() FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month),
    'the new month raises its own 80% alert');
  rec := agent_record_model_call(r_new, lease, 1, 0, NULL, true, NULL, NULL);
  PERFORM pg_temp.ok(NOT (rec ->> 'alert80')::boolean, 'and only once');

  -- A new day starts from zero for the person; a run of yesterday that is still working reserves nothing today.
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a, p_daily => 5000);
  UPDATE agent_usage_counters SET used_tokens = 999999 WHERE organization_id = a AND scope = 'user_day' AND period_start = yesterday;
  r_old := (pg_temp.start(a, pg_temp.say(a, g, u2), u2, p_reserve => 5000) ->> 'run_id')::uuid;
  PERFORM pg_temp.ok((SELECT status = 'running' AND budget_day = day FROM agent_runs WHERE id = r_old), 'yesterday''s usage does not refuse today');
  PERFORM pg_temp.ok(pg_temp.refusal_then_forget(pg_temp.start(a, pg_temp.say(a, g, u2), u2, p_reserve => 1)) = 'budget_user', 'today is full with the live run');
  UPDATE agent_runs SET budget_day = yesterday WHERE id = r_old;
  PERFORM pg_temp.ok(pg_temp.start(a, pg_temp.say(a, g, u2), u2, p_reserve => 5000) ->> 'status' = 'running', 'a run that belongs to yesterday reserves nothing today');
  PERFORM pg_temp.settings(a);
END $$;

-- ---------------------------------------------------------------- Robert's private conversation (ROB-01)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  u9 uuid := 'a9e00000-0000-4000-8000-000000000009';
  robert uuid := '0b3e7000-0000-4000-8000-000000000001';
  rd uuid; rd2 uuid; rdb uuid;
  c chat_conversations;
  res jsonb;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM users WHERE id = robert), 'Robert is not a user');
  rd := chat_get_or_create_agent_dm(a, u1, robert);
  SELECT * INTO c FROM chat_conversations WHERE id = rd;
  PERFORM pg_temp.ok(c.kind = 'dm' AND c.organization_id = a AND c.created_by = u1 AND c.title IS NULL AND c.space_id IS NULL
    AND c.dm_key = least(u1::text, robert::text) || ':' || greatest(u1::text, robert::text), 'the Robert conversation is a dm with the agreed key');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(user_id = u1 AND role = 'member') FROM chat_members WHERE conversation_id = rd), 'exactly one member row: the person');
  PERFORM pg_temp.ok(chat_get_or_create_agent_dm(a, u1, robert) = rd, 'opening it again returns the same conversation');
  PERFORM pg_temp.ok((SELECT count(*) FROM chat_members WHERE conversation_id = rd) = 1
    AND (SELECT count(*) FROM chat_conversations WHERE organization_id = a AND dm_key = c.dm_key) = 1, 'and adds neither a member nor a second conversation');
  rd2 := chat_get_or_create_agent_dm(a, u2, robert);
  rdb := chat_get_or_create_agent_dm(b, u1, robert);
  PERFORM pg_temp.ok(rd2 <> rd AND rdb <> rd AND (SELECT organization_id FROM chat_conversations WHERE id = rdb) = b, 'one per person and organization');

  -- A member row that vanished is restored.
  DELETE FROM chat_members WHERE conversation_id = rd AND user_id = u1;
  PERFORM pg_temp.ok(chat_get_or_create_agent_dm(a, u1, robert) = rd, 'reopened, same conversation');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(user_id = u1) FROM chat_members WHERE conversation_id = rd), 'a missing member row is restored');

  PERFORM pg_temp.expect_error(format('SELECT chat_get_or_create_agent_dm(%L, %L, %L)', a, u9, robert), '42501');   -- not a member of this organization
  PERFORM pg_temp.expect_error(format('SELECT chat_get_or_create_agent_dm(%L, %L, %L)', b, u2, robert), '42501');   -- other tenant
  PERFORM pg_temp.expect_error(format('SELECT chat_get_or_create_agent_dm(%L, %L, %L)', a, u1, u2), '22023');       -- a person is not Robert
  PERFORM pg_temp.expect_error(format('SELECT chat_get_or_create_agent_dm(%L, %L, NULL)', a, u1), '22023');

  -- Nobody else can ever get in: the membership functions refuse a dm, and Robert cannot be reached as a person.
  PERFORM pg_temp.expect_error(format('SELECT chat_add_members(%L, %L, %L, ARRAY[%L]::uuid[], true, true)', a, rd, u1, u2), '42501');
  PERFORM pg_temp.expect_error(format('SELECT chat_remove_member(%L, %L, %L, %L)', a, rd, u2, u1), '42501');
  PERFORM pg_temp.expect_error(format('SELECT chat_leave(%L, %L, %L)', a, rd, u1), '42501');
  PERFORM pg_temp.expect_error(format('SELECT chat_set_member_role(%L, %L, %L, %L, %L)', a, rd, u1, u1, 'owner'), '42501');
  PERFORM pg_temp.expect_error(format('SELECT chat_get_or_create_dm(%L, %L, %L)', a, u1, robert), '42501');
  PERFORM pg_temp.expect_error(format('SELECT chat_get_or_create_dm(%L, %L, %L)', a, robert, u1), '42501');
  PERFORM pg_temp.expect_error(format('SELECT * FROM chat_post_message(%L, %L, %L, %L, %L, %L)', a, rd, gen_random_uuid(), u2, 'x', 'x'), '42501');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(user_id = u1) FROM chat_members WHERE conversation_id = rd), 'still one member');
  PERFORM pg_temp.ok((SELECT s.kind = 'dm' AND s.dm_key = c.dm_key FROM chat_unread_summary(a, u1) AS s WHERE s.conversation_id = rd)
    AND NOT EXISTS (SELECT 1 FROM chat_unread_summary(a, u2) AS s WHERE s.conversation_id = rd), 'only its person has it in the inbox, with the key the backend recognises it by');

  -- The person talks to Robert there; his reply is unread for them.
  res := pg_temp.start(a, pg_temp.say(a, rd, u1), u1);
  PERFORM pg_temp.ok(res ->> 'status' = 'running' AND (SELECT s.unread_count FROM chat_unread_summary(a, u1) AS s WHERE s.conversation_id = rd) = 1
    AND (SELECT e.data -> 'member_ids' = jsonb_build_array(u1) FROM agent_audit_events e WHERE e.run_id = (res ->> 'run_id')::uuid AND e.event = 'run.started'),
    'a run in the Robert conversation');
END $$;

-- ---------------------------------------------------------------- two organizations never mix (EC-A5)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';   -- member of both
  u9 uuid := 'a9e00000-0000-4000-8000-000000000009';
  g uuid := pg_temp.conv('Agent IT main');
  gbb uuid := pg_temp.conv('Agent IT B');
  month date := date_trunc('month', timezone('utc', now()))::date;
  ta uuid; tb uuid; ra uuid; rb uuid; lease_a uuid; lease_b uuid;
  res jsonb; used_a bigint; runs0 bigint;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  ta := pg_temp.say(a, g, u1);
  tb := pg_temp.say(b, gbb, u1);

  -- agent_start_run: the request must belong to the organization named in the call.
  SELECT count(*) INTO runs0 FROM agent_runs;
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L)', b, ta, u1), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L)', a, tb, u1), 'P0002');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_runs) = runs0, 'a start across organizations stores nothing');

  -- The same person is counted per organization: rate limit, budget and "first run".
  res := pg_temp.start(a, ta, u1, p_rate => 1000000);
  ra := (res ->> 'run_id')::uuid;
  lease_a := (res ->> 'lease_token')::uuid;
  PERFORM pg_temp.settings(b, p_daily => 1000);
  res := pg_temp.start(b, tb, u1, p_rate => 1, p_max_running => 1);
  rb := (res ->> 'run_id')::uuid;
  lease_b := (res ->> 'lease_token')::uuid;
  PERFORM pg_temp.ok(res ->> 'status' = 'running' AND (res ->> 'first')::boolean,
    'the person''s runs, reservations and live runs in organization A do not count in organization B');
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L, p_rerun_of => %L)', a, ta, u1, rb), 'P0002');   -- re-run of a run of the other organization
  PERFORM pg_temp.expect_error(format('SELECT pg_temp.start(%L, %L, %L, p_rerun_of => %L)', b, tb, u1, ra), 'P0002');

  -- Lease functions: a run id only opens with its own lease.
  SELECT used_tokens INTO used_a FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month;
  PERFORM pg_temp.ok(NOT agent_set_step(ra, lease_b, 'checking') AND NOT agent_set_step(rb, lease_a, 'checking'), 'agent_set_step: another organization''s lease opens nothing');
  PERFORM pg_temp.ok(agent_record_model_call(ra, lease_b, 500, 500, NULL, true, NULL, NULL) = '{"recorded":false,"remaining":0,"alert80":false}'::jsonb
    AND agent_record_model_call(rb, lease_a, 500, 500, NULL, true, NULL, NULL) = '{"recorded":false,"remaining":0,"alert80":false}'::jsonb,
    'agent_record_model_call: another organization''s lease books nothing and reveals nothing');
  PERFORM pg_temp.ok(agent_finalize_run(ra, lease_b, 'completed', NULL, 'conversation', '{}', pg_temp.actions(1), NULL) = '{"finalized":false,"status":null}'::jsonb
    AND agent_finalize_run(rb, lease_a, 'failed', 'failed', NULL, NULL, NULL, NULL) = '{"finalized":false,"status":null}'::jsonb,
    'agent_finalize_run: another organization''s lease finishes nothing and reveals nothing');
  PERFORM pg_temp.ok((SELECT bool_and(status = 'running' AND step IS NULL AND tokens_in = 0) FROM agent_runs WHERE id IN (ra, rb))
    AND (SELECT used_tokens FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month) = used_a, 'both runs are untouched');
  -- agent_heartbeat takes tokens only: each token answers for its own run.
  PERFORM pg_temp.ok((SELECT array_agg(h.run_id) FROM agent_heartbeat(ARRAY[lease_b]) AS h) = ARRAY[rb], 'agent_heartbeat: a token renews its own run only');

  -- Booking stays inside the organization of the run.
  PERFORM agent_record_model_call(rb, lease_b, 600, 0, NULL, true, NULL, NULL);
  PERFORM pg_temp.ok((SELECT used_tokens FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month' AND period_start = month) = used_a
    AND (SELECT used_tokens FROM agent_usage_counters WHERE organization_id = b AND scope = 'org_month' AND subject_id = b AND period_start = month) = 600,
    'tokens are booked to the organization of the run');
  PERFORM pg_temp.ok((SELECT count(*) > 0 AND bool_and(e.organization_id = b) FROM agent_audit_events e WHERE e.run_id = rb)
    AND (SELECT count(*) > 0 AND bool_and(e.organization_id = a) FROM agent_audit_events e WHERE e.run_id = ra), 'audit rows stay in the organization of the run');

  -- agent_cancel_run: the organization in the call must be the run's.
  PERFORM pg_temp.expect_error(format('SELECT agent_cancel_run(%L, %L, %L)', b, ra, u1), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT agent_cancel_run(%L, %L, %L)', a, rb, u1), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT agent_cancel_run(%L, %L, %L)', a, rb, u9), 'P0002');
  -- agent_claim_runs and agent_reap_runs take no ids; their per-tenant behaviour is checked in the blocks above.
  -- chat_get_or_create_agent_dm across organizations is refused in the block above.

  -- The schema itself refuses a row that mixes organizations.
  PERFORM pg_temp.expect_error(format('UPDATE agent_runs SET organization_id = %L WHERE id = %L', b, ra), '23503');               -- conversation of another tenant
  PERFORM pg_temp.expect_error(format('UPDATE agent_runs SET trigger_message_id = %L WHERE id = %L',
    pg_temp.say(a, pg_temp.conv('Agent IT budget'), 'a9e00000-0000-4000-8000-000000000004'), ra), '23503');                          -- request from another conversation
  PERFORM pg_temp.finish(ra, 'completed', pg_temp.actions(1));
  PERFORM pg_temp.expect_error(format('UPDATE agent_actions SET organization_id = %L WHERE run_id = %L', b, ra), '23503');        -- action of another tenant's run
  PERFORM pg_temp.settings(b);
END $$;

-- ---------------------------------------------------------------- table rules
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  g uuid := pg_temp.conv('Agent IT main');
  t uuid; running uuid; queued uuid; refused uuid; act uuid;
  upd text := 'UPDATE agent_runs SET %s WHERE id = %L';
BEGIN
  PERFORM pg_temp.quiesce();
  t := pg_temp.say(a, g, u1);
  running := (pg_temp.start(a, t, u1) ->> 'run_id')::uuid;
  queued := (pg_temp.start(a, pg_temp.say(a, g, u1), u1, p_max_running => 0) ->> 'run_id')::uuid;
  refused := (pg_temp.start(a, pg_temp.say(a, g, u1), u1, p_refusal => 'disabled') ->> 'run_id')::uuid;

  -- Exactly the running runs hold a lease.
  PERFORM pg_temp.expect_error(format(upd, 'lease_token = NULL', running), '23514');                           -- running without a lease
  PERFORM pg_temp.expect_error(format(upd, 'status = ''completed''', running), '23514');                       -- a lease on a finished run
  PERFORM pg_temp.expect_error(format(upd, 'lease_token = gen_random_uuid()', queued), '23514');               -- a lease on a queued run
  PERFORM pg_temp.expect_error(format(upd, 'status = ''running''', queued), '23514');                          -- running without a lease
  -- Exactly the refused runs have no chat message.
  PERFORM pg_temp.expect_error(format(upd, 'agent_message_id = NULL', queued), '23514');                       -- a real run without its message
  PERFORM pg_temp.expect_error(format(upd, 'status = ''refused''', queued), '23514');                          -- a refusal with a message
  PERFORM pg_temp.expect_error(format(upd, 'status = ''failed''', refused), '23514');                          -- not refused, but no message
  PERFORM pg_temp.expect_error(format(upd, format('agent_message_id = %L', t), refused), '23514');             -- a refusal with a message
  -- Keys and value lists.
  PERFORM pg_temp.expect_error(format(upd, 'run_no = 0', queued), '23514');
  PERFORM pg_temp.expect_error(format(upd, 'run_no = 11', queued), '23514');
  PERFORM pg_temp.expect_error(format(upd, 'status = ''paused''', refused), '23514');
  PERFORM pg_temp.expect_error(format(upd, 'visibility = ''everyone''', queued), '23514');
  PERFORM pg_temp.expect_error(format(upd, 'scope = ''[]''', queued), '23514');
  PERFORM pg_temp.expect_error(format(upd, 'reply_text = repeat(''x'', 4001)', queued), '23514');
  PERFORM pg_temp.expect_error(format(upd, format('trigger_message_id = %L', t), queued), '23505');            -- one run per request and number
  PERFORM pg_temp.expect_error(format(upd, format('agent_message_id = %L', (SELECT agent_message_id FROM agent_runs WHERE id = running)), queued), '23505');
  PERFORM pg_temp.expect_error(format(upd, 'agent_message_id = gen_random_uuid()', queued), '23503');          -- a message that does not exist

  -- Actions: exactly the ones being confirmed or undone hold a claim token.
  PERFORM pg_temp.finish(running, 'completed', pg_temp.actions(2));
  SELECT id INTO act FROM agent_actions WHERE run_id = running AND ordinal = 1;
  upd := 'UPDATE agent_actions SET %s WHERE id = %L';
  PERFORM pg_temp.expect_error(format(upd, 'status = ''executing''', act), '23514');
  PERFORM pg_temp.expect_error(format(upd, 'status = ''undoing''', act), '23514');
  PERFORM pg_temp.expect_error(format(upd, 'exec_token = gen_random_uuid()', act), '23514');
  PERFORM pg_temp.expect_error(format(upd, 'ordinal = 0', act), '23514');
  PERFORM pg_temp.expect_error(format(upd, 'ordinal = 21', act), '23514');
  PERFORM pg_temp.expect_error(format(upd, 'ordinal = 2', act), '23505');
  PERFORM pg_temp.expect_error(format(upd, 'kind = ''email''', act), '23514');
  PERFORM pg_temp.expect_error(format(upd, 'status = ''done''', act), '23514');
  PERFORM pg_temp.expect_error(format(upd, 'entity_type = ''plan_item''', act), '23514');
  PERFORM pg_temp.expect_error(format(upd, 'overrides = ''[]''', act), '23514');
  PERFORM pg_temp.expect_error(format(upd, 'expires_at = NULL', act), '23502');
  UPDATE agent_actions SET status = 'executing', exec_token = gen_random_uuid() WHERE id = act;

  -- Settings, counters, origins.
  PERFORM pg_temp.expect_error(format('UPDATE agent_settings SET monthly_token_cap = 0 WHERE organization_id = %L', a), '23514');
  PERFORM pg_temp.expect_error(format('UPDATE agent_settings SET user_daily_token_cap = -1 WHERE organization_id = %L', a), '23514');
  PERFORM pg_temp.expect_error(format('INSERT INTO agent_usage_counters (organization_id, scope, subject_id, period_start) VALUES (%L, ''user_week'', %L, current_date)', a, u1), '23514');
  PERFORM pg_temp.expect_error(format('UPDATE agent_usage_counters SET used_tokens = -1 WHERE organization_id = %L', a), '23514');
  PERFORM pg_temp.expect_error(format('INSERT INTO agent_object_origins (organization_id, entity_type, entity_id, action_id, run_id, conversation_id, trigger_message_id, invoker_id, confirmer_id) '
    || 'VALUES (%L, ''plan'', gen_random_uuid(), %L, %L, %L, %L, %L, %L)', a, act, running, g, t, u1, u1), '23514');
  UPDATE agent_settings SET updated_at = now() - interval '1 day' WHERE organization_id = a;
  PERFORM pg_temp.ok((SELECT updated_at = now() FROM agent_settings WHERE organization_id = a), 'agent_settings.updated_at is maintained by trigger');
END $$;

-- ---------------------------------------------------------------- as the backend's role (SEC-05 BR-2)
-- The functions run with the caller's rights, so the whole life of a run must work as service_role,
-- and the audit trail must be add-and-read only for it.
SET LOCAL ROLE service_role;
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  robert uuid := '0b3e7000-0000-4000-8000-000000000001';
  rd uuid; t uuid; r uuid; q uuid; lease uuid; res jsonb; origin uuid := gen_random_uuid();
BEGIN
  PERFORM pg_temp.ok(current_user = 'service_role', 'this block runs as service_role');
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a, p_monthly => 1000000, p_daily => 1000000);

  -- All nine functions, once, as the backend calls them.
  rd := chat_get_or_create_agent_dm(a, u2, robert);
  t := pg_temp.say(a, rd, u2);
  res := agent_start_run(a, t, u2, 1000, 'Europe/Vienna', NULL, NULL, 1000000, 1000000);
  r := (res ->> 'run_id')::uuid;
  lease := (res ->> 'lease_token')::uuid;
  PERFORM pg_temp.ok(res ->> 'status' = 'running', 'service_role: start');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM agent_heartbeat(ARRAY[lease])), 'service_role: keep-alive');
  PERFORM pg_temp.ok(agent_set_step(r, lease, 'understanding'), 'service_role: step');
  PERFORM pg_temp.ok((agent_record_model_call(r, lease, 10, 5, 'h', true, NULL, 5) ->> 'recorded')::boolean, 'service_role: booking');
  PERFORM pg_temp.ok(agent_finalize_run(r, lease, 'completed', NULL, 'invoker', '{"reply_text":"ok","provider":"openai"}', pg_temp.actions(2), '{}') ->> 'status' = 'completed',
    'service_role: result with proposals, usage row and audit rows');
  PERFORM pg_temp.ok(agent_start_run(a, pg_temp.say(a, rd, u2), u2, 1000, NULL, NULL, 'not_configured') ->> 'refusal' = 'not_configured', 'service_role: refusal');
  -- A re-run that has to wait: supersedes the two proposals, is claimed, stopped and swept.
  res := agent_start_run(a, t, u2, 1000, NULL, r, NULL, 1000000, 0);
  q := (res ->> 'run_id')::uuid;
  PERFORM pg_temp.ok(res ->> 'status' = 'queued' AND (SELECT count(*) = 2 AND bool_and(status = 'cancelled' AND reason = 'superseded') FROM agent_actions WHERE run_id = r),
    'service_role: queued re-run');
  PERFORM pg_temp.ok((SELECT count(*) = 1 FROM agent_claim_runs(1000, 1000) AS c WHERE c.id = q), 'service_role: claim');
  PERFORM pg_temp.ok(agent_cancel_run(a, q, u2) ->> 'status' = 'running', 'service_role: stop');
  UPDATE agent_runs SET lease_expires_at = now() - interval '1 second' WHERE id = q;
  PERFORM pg_temp.ok((SELECT x.status = 'cancelled' FROM agent_reap_runs() AS x WHERE x.id = q), 'service_role: sweep');

  -- The audit trail: adding and reading work ...
  INSERT INTO agent_audit_events (organization_id, event, actor_id, data) VALUES (a, 'settings.changed', u2, '{"enabled":true}');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(seq IS NOT NULL AND occurred_at IS NOT NULL) FROM agent_audit_events WHERE organization_id = a AND event = 'settings.changed'),
    'service_role can add and read audit rows');
  -- ... changing, deleting and emptying do not, and neither does moving its numbering.
  PERFORM pg_temp.expect_error(format('UPDATE public.agent_audit_events SET data = ''{}'' WHERE organization_id = %L', a), '42501');
  PERFORM pg_temp.expect_error(format('DELETE FROM public.agent_audit_events WHERE organization_id = %L', a), '42501');
  PERFORM pg_temp.expect_error('TRUNCATE public.agent_audit_events', '42501');
  PERFORM pg_temp.expect_error('SELECT setval(''public.agent_audit_events_seq_seq'', 1)', '42501');
  PERFORM pg_temp.expect_error('SELECT nextval(''public.agent_audit_events_seq_seq'')', '42501');

  -- The other tables are plain tables for the backend.
  INSERT INTO agent_object_origins (organization_id, entity_type, entity_id, action_id, run_id, conversation_id, trigger_message_id, invoker_id, confirmer_id)
  VALUES (a, 'wiki_page', origin, gen_random_uuid(), r, rd, t, u2, u2);
  DELETE FROM agent_object_origins WHERE organization_id = a AND entity_type = 'wiki_page' AND entity_id = origin;
  PERFORM pg_temp.ok((SELECT count(*) = 1 FROM agent_settings WHERE organization_id = a AND monthly_token_cap = 1000000)
    AND (SELECT count(*) > 0 FROM agent_usage_counters WHERE organization_id = a) AND (SELECT count(*) = 2 FROM agent_actions WHERE run_id = r),
    'service_role reads and writes settings, counters, actions and origins');
END $$;
RESET ROLE;

-- The trigger stops everyone else too, the table owner included.
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  n bigint;
BEGIN
  PERFORM pg_temp.ok(current_user <> 'service_role', 'back to the owner');
  SELECT count(*) INTO n FROM agent_audit_events WHERE organization_id = a;
  PERFORM pg_temp.expect_error(format('UPDATE agent_audit_events SET event = ''tampered'' WHERE organization_id = %L', a), '42501');
  PERFORM pg_temp.expect_error(format('UPDATE agent_audit_events SET data = data WHERE seq = (SELECT max(seq) FROM agent_audit_events WHERE organization_id = %L)', a), '42501');
  PERFORM pg_temp.ok((SELECT count(*) = n AND NOT bool_or(event = 'tampered') FROM agent_audit_events WHERE organization_id = a), 'no audit row was changed');

  -- What this script wrote: only agreed event names, in the order things happened, and no text.
  PERFORM pg_temp.ok((SELECT array_agg(DISTINCT event COLLATE "C" ORDER BY event COLLATE "C") FROM agent_audit_events WHERE organization_id IN (a, b))
    = ARRAY['action.cancelled', 'run.cancelled', 'run.completed', 'run.failed', 'run.model_call', 'run.proposed', 'run.refused', 'run.started', 'settings.changed'],
    'the run functions write only the agreed audit events');
  PERFORM pg_temp.ok((SELECT bool_and(x.in_order) FROM (
      SELECT occurred_at >= lag(occurred_at, 1, occurred_at) OVER (ORDER BY seq) AS in_order FROM agent_audit_events WHERE organization_id IN (a, b)) AS x),
    'audit rows carry the real time of each event, in seq order');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_audit_events WHERE organization_id IN (a, b)
    AND (data::text ILIKE '%Robert bitte%' OR data::text LIKE '%too late%' OR data::text LIKE '%@example.invalid%' OR data::text LIKE '%Agent IT%')),
    'audit data holds no message text, reply text, email or name');
END $$;

-- ================================================================ proposed actions
-- The blocks below check the nine action functions: edit, confirm (claim and outcome), "Link
-- instead", undo (claim and outcome), cancel, the two sweeps, the organization boundary and the
-- backend's role.

-- ---------------------------------------------------------------- edit a proposal (ROB-04 BR-2, ROB-17)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  s1 uuid := 'a9e00000-0000-4000-8000-0000000000e1';
  s2 uuid := 'a9e00000-0000-4000-8000-0000000000e2';
  g uuid := pg_temp.conv('Agent IT main');
  scope1 jsonb := jsonb_build_object('spaces', jsonb_build_array(jsonb_build_object('id', s2, 'perm', 'view_tasks')), 'refs', '[]'::jsonb);
  none jsonb := '{"spaces":[],"refs":[]}';
  patch text := 'SELECT agent_patch_action(%L, %L, %L, %L, %L, %L, NULL, %L, false, NULL)';
  r uuid; x agent_actions; y agent_actions; z agent_actions; res jsonb; rev0 bigint;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  r := pg_temp.proposed(a, g, u1, 3);
  x := pg_temp.act(r, 1);
  rev0 := pg_temp.rev(r);
  PERFORM pg_temp.ok(x.status = 'proposed' AND x.version = 1 AND x.overrides = '{}'::jsonb AND x.target_space_id IS NULL
    AND (SELECT visibility = 'conversation' AND scope = none FROM agent_runs WHERE id = r), 'a fresh proposal: version 1, nothing edited');

  -- The invoker edits the first proposal.
  res := agent_patch_action(a, x.id, u1, 1, '{"title":"Geheimer Titel"}', '{"title":"Geheimer Titel","confirmable":true}', s2, scope1, false,
    '{"fields":["title"],"title_hash":"ab12","version":"overridden by the database"}');
  y := pg_temp.act(r, 1);
  PERFORM pg_temp.ok(res = '{"updated":true,"version":2}'::jsonb, format('edit stored, got %s', res));
  PERFORM pg_temp.ok(y.overrides = '{"title":"Geheimer Titel"}'::jsonb AND y.resolved = '{"title":"Geheimer Titel","confirmable":true}'::jsonb AND y.target_space_id = s2
    AND y.version = 2 AND y.status = 'proposed' AND y.intent = x.intent AND y.entity_id = x.entity_id AND y.expires_at = x.expires_at AND y.exec_token IS NULL
    AND y.attempts = 0 AND y.confirmed_by IS NULL, 'edit: overrides, resolved and space stored, version up by one, intent and reserved id untouched');
  PERFORM pg_temp.ok((SELECT rev = rev0 + 1 AND scope = scope1 AND visibility = 'conversation' FROM agent_runs WHERE id = r),
    'edit: the run gets the new scope and a new rev; without p_narrow the audience stays');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(e.actor_id = u1 AND e.organization_id = a AND e.action_id = x.id AND e.conversation_id = g AND e.space_id = s2
      AND e.entity_type = 'task' AND e.entity_id = x.entity_id AND (e.data ->> 'version')::int = 2 AND (e.data ->> 'ordinal')::int = 1 AND e.data ->> 'kind' = 'task'
      AND e.data ->> 'title_hash' = 'ab12' AND e.data -> 'fields' = '["title"]'::jsonb AND NOT e.data ? 'narrowed')
    FROM agent_audit_events e WHERE e.run_id = r AND e.event = 'action.edited'), 'audit: action.edited keeps the caller''s hashes, the facts come from the database');
  PERFORM pg_temp.ok((SELECT bool_and(version = 1 AND overrides = '{}'::jsonb AND target_space_id IS NULL) FROM agent_actions WHERE run_id = r AND ordinal > 1),
    'edit: the other proposals of the run are untouched');

  -- A stale version changes nothing: not the action, not the scope, not the audience.
  res := agent_patch_action(a, x.id, u1, 1, '{"title":"Alt"}', '{}', NULL, none, true, NULL);
  PERFORM pg_temp.ok(res = '{"updated":false,"version":2}'::jsonb, format('stale version: not updated, current version returned, got %s', res));
  res := agent_patch_action(a, x.id, u1, 3, '{"title":"Zukunft"}', '{}', NULL, none, true, NULL);
  PERFORM pg_temp.ok(res = '{"updated":false,"version":2}'::jsonb, 'a version that does not exist yet is stale too');
  res := agent_patch_action(a, x.id, u1, NULL, '{"title":"Ohne"}', '{}', NULL, none, true, NULL);
  PERFORM pg_temp.ok(res = '{"updated":false,"version":2}'::jsonb, 'no version is stale');
  PERFORM pg_temp.ok(pg_temp.act(r, 1) = y AND pg_temp.rev(r) = rev0 + 1 AND pg_temp.audits(r, 'action.edited') = 1
    AND (SELECT scope = scope1 AND visibility = 'conversation' FROM agent_runs WHERE id = r), 'a stale edit changes nothing');

  -- The audience can only shrink.
  res := agent_patch_action(a, x.id, u1, 2, '{"title":"Geheimer Titel"}', '{}', s2, NULL, true, NULL);
  PERFORM pg_temp.ok(res = '{"updated":true,"version":3}'::jsonb
    AND (SELECT visibility = 'invoker' AND scope = scope1 AND rev = rev0 + 2 FROM agent_runs WHERE id = r),
    'p_narrow makes the run invoker-only; a NULL scope leaves the scope as it is');
  res := agent_patch_action(a, x.id, u1, 3, '{}', '{}', NULL, none, false, NULL);
  y := pg_temp.act(r, 1);
  PERFORM pg_temp.ok(res = '{"updated":true,"version":4}'::jsonb AND y.overrides = '{}'::jsonb AND y.target_space_id IS NULL
    AND (SELECT visibility = 'invoker' AND scope = none AND rev = rev0 + 3 FROM agent_runs WHERE id = r),
    'a later edit without p_narrow never widens the audience again; the scope is replaced');
  res := agent_patch_action(a, x.id, u1, 4, '{}', '{}', NULL, none, true, NULL);
  PERFORM pg_temp.ok((SELECT count(*) = 4 AND count(*) FILTER (WHERE (e.data ->> 'narrowed')::boolean) = 1 FROM agent_audit_events e WHERE e.run_id = r AND e.event = 'action.edited'),
    'audit: one row per edit; "narrowed" only on the edit that narrowed');

  -- Only the invoker, only inside the organization; for everyone else the action does not exist.
  PERFORM pg_temp.expect_error(format(patch, a, x.id, u2, 5, '{}', '{}', none), 'P0002');                 -- a colleague
  PERFORM pg_temp.expect_error(format(patch, b, x.id, u1, 5, '{}', '{}', none), 'P0002');                 -- the invoker, through another organization
  PERFORM pg_temp.expect_error(format(patch, a, x.id, NULL, 5, '{}', '{}', none), 'P0002');               -- nobody
  PERFORM pg_temp.expect_error(format(patch, a, gen_random_uuid(), u1, 5, '{}', '{}', none), 'P0002');    -- no such action
  PERFORM pg_temp.expect_error(format(patch, a, r, u1, 5, '{}', '{}', none), 'P0002');                    -- a run id is not an action id
  -- Values that do not fit are invalid input.
  PERFORM pg_temp.expect_error(format(patch, a, x.id, u1, 5, '[]', '{}', none), '22023');                 -- overrides are not an object
  PERFORM pg_temp.expect_error(format(patch, a, x.id, u1, 5, NULL, '{}', none), '22023');                 -- no overrides
  PERFORM pg_temp.expect_error(format(patch, a, x.id, u1, 5, '{}', '"text"', none), '22023');             -- resolved is not an object
  PERFORM pg_temp.expect_error(format(patch, a, x.id, u1, 5, '{}', NULL, none), '22023');                 -- no resolved
  PERFORM pg_temp.expect_error(format(patch, a, x.id, u1, 5, '{}', '{}', '[]'), '22023');                 -- scope is not an object
  PERFORM pg_temp.ok((pg_temp.act(r, 1)).version = 5 AND pg_temp.rev(r) = rev0 + 4 AND pg_temp.audits(r, 'action.edited') = 4, 'a refused edit changes nothing');

  -- Open means proposed, or failed and waiting for "Edit and retry" (ROB-14). Nothing else can be edited.
  PERFORM pg_temp.confirm(r, 2, 'failed', 'no_create_permission');
  z := pg_temp.act(r, 2);
  res := agent_patch_action(a, z.id, u1, 1, '{"space":"e1"}', '{"confirmable":true}', s1, NULL, false, NULL);
  y := pg_temp.act(r, 2);
  PERFORM pg_temp.ok(res = '{"updated":true,"version":2}'::jsonb AND y.status = 'failed' AND y.reason = 'no_create_permission' AND y.version = 2 AND y.target_space_id = s1,
    'a failed action can be edited before the retry; it stays failed until it is retried');
  PERFORM count(*) FROM agent_claim_actions(a, r, u1, pg_temp.versions(r, ARRAY[3]));
  z := pg_temp.act(r, 3);
  res := agent_patch_action(a, z.id, u1, 1, '{"title":"zu spaet"}', '{}', NULL, NULL, true, NULL);
  PERFORM pg_temp.ok(z.status = 'executing' AND res = '{"updated":false,"version":1}'::jsonb AND pg_temp.act(r, 3) = z, 'an action that is being created cannot be edited');
  PERFORM pg_temp.ok(agent_cancel_actions(a, 'user', p_action_ids => ARRAY[x.id], p_actor_id => u1) = 1, 'the first proposal is cancelled');
  res := agent_patch_action(a, x.id, u1, 5, '{"title":"zu spaet"}', '{}', NULL, NULL, false, NULL);
  PERFORM pg_temp.ok(res = '{"updated":false,"version":5}'::jsonb AND (pg_temp.act(r, 1)).overrides = '{}'::jsonb, 'a cancelled proposal cannot be edited');
END $$;

-- ---------------------------------------------------------------- confirm: the claim (ROB-04 BR-3, EC-B1)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  g uuid := pg_temp.conv('Agent IT main');
  r uuid; r2 uuid; r3 uuid; v jsonb; rev0 bigint;
  ids uuid[]; toks uuid[]; ords int[];
  x agent_actions; res jsonb;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  r := pg_temp.proposed(a, g, u1, 4);
  rev0 := pg_temp.rev(r);
  -- Confirm names proposals 1 and 2 at the version on the card and 4 at a version the invoker never saw; 3 is not named.
  v := pg_temp.versions(r, ARRAY[1, 2]) || jsonb_build_object((pg_temp.act(r, 4)).id::text, 7);

  -- Refused: nothing is handed out and nothing changes.
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r, u2, v)), 'a colleague cannot confirm');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_actions(b, r, u1, v)), 'the invoker cannot confirm through another organization');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r, NULL, v)) AND NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, gen_random_uuid(), u1, v)),
    'nobody, or no such run: nothing');
  r3 := pg_temp.proposed(a, g, u2, 1);
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r, u1, pg_temp.versions(r3))) AND NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r3, u1, pg_temp.versions(r3)))
    AND pg_temp.states(r3) = 'proposed:-', 'a colleague''s proposal cannot be confirmed, also not by naming it under one''s own run');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r, u1, NULL)) AND NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r, u1, '{}'))
    AND NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r, u1, '[]')) AND NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r, u1, '"all"'))
    AND NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r, u1, jsonb_build_object((pg_temp.act(r, 1)).id::text, 'one'))),
    'no versions named, or values that are not versions: nothing');
  UPDATE agent_runs SET status = 'failed' WHERE id = r;
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r, u1, v)), 'a run that is not completed: nothing');
  UPDATE agent_runs SET status = 'completed' WHERE id = r;
  UPDATE agent_actions SET expires_at = now() WHERE run_id = r;
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r, u1, v)), 'proposals that expire this very moment: nothing');
  UPDATE agent_actions SET expires_at = now() + interval '1 second' WHERE run_id = r;
  PERFORM pg_temp.ok((SELECT bool_and(status = 'proposed' AND exec_token IS NULL AND attempts = 0 AND confirmed_by IS NULL AND exec_started_at IS NULL) FROM agent_actions WHERE run_id = r)
    AND pg_temp.rev(r) = rev0 AND pg_temp.audits(r, 'action.confirmed') = 0, 'a refused Confirm changes nothing and writes no audit row');

  -- The claim: exactly the two proposals named at the right version, each with its own token.
  SELECT array_agg(c.id), array_agg(c.exec_token), array_agg(c.ordinal::int) INTO ids, toks, ords FROM agent_claim_actions(a, r, u1, v) AS c;
  PERFORM pg_temp.ok(ords = ARRAY[1, 2] AND toks[1] IS NOT NULL AND toks[2] IS NOT NULL AND toks[1] <> toks[2], format('Confirm hands out actions 1 and 2 in card order, got %s', ords));
  PERFORM pg_temp.ok((SELECT bool_and(status = 'executing' AND exec_token = toks[ordinal] AND exec_started_at = now() AND attempts = 1 AND confirmed_by = u1 AND version = 1
      AND executed_at IS NULL AND undo_until IS NULL) FROM agent_actions WHERE run_id = r AND ordinal IN (1, 2)),
    'claimed: executing, the token that was handed out, first attempt, confirmed by the invoker');
  PERFORM pg_temp.ok((SELECT bool_and(status = 'proposed' AND exec_token IS NULL AND attempts = 0 AND confirmed_by IS NULL) FROM agent_actions WHERE run_id = r AND ordinal IN (3, 4)),
    'not named, or named at a stale version: untouched');
  PERFORM pg_temp.ok(pg_temp.rev(r) = rev0 + 1, 'one Confirm, one new rev');
  PERFORM pg_temp.ok((SELECT count(*) = 2 AND bool_and(e.actor_id = u1 AND e.organization_id = a AND e.conversation_id = g AND e.entity_type = x2.entity_type AND e.entity_id = x2.entity_id
      AND (e.data ->> 'ordinal')::int = x2.ordinal AND (e.data ->> 'version')::int = 1 AND (e.data ->> 'attempt')::int = 1 AND e.data ->> 'kind' = 'task')
    FROM agent_audit_events e JOIN agent_actions x2 ON x2.id = e.action_id WHERE e.run_id = r AND e.event = 'action.confirmed'),
    'audit: one action.confirmed row per claimed action, written by the claim itself');
  PERFORM pg_temp.ok(pg_temp.audits(r, 'action.executed') = 0 AND NOT EXISTS (SELECT 1 FROM agent_object_origins WHERE run_id = r), 'the claim creates nothing');

  -- Confirm pressed again (double click, retry of the request): nothing.
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r, u1, v)), 'a second Confirm gets nothing');
  PERFORM pg_temp.ok((SELECT bool_and(exec_token = toks[ordinal] AND attempts = 1) FROM agent_actions WHERE run_id = r AND ordinal IN (1, 2))
    AND pg_temp.rev(r) = rev0 + 1 AND pg_temp.audits(r, 'action.confirmed') = 2, 'and changes nothing: same tokens, same rev, no second audit row');

  -- Retry of a failed action: claimed again with a new token, the old reason is gone.
  res := agent_complete_action(ids[1], toks[1], 'failed', 'no_create_permission', '{"space":"AGIT1"}', NULL);
  PERFORM pg_temp.ok((res ->> 'completed')::boolean AND (pg_temp.act(r, 1)).status = 'failed', 'the first action failed');
  SELECT * INTO x FROM agent_claim_actions(a, r, u1, pg_temp.versions(r, ARRAY[1]));
  PERFORM pg_temp.ok(x.id = ids[1] AND x.status = 'executing' AND x.attempts = 2 AND x.exec_token <> toks[1] AND x.reason IS NULL AND x.reason_params IS NULL
    AND x.confirmed_by = u1 AND pg_temp.act(r, 1) = x, 'retry: a failed action is claimed again, second attempt, new token, reason cleared');
  PERFORM pg_temp.ok((SELECT count(*) = 1 FROM agent_audit_events e WHERE e.action_id = ids[1] AND e.event = 'action.confirmed' AND (e.data ->> 'attempt')::int = 2),
    'audit: the retry is a confirmation of its own');
  PERFORM pg_temp.ok(NOT (agent_complete_action(ids[1], toks[1], 'executed', NULL, NULL, NULL) ->> 'completed')::boolean, 'the token of the first attempt is dead');

  -- The request was deleted: its proposals can no longer be confirmed (ROB-02 BR-8).
  r2 := pg_temp.proposed(a, g, u1, 2);
  PERFORM chat_delete_message(a, (SELECT trigger_message_id FROM agent_runs WHERE id = r2), u1);
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r2, u1, pg_temp.versions(r2))), 'request deleted: nothing can be confirmed');
  PERFORM pg_temp.ok(pg_temp.states(r2) = 'proposed:-,proposed:-' AND pg_temp.audits(r2, 'action.confirmed') = 0, 'and the proposals are untouched');
END $$;

-- ---------------------------------------------------------------- confirm: the outcome (ROB-04, ROB-13, ROB-14)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  g uuid := pg_temp.conv('Agent IT main');
  bogus uuid := gen_random_uuid();
  done text := 'SELECT agent_complete_action(%L, %L, %L, %L, NULL, NULL)';
  t uuid; m2 uuid; r uuid; r2 uuid; rev0 bigint;
  c1 agent_actions; c2 agent_actions; c3 agent_actions; c4 agent_actions; x agent_actions;
  o agent_object_origins; res jsonb;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  -- A run that read two messages and proposes four objects; all four are confirmed.
  t := pg_temp.say(a, g, u1);
  m2 := pg_temp.say(a, g, u2);
  r := (pg_temp.start(a, t, u1) ->> 'run_id')::uuid;
  PERFORM agent_finalize_run(r, (SELECT lease_token FROM agent_runs WHERE id = r), 'completed', NULL, 'conversation',
    jsonb_build_object('context_message_ids', jsonb_build_array(m2, t)), pg_temp.actions(4), NULL);
  PERFORM pg_temp.ok((SELECT count(*) = 4 FROM agent_claim_actions(a, r, u1, pg_temp.versions(r))), 'four actions claimed');
  c1 := pg_temp.act(r, 1); c2 := pg_temp.act(r, 2); c3 := pg_temp.act(r, 3); c4 := pg_temp.act(r, 4);
  rev0 := pg_temp.rev(r);

  -- Without the token of this action nothing happens, and nothing is revealed.
  res := agent_complete_action(c1.id, bogus, 'executed', NULL, NULL, NULL);
  PERFORM pg_temp.ok(res = '{"completed":false,"status":null}'::jsonb, format('unknown token: not completed, got %s', res));
  PERFORM pg_temp.ok(agent_complete_action(c1.id, c2.exec_token, 'executed', NULL, NULL, NULL) = '{"completed":false,"status":null}'::jsonb
    AND agent_complete_action(c1.id, NULL, 'executed', NULL, NULL, NULL) = '{"completed":false,"status":null}'::jsonb
    AND agent_complete_action(gen_random_uuid(), c1.exec_token, 'failed', 'failed', NULL, NULL) = '{"completed":false,"status":null}'::jsonb
    AND agent_complete_undo(c1.id, c1.exec_token, 'undone', NULL, NULL, u1) = '{"completed":false,"status":null}'::jsonb,
    'another action''s token, no token, the token with another action id, or the undo function with a confirm token: not completed');
  -- Values that do not fit are invalid input; the token still holds afterwards.
  PERFORM pg_temp.expect_error(format(done, c1.id, c1.exec_token, 'done', NULL), '22023');                                    -- unknown outcome
  PERFORM pg_temp.expect_error(format(done, c1.id, c1.exec_token, NULL, NULL), '22023');                                      -- no outcome
  PERFORM pg_temp.expect_error(format(done, c1.id, c1.exec_token, 'failed', NULL), '22023');                                  -- a failure needs a reason
  PERFORM pg_temp.expect_error(format(done, c1.id, c1.exec_token, 'failed', 'Anna Huber has no access to IT Operations'), '22023');  -- a sentence is not a code
  PERFORM pg_temp.expect_error(format(done, c1.id, c1.exec_token, 'executed', 'No_Code'), '22023');
  PERFORM pg_temp.ok(pg_temp.act(r, 1) = c1 AND pg_temp.act(r, 2) = c2 AND pg_temp.rev(r) = rev0 AND pg_temp.audits(r, 'action.executed') + pg_temp.audits(r, 'action.failed') = 0
    AND NOT EXISTS (SELECT 1 FROM agent_object_origins WHERE run_id = r), 'a refused outcome changes nothing: no status, no rev, no audit row, no origin row');

  -- executed: undo window of 10 minutes and the "created by Robert" row.
  res := agent_complete_action(c1.id, c1.exec_token, 'executed', 'ignored_code', '{"ignored":1}', '{"values_hash":"cd34","status":"overridden by the database"}');
  x := pg_temp.act(r, 1);
  PERFORM pg_temp.ok(res = '{"completed":true,"status":"executed"}'::jsonb, format('executed, got %s', res));
  PERFORM pg_temp.ok(x.status = 'executed' AND x.exec_token IS NULL AND x.executed_at = now() AND x.undo_until = now() + interval '10 minutes' AND x.reason IS NULL
    AND x.reason_params IS NULL AND x.confirmed_by = u1 AND x.version = 1 AND x.attempts = 1 AND x.entity_id = c1.entity_id,
    'executed: token gone, undo possible for 10 minutes, no reason kept');
  PERFORM pg_temp.ok(pg_temp.rev(r) = rev0 + 1, 'executed: the run gets a new rev');
  SELECT * INTO o FROM agent_object_origins WHERE organization_id = a AND entity_type = 'task' AND entity_id = c1.entity_id;
  PERFORM pg_temp.ok(o.action_id = c1.id AND o.run_id = r AND o.conversation_id = g AND o.trigger_message_id = t AND o.source_message_ids = ARRAY[m2, t]
    AND o.invoker_id = u1 AND o.confirmer_id = u1 AND o.created_at = now() AND (SELECT count(*) = 1 FROM agent_object_origins WHERE run_id = r),
    'executed: one origin row, built from the run (request, messages read, invoker) and the action (object, confirmer)');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(e.actor_id = u1 AND e.organization_id = a AND e.conversation_id = g AND e.action_id = c1.id AND e.entity_type = 'task'
      AND e.entity_id = c1.entity_id AND e.data ->> 'outcome' = 'executed' AND e.data ->> 'status' = 'executed' AND e.data ->> 'values_hash' = 'cd34'
      AND (e.data ->> 'undo_until')::timestamptz = now() + interval '10 minutes' AND (e.data ->> 'attempt')::int = 1 AND NOT e.data ? 'reason')
    FROM agent_audit_events e WHERE e.run_id = r AND e.event = 'action.executed'), 'audit: action.executed');
  -- Audit order: proposed, then confirmed, then executed.
  PERFORM pg_temp.ok((SELECT max(seq) FROM agent_audit_events WHERE run_id = r AND event = 'run.proposed') < (SELECT min(seq) FROM agent_audit_events WHERE run_id = r AND event = 'action.confirmed')
    AND (SELECT seq FROM agent_audit_events WHERE action_id = c1.id AND event = 'action.confirmed') < (SELECT seq FROM agent_audit_events WHERE action_id = c1.id AND event = 'action.executed')
    AND (SELECT max(seq) FROM agent_audit_events WHERE run_id = r AND event = 'action.confirmed') < (SELECT min(seq) FROM agent_audit_events WHERE run_id = r AND event = 'action.executed'),
    'audit order: every confirmation is on record before anything is executed');
  -- The token is used up.
  res := agent_complete_action(c1.id, c1.exec_token, 'failed', 'late', NULL, NULL);
  PERFORM pg_temp.ok(res = '{"completed":false,"status":null}'::jsonb AND pg_temp.act(r, 1) = x AND pg_temp.audits(r, 'action.failed') = 0
    AND (SELECT count(*) = 1 FROM agent_object_origins WHERE run_id = r), 'the same token a second time: nothing');

  -- The object of action 2 was adopted after a crash and already has its origin row: it is kept, never doubled.
  INSERT INTO agent_object_origins (organization_id, entity_type, entity_id, action_id, run_id, conversation_id, trigger_message_id, source_message_ids, invoker_id, confirmer_id, created_at)
  VALUES (a, 'task', c2.entity_id, c2.id, r, g, t, ARRAY[t], u1, u1, now() - interval '1 hour');
  res := agent_complete_action(c2.id, c2.exec_token, 'executed', NULL, NULL, NULL);
  PERFORM pg_temp.ok((res ->> 'completed')::boolean AND (SELECT count(*) = 1 AND bool_and(o2.created_at = now() - interval '1 hour' AND o2.source_message_ids = ARRAY[t])
      FROM agent_object_origins o2 WHERE o2.organization_id = a AND o2.entity_id = c2.entity_id)
    AND (SELECT count(*) = 2 FROM agent_object_origins WHERE run_id = r), 'an origin row that is already there is kept as it is: one row per object');

  -- failed: the reason code and its parameters for the card; the parameters never reach the audit trail.
  res := agent_complete_action(c3.id, c3.exec_token, 'failed', 'attr_missing', '{"attribute":"Standort"}', '{"error_hash":"ee"}');
  x := pg_temp.act(r, 3);
  PERFORM pg_temp.ok(res = '{"completed":true,"status":"failed"}'::jsonb AND x.status = 'failed' AND x.exec_token IS NULL AND x.reason = 'attr_missing'
    AND x.reason_params = '{"attribute":"Standort"}'::jsonb AND x.executed_at IS NULL AND x.undo_until IS NULL AND x.confirmed_by = u1 AND x.version = 1,
    format('failed: reason stored, nothing to undo, got %s', res));
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_object_origins WHERE entity_id = c3.entity_id)
    AND (SELECT count(*) = 1 AND bool_and(e.actor_id = u1 AND e.data ->> 'outcome' = 'failed' AND e.data ->> 'status' = 'failed' AND e.data ->> 'reason' = 'attr_missing'
        AND e.data ->> 'error_hash' = 'ee' AND NOT e.data ? 'undo_until' AND e.data::text NOT LIKE '%Standort%')
      FROM agent_audit_events e WHERE e.action_id = c3.id AND e.event = 'action.failed'), 'failed: no origin row; audit action.failed with the code only');

  -- released: back on the card as it was, at the same version, confirmed by nobody.
  res := agent_complete_action(c4.id, c4.exec_token, 'released', 'parent_failed', NULL, NULL);
  x := pg_temp.act(r, 4);
  PERFORM pg_temp.ok(res = '{"completed":true,"status":"proposed"}'::jsonb AND x.status = 'proposed' AND x.version = c4.version AND x.exec_token IS NULL AND x.confirmed_by IS NULL
    AND x.attempts = 1 AND x.reason = 'parent_failed' AND x.executed_at IS NULL AND x.undo_until IS NULL AND x.expires_at = c4.expires_at,
    format('released: proposed again, version unchanged, got %s', res));
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(e.actor_id = u1 AND e.data ->> 'outcome' = 'released' AND e.data ->> 'status' = 'proposed' AND e.data ->> 'reason' = 'parent_failed')
    FROM agent_audit_events e WHERE e.action_id = c4.id AND e.event = 'action.failed') AND NOT EXISTS (SELECT 1 FROM agent_object_origins WHERE entity_id = c4.entity_id),
    'audit: a release is recorded as action.failed with outcome released');
  PERFORM pg_temp.ok(pg_temp.rev(r) = rev0 + 4, 'every outcome gives the run a new rev');
  SELECT * INTO x FROM agent_claim_actions(a, r, u1, jsonb_build_object(c4.id::text, c4.version));
  PERFORM pg_temp.ok(x.id = c4.id AND x.attempts = 2 AND x.reason IS NULL AND x.confirmed_by = u1, 'a released action can be confirmed again at the version the invoker saw');
  res := agent_complete_action(x.id, x.exec_token, 'released', NULL, NULL, NULL);
  PERFORM pg_temp.ok(res = '{"completed":true,"status":"proposed"}'::jsonb AND (pg_temp.act(r, 4)).reason IS NULL, 'a release needs no reason');

  -- A run whose invoker was deleted between Confirm and the outcome: the object still gets its row.
  r2 := pg_temp.proposed(a, g, u1, 1);
  SELECT * INTO x FROM agent_claim_actions(a, r2, u1, pg_temp.versions(r2));
  UPDATE agent_runs SET invoker_id = NULL WHERE id = r2;
  res := agent_complete_action(x.id, x.exec_token, 'executed', NULL, NULL, NULL);
  PERFORM pg_temp.ok((res ->> 'completed')::boolean AND (SELECT count(*) = 1 AND bool_and(o2.invoker_id = u1 AND o2.confirmer_id = u1) FROM agent_object_origins o2 WHERE o2.run_id = r2)
    AND (SELECT e.actor_id = u1 FROM agent_audit_events e WHERE e.run_id = r2 AND e.event = 'action.executed'), 'an outcome never fails because the invoker is gone');
  UPDATE agent_runs SET invoker_id = u1 WHERE id = r2;
END $$;

-- ---------------------------------------------------------------- "Link instead" (ROB-11 BR-3)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  s2 uuid := 'a9e00000-0000-4000-8000-0000000000e2';
  g uuid := pg_temp.conv('Agent IT main');
  target uuid := gen_random_uuid();
  page uuid := gen_random_uuid();
  none jsonb := '{"spaces":[],"refs":[]}';
  scope1 jsonb := jsonb_build_object('spaces', jsonb_build_array(jsonb_build_object('id', s2, 'perm', 'view_tasks')), 'refs', jsonb_build_array(jsonb_build_object('type', 'task', 'id', target)));
  link text := 'SELECT agent_link_action(%L, %L, %L, 1, %L, %L, %L, false)';
  r uuid; r2 uuid; x agent_actions; y agent_actions; res jsonb; rev0 bigint;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  r := pg_temp.proposed(a, g, u1, 3);
  x := pg_temp.act(r, 1);
  rev0 := pg_temp.rev(r);

  -- Only the invoker, only inside the organization.
  PERFORM pg_temp.expect_error(format(link, a, x.id, u2, 'task', target, none), 'P0002');                  -- a colleague
  PERFORM pg_temp.expect_error(format(link, b, x.id, u1, 'task', target, none), 'P0002');                  -- through another organization
  PERFORM pg_temp.expect_error(format(link, a, x.id, NULL, 'task', target, none), 'P0002');
  PERFORM pg_temp.expect_error(format(link, a, gen_random_uuid(), u1, 'task', target, none), 'P0002');
  PERFORM pg_temp.expect_error(format(link, a, x.id, u1, NULL, target, none), '22023');                    -- no type
  PERFORM pg_temp.expect_error(format(link, a, x.id, u1, 'task', NULL, none), '22023');                    -- no object
  PERFORM pg_temp.expect_error(format(link, a, x.id, u1, 'Task XE-T346', target, none), '22023');          -- a type is a code
  PERFORM pg_temp.expect_error(format(link, a, x.id, u1, 'task', target, '[]'), '22023');                  -- scope is not an object
  -- Stale, expired, run not completed: not linked.
  PERFORM pg_temp.ok(agent_link_action(a, x.id, u1, 2, 'task', target, scope1, true) = '{"linked":false}'::jsonb
    AND agent_link_action(a, x.id, u1, NULL, 'task', target, scope1, true) = '{"linked":false}'::jsonb, 'a stale version is not linked');
  UPDATE agent_actions SET expires_at = now() WHERE id = x.id;
  PERFORM pg_temp.ok(agent_link_action(a, x.id, u1, 1, 'task', target, scope1, true) = '{"linked":false}'::jsonb, 'an expired proposal is not linked');
  UPDATE agent_actions SET expires_at = x.expires_at WHERE id = x.id;
  UPDATE agent_runs SET status = 'cancelled' WHERE id = r;
  PERFORM pg_temp.ok(agent_link_action(a, x.id, u1, 1, 'task', target, scope1, true) = '{"linked":false}'::jsonb, 'not linked while the run is not completed');
  UPDATE agent_runs SET status = 'completed' WHERE id = r;
  PERFORM pg_temp.ok(pg_temp.act(r, 1) = x AND pg_temp.rev(r) = rev0 AND pg_temp.audits(r, 'action.linked') = 0
    AND (SELECT visibility = 'conversation' AND scope = none FROM agent_runs WHERE id = r), 'a refused link changes nothing: not the action, not the scope, not the audience');

  -- Linked: the existing object is touched now, and here that makes the card invoker-only.
  res := agent_link_action(a, x.id, u1, 1, 'task', target, scope1, true);
  y := pg_temp.act(r, 1);
  PERFORM pg_temp.ok(res = '{"linked":true}'::jsonb, format('linked, got %s', res));
  PERFORM pg_temp.ok(y.status = 'linked' AND y.linked_entity_type = 'task' AND y.linked_entity_id = target AND y.undo_until = now() + interval '10 minutes' AND y.version = 1
    AND y.exec_token IS NULL AND y.executed_at IS NULL AND y.entity_id = x.entity_id AND y.attempts = 0, 'linked: the existing object is stored, undo possible for 10 minutes');
  PERFORM pg_temp.ok((SELECT rev = rev0 + 1 AND scope = scope1 AND visibility = 'invoker' FROM agent_runs WHERE id = r), 'linked: scope replaced, audience narrowed, new rev');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(e.actor_id = u1 AND e.organization_id = a AND e.conversation_id = g AND e.action_id = x.id AND e.entity_type = 'task'
      AND e.entity_id = target AND (e.data ->> 'narrowed')::boolean AND (e.data ->> 'version')::int = 1)
    FROM agent_audit_events e WHERE e.run_id = r AND e.event = 'action.linked'), 'audit: action.linked names the linked object');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_object_origins WHERE run_id = r), 'nothing was created, so there is no origin row');

  -- A linked action is closed for everything but undo.
  PERFORM pg_temp.ok(agent_link_action(a, x.id, u1, 1, 'task', gen_random_uuid(), none, false) = '{"linked":false}'::jsonb
    AND NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r, u1, pg_temp.versions(r, ARRAY[1])))
    AND agent_patch_action(a, x.id, u1, 1, '{}', '{}', NULL, NULL, false, NULL) = '{"updated":false,"version":1}'::jsonb
    AND agent_cancel_actions(a, 'user', p_action_ids => ARRAY[x.id], p_actor_id => u1) = 0, 'a linked action cannot be linked again, confirmed, edited or cancelled');
  PERFORM pg_temp.ok(pg_temp.act(r, 1) = y, 'and it is unchanged');

  -- The audience never widens through a link either.
  res := agent_link_action(a, (pg_temp.act(r, 2)).id, u1, 1, 'wiki_page', page, none, false);
  PERFORM pg_temp.ok(res = '{"linked":true}'::jsonb AND (SELECT visibility = 'invoker' AND scope = none FROM agent_runs WHERE id = r)
    AND (SELECT count(*) = 1 AND bool_and(e.entity_type = 'wiki_page' AND e.entity_id = page AND NOT e.data ? 'narrowed') FROM agent_audit_events e
         WHERE e.action_id = (pg_temp.act(r, 2)).id AND e.event = 'action.linked'), 'a second link without p_narrow leaves the run invoker-only');

  -- Only a proposal can be linked: not a failed action, not after the request was deleted.
  PERFORM pg_temp.confirm(r, 3, 'failed', 'attr_duplicate');
  PERFORM pg_temp.ok(agent_link_action(a, (pg_temp.act(r, 3)).id, u1, 1, 'task', target, none, false) = '{"linked":false}'::jsonb, 'a failed action is not linked');
  r2 := pg_temp.proposed(a, g, u1, 1);
  PERFORM chat_delete_message(a, (SELECT trigger_message_id FROM agent_runs WHERE id = r2), u1);
  PERFORM pg_temp.ok(agent_link_action(a, (pg_temp.act(r2, 1)).id, u1, 1, 'task', target, none, false) = '{"linked":false}'::jsonb
    AND pg_temp.states(r2) = 'proposed:-', 'request deleted: nothing can be linked');
END $$;

-- ---------------------------------------------------------------- undo (ROB-12)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  u9 uuid := 'a9e00000-0000-4000-8000-000000000009';
  g uuid := pg_temp.conv('Agent IT main');
  target uuid := gen_random_uuid();
  bogus uuid := gen_random_uuid();
  undo text := 'SELECT agent_complete_undo(%L, %L, %L, %L, NULL, %L)';
  r uuid; e1 agent_actions; e2 agent_actions; l3 agent_actions; p4 agent_actions; x agent_actions; y agent_actions;
  every uuid[]; got uuid[]; res jsonb; rev0 bigint; exec_seq bigint; link_seq bigint;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  -- Two created objects, one linked object, one proposal that is still open.
  r := pg_temp.proposed(a, g, u1, 4);
  PERFORM pg_temp.confirm(r, 1);
  PERFORM pg_temp.confirm(r, 2);
  PERFORM pg_temp.ok(agent_link_action(a, (pg_temp.act(r, 3)).id, u1, 1, 'task', target, NULL, false) = '{"linked":true}'::jsonb, 'third proposal linked');
  -- (The clock is frozen: move the time of the Confirm back, so that the Undo's own start time shows.)
  UPDATE agent_actions SET exec_started_at = now() - interval '5 minutes' WHERE run_id = r AND exec_started_at IS NOT NULL;
  e1 := pg_temp.act(r, 1); e2 := pg_temp.act(r, 2); l3 := pg_temp.act(r, 3); p4 := pg_temp.act(r, 4);
  every := ARRAY[e1.id, e2.id, l3.id, p4.id];
  rev0 := pg_temp.rev(r);
  SELECT seq INTO exec_seq FROM agent_audit_events WHERE action_id = e1.id AND event = 'action.executed';
  SELECT seq INTO link_seq FROM agent_audit_events WHERE action_id = l3.id AND event = 'action.linked';
  PERFORM pg_temp.ok(pg_temp.states(r) = 'executed:-,executed:-,linked:-,proposed:-' AND (SELECT count(*) = 2 FROM agent_object_origins WHERE run_id = r), 'two objects created, one linked');

  -- Who may undo: the invoker, or an owner/admin of THIS organization (the backend passes the flag).
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_undo(a, u2, false, every)), 'a colleague cannot undo');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_undo(a, u2, NULL, every)), 'no admin flag is no admin');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_undo(b, u1, false, every)) AND NOT EXISTS (SELECT 1 FROM agent_claim_undo(b, u9, true, every)),
    'not through another organization, also not as that organization''s admin');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_undo(a, NULL, true, every)), 'an undo needs a person, admin flag or not');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_undo(a, u1, false, NULL)) AND NOT EXISTS (SELECT 1 FROM agent_claim_undo(a, u1, false, '{}'))
    AND NOT EXISTS (SELECT 1 FROM agent_claim_undo(a, u1, false, ARRAY[gen_random_uuid(), r])), 'no actions named: nothing');
  -- The 10 minutes are over (ROB-12 AC-3), for the invoker and for an admin.
  UPDATE agent_actions SET undo_until = now() WHERE run_id = r AND undo_until IS NOT NULL;
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_undo(a, u1, false, every)) AND NOT EXISTS (SELECT 1 FROM agent_claim_undo(a, u2, true, every)),
    'undo window passed: nothing, for the invoker and for an admin');
  UPDATE agent_actions SET undo_until = now() + interval '1 second' WHERE run_id = r AND undo_until IS NOT NULL;
  PERFORM pg_temp.ok(pg_temp.states(r) = 'executed:-,executed:-,linked:-,proposed:-' AND pg_temp.rev(r) = rev0
    AND (SELECT bool_and(exec_token IS NULL AND undone_by IS NULL) FROM agent_actions WHERE run_id = r), 'a refused undo changes nothing');

  -- The invoker undoes the first object. The open proposal named with it is not an undo candidate.
  SELECT array_agg(c.id) INTO got FROM agent_claim_undo(a, u1, false, ARRAY[e1.id, p4.id]) AS c;
  x := pg_temp.act(r, 1);
  PERFORM pg_temp.ok(got = ARRAY[e1.id] AND x.status = 'undoing' AND x.exec_token IS NOT NULL AND x.exec_started_at = now() AND x.undone_by = u1 AND x.undone_at IS NULL
    AND x.undo_until = now() + interval '1 second' AND x.executed_at = e1.executed_at, 'undo claimed: undoing, with a token, and who asked');
  PERFORM pg_temp.ok(pg_temp.act(r, 4) = p4 AND pg_temp.rev(r) = rev0 + 1 AND pg_temp.audits(r, 'action.undone') + pg_temp.audits(r, 'action.undo_blocked') = 0
    AND (SELECT count(*) = 2 FROM agent_object_origins WHERE run_id = r), 'the claim removes nothing and writes no audit row; a proposal is never claimed for undo');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_undo(a, u1, false, ARRAY[e1.id])) AND NOT EXISTS (SELECT 1 FROM agent_claim_undo(a, u2, true, ARRAY[e1.id])),
    'Undo pressed twice, or by an admin at the same time: the second claim gets nothing');
  PERFORM pg_temp.ok(pg_temp.act(r, 1) = x AND pg_temp.rev(r) = rev0 + 1, 'and changes nothing');

  -- An admin undoes the second object and the link (ROB-12 BR-5).
  SELECT array_agg(c.id) INTO got FROM agent_claim_undo(a, u2, true, ARRAY[e2.id, l3.id]) AS c;
  PERFORM pg_temp.ok(got = ARRAY[e2.id, l3.id] AND (SELECT bool_and(status = 'undoing' AND undone_by = u2 AND exec_token IS NOT NULL) AND count(DISTINCT exec_token) = 2
      FROM agent_actions WHERE run_id = r AND ordinal IN (2, 3)), 'undo by an admin: claimed in card order, each with its own token');

  -- Without the token nothing happens. An undo claim cannot be finished as a confirm, nor the other way round.
  PERFORM pg_temp.ok(agent_complete_undo(x.id, bogus, 'undone', NULL, NULL, u1) = '{"completed":false,"status":null}'::jsonb
    AND agent_complete_undo(x.id, (pg_temp.act(r, 2)).exec_token, 'undone', NULL, NULL, u1) = '{"completed":false,"status":null}'::jsonb
    AND agent_complete_undo(x.id, NULL, 'undone', NULL, NULL, u1) = '{"completed":false,"status":null}'::jsonb
    AND agent_complete_action(x.id, x.exec_token, 'executed', NULL, NULL, NULL) = '{"completed":false,"status":null}'::jsonb,
    'wrong token, no token, or the confirm function with an undo token: not completed');
  PERFORM pg_temp.expect_error(format(undo, x.id, x.exec_token, 'removed', NULL, u1), '22023');                       -- unknown outcome
  PERFORM pg_temp.expect_error(format(undo, x.id, x.exec_token, NULL, NULL, u1), '22023');
  PERFORM pg_temp.expect_error(format(undo, x.id, x.exec_token, 'blocked', NULL, u1), '22023');                       -- a blocked undo needs a reason
  PERFORM pg_temp.expect_error(format(undo, x.id, x.exec_token, 'blocked', 'Markus Huber commented', u1), '22023');   -- a sentence is not a code
  PERFORM pg_temp.ok(pg_temp.act(r, 1) = x AND (SELECT count(*) = 2 FROM agent_object_origins WHERE run_id = r), 'a refused outcome changes nothing');

  -- Blocked: a created object goes back to executed, with the reason; its origin row and its 10 minutes stay.
  res := agent_complete_undo(x.id, x.exec_token, 'blocked', 'has_comments', '{"count":1,"by":"Markus Huber"}', u1);
  y := pg_temp.act(r, 1);
  PERFORM pg_temp.ok(res = '{"completed":true,"status":"executed"}'::jsonb, format('blocked undo, got %s', res));
  PERFORM pg_temp.ok(y.status = 'executed' AND y.exec_token IS NULL AND y.reason = 'has_comments' AND y.reason_params = '{"count":1,"by":"Markus Huber"}'::jsonb
    AND y.undone_by IS NULL AND y.undone_at IS NULL AND y.undo_until = x.undo_until AND y.executed_at = e1.executed_at AND y.confirmed_by = u1,
    'blocked: executed again, the reason stored, nobody undid it');
  PERFORM pg_temp.ok((SELECT count(*) = 2 FROM agent_object_origins WHERE run_id = r), 'blocked: the origin row stays');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(e.actor_id = u1 AND e.organization_id = a AND e.conversation_id = g AND e.entity_id = e1.entity_id AND e.entity_type = 'task'
      AND e.data ->> 'reason' = 'has_comments' AND e.data ->> 'status' = 'executed' AND (e.data ->> 'ref_seq')::bigint = exec_seq AND e.data::text NOT LIKE '%Markus%')
    FROM agent_audit_events e WHERE e.action_id = e1.id AND e.event = 'action.undo_blocked'), 'audit: action.undo_blocked refers to the row that recorded the creation');
  -- Blocked: a linked action goes back to linked. Reported without an actor (a hanging claim finished by the sweep): the person who asked is used.
  x := pg_temp.act(r, 3);
  res := agent_complete_undo(x.id, x.exec_token, 'blocked', 'gone', NULL, NULL);
  y := pg_temp.act(r, 3);
  PERFORM pg_temp.ok(res = '{"completed":true,"status":"linked"}'::jsonb AND y.status = 'linked' AND y.reason = 'gone' AND y.linked_entity_id = target AND y.undone_by IS NULL,
    format('blocked undo of a link: linked again, got %s', res));
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(e.actor_id = u2 AND e.entity_id = target AND e.entity_type = 'task' AND (e.data ->> 'ref_seq')::bigint = link_seq)
    FROM agent_audit_events e WHERE e.action_id = l3.id AND e.event = 'action.undo_blocked'), 'audit: the blocked undo of a link names the linked object and who asked');

  -- Tried again and undone: who and when, and the origin row is gone (ROB-12 AC-1).
  SELECT * INTO x FROM agent_claim_undo(a, u1, false, ARRAY[e1.id]);
  PERFORM pg_temp.ok(x.status = 'undoing' AND x.reason IS NULL AND x.reason_params IS NULL, 'undo can be tried again inside the window; the old reason is cleared');
  rev0 := pg_temp.rev(r);
  res := agent_complete_undo(x.id, x.exec_token, 'undone', 'ignored_code', '{"ignored":1}', u1);
  y := pg_temp.act(r, 1);
  PERFORM pg_temp.ok(res = '{"completed":true,"status":"undone"}'::jsonb AND y.status = 'undone' AND y.undone_by = u1 AND y.undone_at = now() AND y.exec_token IS NULL
    AND y.reason IS NULL AND y.reason_params IS NULL, format('undone: by whom and when, got %s', res));
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_object_origins WHERE entity_id = e1.entity_id) AND EXISTS (SELECT 1 FROM agent_object_origins WHERE entity_id = e2.entity_id),
    'undone: the object''s origin row is removed, the other object keeps its row');
  PERFORM pg_temp.ok(pg_temp.rev(r) = rev0 + 1 AND (SELECT count(*) = 1 AND bool_and(e.actor_id = u1 AND e.entity_id = e1.entity_id AND e.data ->> 'status' = 'undone'
      AND (e.data ->> 'ref_seq')::bigint = exec_seq AND NOT e.data ? 'reason') FROM agent_audit_events e WHERE e.action_id = e1.id AND e.event = 'action.undone'),
    'undone: new rev, and audit action.undone refers to the creation');
  PERFORM pg_temp.ok(agent_complete_undo(x.id, x.exec_token, 'blocked', 'late', NULL, u1) = '{"completed":false,"status":null}'::jsonb AND pg_temp.act(r, 1) = y,
    'the same token a second time: nothing');
  -- The admin's undo of the second object, reported without an actor.
  x := pg_temp.act(r, 2);
  res := agent_complete_undo(x.id, x.exec_token, 'undone', NULL, NULL, NULL);
  PERFORM pg_temp.ok((res ->> 'completed')::boolean AND (pg_temp.act(r, 2)).undone_by = u2 AND NOT EXISTS (SELECT 1 FROM agent_object_origins WHERE run_id = r)
    AND (SELECT e.actor_id = u2 FROM agent_audit_events e WHERE e.action_id = e2.id AND e.event = 'action.undone'), 'undone by the admin: stored and audited in the admin''s name');
  -- The link is undone too.
  SELECT * INTO x FROM agent_claim_undo(a, u1, false, ARRAY[l3.id]);
  res := agent_complete_undo(x.id, x.exec_token, 'undone', NULL, NULL, u1);
  PERFORM pg_temp.ok(res = '{"completed":true,"status":"undone"}'::jsonb AND pg_temp.states(r) = 'undone:-,undone:-,undone:-,proposed:-', 'a link can be undone as well');
  -- What is undone stays undone.
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_undo(a, u1, true, every)) AND NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r, u1, pg_temp.versions(r, ARRAY[1, 2, 3]))),
    'an undone action can be neither undone nor confirmed again');
END $$;

-- ---------------------------------------------------------------- cancel (ROB-04 BR-4, ROB-02 BR-8, SEC-11 BR-2)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';   -- member of both organizations
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  u9 uuid := 'a9e00000-0000-4000-8000-000000000009';
  robert uuid := '0b3e7000-0000-4000-8000-000000000001';
  g uuid := pg_temp.conv('Agent IT main');
  gbb uuid := pg_temp.conv('Agent IT B');
  rd uuid := chat_get_or_create_agent_dm(a, u1, robert);
  r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid; r6 uuid; r7 uuid;
  ids uuid[]; t2 uuid; n int; rev0 bigint;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  -- Earlier blocks left open proposals behind; close them so that the counts below are exact.
  PERFORM agent_cancel_actions(a, 'test_cleanup', p_conversation_id => g);
  PERFORM agent_cancel_actions(a, 'test_cleanup', p_user_id => u1);

  -- Run 1 of u1: an open proposal, a failed action, one being created, one created.
  r1 := pg_temp.proposed(a, g, u1, 4);
  PERFORM pg_temp.confirm(r1, 2, 'failed', 'no_create_permission');
  PERFORM count(*) FROM agent_claim_actions(a, r1, u1, pg_temp.versions(r1, ARRAY[3]));
  PERFORM pg_temp.confirm(r1, 4);
  SELECT array_agg(x.id ORDER BY x.ordinal) INTO ids FROM agent_actions x WHERE x.run_id = r1;
  r2 := pg_temp.proposed(a, g, u1, 1);       -- another request of u1 in the same conversation
  r3 := pg_temp.proposed(a, g, u2, 2);       -- a colleague's request in the same conversation
  r4 := pg_temp.proposed(a, rd, u1, 1);      -- u1 in another conversation
  r5 := pg_temp.proposed(b, gbb, u1, 1);     -- u1 in another organization
  SELECT trigger_message_id INTO t2 FROM agent_runs WHERE id = r2;
  rev0 := pg_temp.rev(r1);

  -- A call must say what to cancel, and why.
  PERFORM pg_temp.expect_error(format('SELECT agent_cancel_actions(%L, %L)', a, 'user'), '22023');                                  -- no filter: never "everything"
  PERFORM pg_temp.expect_error(format('SELECT agent_cancel_actions(%L, %L, p_actor_id => %L)', a, 'user', u1), '22023');            -- the actor is not a filter
  PERFORM pg_temp.expect_error(format('SELECT agent_cancel_actions(%L, NULL, p_user_id => %L)', a, u1), '22023');                   -- no reason
  PERFORM pg_temp.expect_error(format('SELECT agent_cancel_actions(%L, %L, p_user_id => %L)', a, '', u1), '22023');
  PERFORM pg_temp.expect_error(format('SELECT agent_cancel_actions(%L, %L, p_user_id => %L)', a, 'Anna left the company', u1), '22023');  -- a sentence is not a code

  -- The invoker presses Cancel. Only the invoker can, and only inside the organization.
  PERFORM pg_temp.ok(agent_cancel_actions(a, 'user', p_action_ids => ids, p_actor_id => u2) = 0, 'a colleague cannot cancel');
  PERFORM pg_temp.ok(agent_cancel_actions(a, 'user', p_action_ids => ids) = 0, 'a user cancel needs the user');
  PERFORM pg_temp.ok(agent_cancel_actions(b, 'user', p_action_ids => ids, p_actor_id => u1) = 0, 'the invoker cannot cancel through another organization');
  PERFORM pg_temp.ok(agent_cancel_actions(a, 'user', p_action_ids => '{}', p_actor_id => u1) = 0, 'an empty list is a filter that matches nothing');
  PERFORM pg_temp.ok(pg_temp.states(r1) = 'proposed:-,failed:no_create_permission,executing:-,executed:-' AND pg_temp.rev(r1) = rev0
    AND pg_temp.audits(r1, 'action.cancelled') = 0, 'a refused cancel changes nothing');
  n := agent_cancel_actions(a, 'user', p_action_ids => ids, p_actor_id => u1);
  PERFORM pg_temp.ok(n = 2, format('user cancel: the two open actions of the four named, got %s', n));
  PERFORM pg_temp.ok(pg_temp.states(r1) = 'cancelled:user,cancelled:user,executing:-,executed:-' AND pg_temp.rev(r1) = rev0 + 1,
    'cancel closes proposed and failed actions; what is being created or was created stays; one new rev for the run');
  PERFORM pg_temp.ok((SELECT bool_and(reason_params IS NULL AND exec_token IS NULL) FROM agent_actions WHERE run_id = r1 AND status = 'cancelled')
    AND (SELECT count(*) = 2 AND bool_and(e.actor_id = u1 AND e.organization_id = a AND e.conversation_id = g AND e.entity_id = x.entity_id AND e.data = '{"reason":"user"}'::jsonb)
         FROM agent_audit_events e JOIN agent_actions x ON x.id = e.action_id WHERE e.run_id = r1 AND e.event = 'action.cancelled'),
    'audit: one action.cancelled row per cancelled action, with the reason and who cancelled');
  PERFORM pg_temp.ok(agent_cancel_actions(a, 'user', p_action_ids => ids, p_actor_id => u1) = 0 AND pg_temp.rev(r1) = rev0 + 1 AND pg_temp.audits(r1, 'action.cancelled') = 2,
    'cancelling twice changes nothing');
  PERFORM pg_temp.ok(pg_temp.states(r2) = 'proposed:-' AND pg_temp.states(r3) = 'proposed:-,proposed:-' AND pg_temp.states(r4) = 'proposed:-', 'only the named actions were cancelled');

  -- The request was deleted: everything still open from that request, nothing else (ROB-02 BR-8).
  PERFORM pg_temp.ok(agent_cancel_actions(b, 'request_deleted', p_trigger_message_id => t2, p_actor_id => u1) = 0 AND pg_temp.states(r2) = 'proposed:-', 'not through another organization');
  n := agent_cancel_actions(a, 'request_deleted', p_trigger_message_id => t2, p_actor_id => u1);
  PERFORM pg_temp.ok(n = 1 AND pg_temp.states(r2) = 'cancelled:request_deleted' AND pg_temp.states(r3) = 'proposed:-,proposed:-' AND pg_temp.states(r4) = 'proposed:-',
    'request deleted: the proposals of that request only');

  -- The filters combine with AND.
  r6 := pg_temp.proposed(a, g, u1, 2);
  PERFORM pg_temp.ok(agent_cancel_actions(a, 'requester_no_access', p_action_ids => ARRAY[(pg_temp.act(r3, 1)).id], p_user_id => u1) = 0
    AND agent_cancel_actions(a, 'requester_no_access', p_action_ids => ARRAY[(pg_temp.act(r3, 1)).id], p_conversation_id => rd) = 0
    AND agent_cancel_actions(a, 'requester_no_access', p_action_ids => ARRAY[(pg_temp.act(r3, 1)).id], p_trigger_message_id => t2) = 0
    AND agent_cancel_actions(a, 'requester_no_access', p_conversation_id => rd, p_user_id => u2) = 0
    AND agent_cancel_actions(a, 'requester_no_access', p_conversation_id => gbb, p_user_id => u1) = 0,
    'an action named together with somebody else''s user, conversation or request matches nothing');
  PERFORM pg_temp.ok(pg_temp.states(r3) = 'proposed:-,proposed:-' AND pg_temp.states(r4) = 'proposed:-' AND pg_temp.states(r5) = 'proposed:-' AND pg_temp.states(r6) = 'proposed:-,proposed:-',
    'and nothing was cancelled');

  -- A person was removed from a conversation: their open proposals there (SEC-11 BR-2). u2 removed u1.
  n := agent_cancel_actions(a, 'requester_no_access', p_conversation_id => g, p_user_id => u1, p_actor_id => u2);
  PERFORM pg_temp.ok(n = 2 AND pg_temp.states(r6) = 'cancelled:requester_no_access,cancelled:requester_no_access', format('removed from a conversation: their proposals there, got %s', n));
  PERFORM pg_temp.ok(pg_temp.states(r3) = 'proposed:-,proposed:-' AND pg_temp.states(r4) = 'proposed:-' AND pg_temp.states(r5) = 'proposed:-'
    AND pg_temp.states(r1) = 'cancelled:user,cancelled:user,executing:-,executed:-',
    'not the colleague''s proposals there, not their own elsewhere, and nothing that is being created or was created');
  PERFORM pg_temp.ok((SELECT count(*) = 2 AND bool_and(e.actor_id = u2 AND e.data ->> 'reason' = 'requester_no_access') FROM agent_audit_events e WHERE e.run_id = r6 AND e.event = 'action.cancelled'),
    'audit: the actor is who removed them');

  -- A person left the organization: everything they have open in THIS organization.
  r7 := pg_temp.proposed(a, g, u1, 1);
  n := agent_cancel_actions(a, 'requester_no_access', p_user_id => u1);
  PERFORM pg_temp.ok(n = 2 AND pg_temp.states(r4) = 'cancelled:requester_no_access' AND pg_temp.states(r7) = 'cancelled:requester_no_access',
    format('left the organization: all their open proposals in it, got %s', n));
  PERFORM pg_temp.ok(pg_temp.states(r5) = 'proposed:-' AND pg_temp.states(r3) = 'proposed:-,proposed:-', 'their proposals in the other organization and other people''s proposals stay');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(e.actor_id IS NULL AND e.conversation_id = rd) FROM agent_audit_events e WHERE e.run_id = r4 AND e.event = 'action.cancelled'),
    'audit: no actor when the system cancels');

  -- A conversation alone: everything open in it, whoever asked.
  n := agent_cancel_actions(a, 'conversation_closed', p_conversation_id => g);
  PERFORM pg_temp.ok(n = 2 AND pg_temp.states(r3) = 'cancelled:conversation_closed,cancelled:conversation_closed', format('by conversation: the colleague''s two proposals, got %s', n));

  -- The other organization, as itself.
  n := agent_cancel_actions(b, 'requester_no_access', p_user_id => u1, p_actor_id => u9);
  PERFORM pg_temp.ok(n = 1 AND pg_temp.states(r5) = 'cancelled:requester_no_access'
    AND (SELECT count(*) = 1 AND bool_and(e.organization_id = b AND e.actor_id = u9 AND e.conversation_id = gbb) FROM agent_audit_events e WHERE e.run_id = r5 AND e.event = 'action.cancelled'),
    'organization B cancels its own, audited in organization B');
END $$;

-- ---------------------------------------------------------------- sweep: expiry (ROB-04 BR-5, EC-A6)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u9 uuid := 'a9e00000-0000-4000-8000-000000000009';
  u6 uuid := 'a9e00000-0000-4000-8000-000000000006';   -- will leave the organization
  u7 uuid := 'a9e00000-0000-4000-8000-000000000007';   -- will be deleted
  g uuid := pg_temp.conv('Agent IT main');
  gbb uuid := pg_temp.conv('Agent IT B');
  gl uuid;
  r_old uuid; r_fresh uuid; r_left uuid; r_deleted uuid; r_b uuid;
  n int; rev0 bigint;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  -- Whatever is already due in this database goes first, so that the counts below are exact.
  PERFORM agent_expire_actions(1000000);
  PERFORM pg_temp.ok(agent_expire_actions(1000000) = 0, 'nothing is due before the checks start');

  INSERT INTO users (id, email, first_name) VALUES (u6, 'agent-it-u6@example.invalid', 'U6'), (u7, 'agent-it-u7@example.invalid', 'U7');
  -- u6 also belongs to organization B: leaving A must still close what u6 has open in A.
  INSERT INTO organization_members (organization_id, user_id, role) VALUES (a, u6, 'member'), (a, u7, 'member'), (b, u6, 'member');
  gl := chat_create_group(a, u6, 'Agent IT leavers', ARRAY[u7, u1]);

  -- Old run of u1: an open proposal, a failed action and one being created, all past their 24 hours.
  r_old := pg_temp.proposed(a, g, u1, 3);
  PERFORM pg_temp.confirm(r_old, 2, 'failed', 'attr_missing');
  PERFORM count(*) FROM agent_claim_actions(a, r_old, u1, pg_temp.versions(r_old, ARRAY[3]));
  UPDATE agent_actions SET expires_at = now() WHERE run_id = r_old;                           -- exactly now counts as expired
  r_b := pg_temp.proposed(b, gbb, u9, 1);
  UPDATE agent_actions SET expires_at = now() - interval '1 hour' WHERE run_id = r_b;         -- the oldest of all
  r_fresh := pg_temp.proposed(a, g, u1, 1);
  UPDATE agent_actions SET expires_at = now() + interval '1 second' WHERE run_id = r_fresh;   -- one second left
  r_left := pg_temp.proposed(a, gl, u6, 2);
  r_deleted := pg_temp.proposed(a, gl, u7, 1);
  rev0 := pg_temp.rev(r_old);

  -- No capacity asked for: nothing. Then one at a time, the oldest first.
  PERFORM pg_temp.ok(agent_expire_actions(0) = 0 AND agent_expire_actions(NULL) = 0 AND agent_expire_actions(-5) = 0, 'no limit, nothing expired');
  PERFORM pg_temp.ok(agent_expire_actions(1) = 1, 'p_limit caps the sweep');
  PERFORM pg_temp.ok(pg_temp.states(r_b) = 'expired:-' AND pg_temp.states(r_old) = 'proposed:-,failed:attr_missing,executing:-', 'the oldest proposal goes first');
  n := agent_expire_actions(1000);
  PERFORM pg_temp.ok(n = 1, format('the sweep expires the one open proposal that is due, got %s', n));
  PERFORM pg_temp.ok(pg_temp.states(r_old) = 'expired:-,failed:attr_missing,executing:-' AND pg_temp.rev(r_old) = rev0 + 1,
    'expired: only the proposal; a failed action and one that is being created are left alone; new rev');
  PERFORM pg_temp.ok(pg_temp.states(r_fresh) = 'proposed:-' AND pg_temp.states(r_left) = 'proposed:-,proposed:-' AND pg_temp.states(r_deleted) = 'proposed:-',
    'proposals inside their 24 hours whose invoker is a member stay');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(e.organization_id = a AND e.actor_id IS NULL AND e.conversation_id = g AND e.action_id = (pg_temp.act(r_old, 1)).id
      AND e.entity_id = (pg_temp.act(r_old, 1)).entity_id AND e.data ->> 'by' = 'sweep' AND (e.data ->> 'expires_at')::timestamptz = now() AND NOT e.data ? 'reason')
    FROM agent_audit_events e WHERE e.run_id = r_old AND e.event = 'action.expired')
    AND (SELECT count(*) = 1 AND bool_and(e.organization_id = b AND e.conversation_id = gbb) FROM agent_audit_events e WHERE e.run_id = r_b AND e.event = 'action.expired'),
    'audit: one action.expired row per proposal, in its own organization');
  -- An expired proposal is closed for good, also where the sweep has not been yet.
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, r_old, u1, pg_temp.versions(r_old)))
    AND agent_cancel_actions(a, 'user', p_action_ids => ARRAY[(pg_temp.act(r_old, 1)).id], p_actor_id => u1) = 0
    AND agent_patch_action(a, (pg_temp.act(r_old, 1)).id, u1, 1, '{}', '{}', NULL, NULL, false, NULL) = '{"updated":false,"version":1}'::jsonb,
    'expired: no confirm (also no retry of the failed action), no cancel, no edit');

  -- The invoker left the organization, or was deleted: their open proposals are cancelled (EC-A6).
  DELETE FROM organization_members WHERE organization_id = a AND user_id = u6;
  UPDATE space_members SET added_by = NULL WHERE added_by = u7;   -- pre-existing, not Robert (see "a person is deleted")
  DELETE FROM users WHERE id = u7;
  PERFORM pg_temp.ok((SELECT invoker_id = u6 FROM agent_runs WHERE id = r_left) AND (SELECT invoker_id IS NULL FROM agent_runs WHERE id = r_deleted), 'one invoker left, one was deleted');
  rev0 := pg_temp.rev(r_left);
  n := agent_expire_actions(1000);
  PERFORM pg_temp.ok(n = 3, format('the sweep cancels the three proposals of people who are gone, got %s', n));
  PERFORM pg_temp.ok(pg_temp.states(r_left) = 'cancelled:requester_no_access,cancelled:requester_no_access' AND pg_temp.states(r_deleted) = 'cancelled:requester_no_access'
    AND pg_temp.states(r_fresh) = 'proposed:-' AND pg_temp.rev(r_left) = rev0 + 1, 'invoker gone: cancelled with requester_no_access; a member''s proposal stays');
  PERFORM pg_temp.ok((SELECT count(*) = 3 AND bool_and(e.organization_id = a AND e.actor_id IS NULL AND e.conversation_id = gl AND e.data ->> 'reason' = 'requester_no_access' AND e.data ->> 'by' = 'sweep')
    FROM agent_audit_events e WHERE e.run_id IN (r_left, r_deleted) AND e.event = 'action.cancelled'), 'audit: action.cancelled by the sweep');
  PERFORM pg_temp.ok(agent_expire_actions(1000) = 0, 'a second sweep finds nothing');
END $$;

-- ---------------------------------------------------------------- sweep: hanging claims
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u9 uuid := 'a9e00000-0000-4000-8000-000000000009';
  g uuid := pg_temp.conv('Agent IT main');
  gbb uuid := pg_temp.conv('Agent IT B');
  r uuid; rb uuid; rev0 bigint; audits bigint;
  x1 agent_actions; x2 agent_actions; x3 agent_actions; x4 agent_actions; xb agent_actions; y1 agent_actions; y3 agent_actions; yb agent_actions;
  got uuid[]; res jsonb;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  -- Whatever hangs in this database already goes first.
  PERFORM count(*) FROM agent_reclaim_stuck_actions(1000000);

  -- Three confirms and one undo are in flight in A, one confirm in B; the fifth proposal is still open.
  r := pg_temp.proposed(a, g, u1, 5);
  PERFORM pg_temp.confirm(r, 3);
  PERFORM count(*) FROM agent_claim_actions(a, r, u1, pg_temp.versions(r, ARRAY[1, 2, 4]));
  PERFORM count(*) FROM agent_claim_undo(a, u1, false, ARRAY[(pg_temp.act(r, 3)).id]);
  rb := pg_temp.proposed(b, gbb, u9, 1);
  PERFORM count(*) FROM agent_claim_actions(b, rb, u9, pg_temp.versions(rb));
  UPDATE agent_actions SET exec_started_at = now() - interval '4 minutes' WHERE run_id = r AND ordinal = 1;     -- hangs
  UPDATE agent_actions SET exec_started_at = now() - interval '2 minutes' WHERE run_id = r AND ordinal = 2;     -- still working
  UPDATE agent_actions SET exec_started_at = now() - interval '5 minutes' WHERE run_id = r AND ordinal = 3;     -- an undo that hangs
  UPDATE agent_actions SET exec_started_at = now() - interval '3 minutes' WHERE run_id = r AND ordinal = 4;     -- exactly 3 minutes: not yet
  UPDATE agent_actions SET exec_started_at = now() - interval '10 minutes' WHERE run_id = rb;                   -- the oldest of all
  x1 := pg_temp.act(r, 1); x2 := pg_temp.act(r, 2); x3 := pg_temp.act(r, 3); x4 := pg_temp.act(r, 4); xb := pg_temp.act(rb, 1);
  rev0 := pg_temp.rev(r);
  SELECT count(*) INTO audits FROM agent_audit_events WHERE run_id IN (r, rb);

  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_reclaim_stuck_actions(0)) AND NOT EXISTS (SELECT 1 FROM agent_reclaim_stuck_actions(NULL)), 'no limit, nothing handed out');
  SELECT array_agg(c.id) INTO got FROM agent_reclaim_stuck_actions(1) AS c;
  PERFORM pg_temp.ok(got = ARRAY[xb.id], 'p_limit caps the sweep; the claim that hangs longest goes first');
  SELECT array_agg(c.id ORDER BY c.ordinal) INTO got FROM agent_reclaim_stuck_actions(1000) AS c WHERE c.organization_id IN (a, b);
  PERFORM pg_temp.ok(got = ARRAY[x1.id, x3.id], format('the sweep hands out the confirm and the undo that hang for more than 3 minutes, got %s', got));
  y1 := pg_temp.act(r, 1); y3 := pg_temp.act(r, 3); yb := pg_temp.act(rb, 1);
  PERFORM pg_temp.ok(y1.status = 'executing' AND y1.exec_token IS NOT NULL AND y1.exec_token <> x1.exec_token AND y1.exec_started_at = now() AND y1.attempts = x1.attempts
    AND y1.confirmed_by = u1 AND y1.version = x1.version AND y1.entity_id = x1.entity_id, 'a hanging confirm: still executing, new token, new start time, nothing else changed');
  PERFORM pg_temp.ok(y3.status = 'undoing' AND y3.exec_token <> x3.exec_token AND y3.exec_started_at = now() AND y3.undone_by = u1 AND y3.undo_until = x3.undo_until,
    'a hanging undo: still undoing, new token, and still who asked');
  PERFORM pg_temp.ok(pg_temp.act(r, 2) = x2 AND pg_temp.act(r, 4) = x4 AND (pg_temp.act(r, 5)).status = 'proposed', 'claims of up to 3 minutes and open proposals are left alone');
  PERFORM pg_temp.ok(pg_temp.rev(r) = rev0 + 1 AND (SELECT count(*) FROM agent_audit_events WHERE run_id IN (r, rb)) = audits,
    'the run gets a new rev; no status changed, so there is no audit row');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_reclaim_stuck_actions(1000) AS c WHERE c.organization_id IN (a, b)), 'a second sweep finds nothing');

  -- The instance that hung comes back: its token is dead. The new holder reconciles.
  PERFORM pg_temp.ok(agent_complete_action(x1.id, x1.exec_token, 'executed', NULL, NULL, NULL) = '{"completed":false,"status":null}'::jsonb
    AND agent_complete_undo(x3.id, x3.exec_token, 'undone', NULL, NULL, u1) = '{"completed":false,"status":null}'::jsonb
    AND agent_complete_action(xb.id, xb.exec_token, 'failed', 'failed', NULL, NULL) = '{"completed":false,"status":null}'::jsonb
    AND pg_temp.act(r, 1) = y1 AND pg_temp.act(r, 3) = y3 AND pg_temp.act(rb, 1) = yb, 'the old tokens open nothing any more');
  res := agent_complete_action(y1.id, y1.exec_token, 'executed', NULL, NULL, '{"reconciled":true}');
  PERFORM pg_temp.ok(res = '{"completed":true,"status":"executed"}'::jsonb AND EXISTS (SELECT 1 FROM agent_object_origins WHERE entity_id = y1.entity_id),
    'the object exists: the new token reports executed and the origin row is written');
  res := agent_complete_undo(y3.id, y3.exec_token, 'undone', NULL, NULL, NULL);
  PERFORM pg_temp.ok(res = '{"completed":true,"status":"undone"}'::jsonb AND (pg_temp.act(r, 3)).undone_by = u1, 'the object is gone: the new token reports undone, in the name of who asked');
  res := agent_complete_action(yb.id, yb.exec_token, 'failed', 'interrupted', NULL, NULL);
  PERFORM pg_temp.ok(res = '{"completed":true,"status":"failed"}'::jsonb AND (SELECT e.organization_id = b FROM agent_audit_events e WHERE e.action_id = yb.id AND e.event = 'action.failed'),
    'the object does not exist: failed as interrupted, audited in its own organization');
END $$;

-- ---------------------------------------------------------------- actions: two organizations never mix (EC-A5)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';   -- member of both, asks Robert in both
  g uuid := pg_temp.conv('Agent IT main');
  gbb uuid := pg_temp.conv('Agent IT B');
  target uuid := gen_random_uuid();
  ra uuid; rb uuid; ta uuid; tb uuid;
  a1 agent_actions; b1 agent_actions; a2 agent_actions; b2 agent_actions; a3 agent_actions; b3 agent_actions;
  got uuid[]; rev_a bigint; rev_b bigint; n int;
BEGIN
  PERFORM pg_temp.quiesce();
  ra := pg_temp.proposed(a, g, u1, 3);
  rb := pg_temp.proposed(b, gbb, u1, 3);
  SELECT trigger_message_id INTO ta FROM agent_runs WHERE id = ra;
  SELECT trigger_message_id INTO tb FROM agent_runs WHERE id = rb;
  PERFORM pg_temp.confirm(ra, 2);
  PERFORM pg_temp.confirm(rb, 2);
  a1 := pg_temp.act(ra, 1); b1 := pg_temp.act(rb, 1); a2 := pg_temp.act(ra, 2); b2 := pg_temp.act(rb, 2);
  rev_a := pg_temp.rev(ra); rev_b := pg_temp.rev(rb);

  -- agent_patch_action, agent_link_action: an action of the other organization does not exist.
  PERFORM pg_temp.expect_error(format('SELECT agent_patch_action(%L, %L, %L, 1, ''{}'', ''{}'', NULL, NULL, true, NULL)', b, a1.id, u1), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT agent_patch_action(%L, %L, %L, 1, ''{}'', ''{}'', NULL, NULL, true, NULL)', a, b1.id, u1), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT agent_link_action(%L, %L, %L, 1, ''task'', %L, NULL, true)', b, a1.id, u1, target), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT agent_link_action(%L, %L, %L, 1, ''task'', %L, NULL, true)', a, b1.id, u1, target), 'P0002');
  -- agent_claim_actions: the run must be the organization's, and so must every action named.
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_actions(b, ra, u1, pg_temp.versions(ra))) AND NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, rb, u1, pg_temp.versions(rb)))
    AND NOT EXISTS (SELECT 1 FROM agent_claim_actions(a, ra, u1, pg_temp.versions(rb))) AND NOT EXISTS (SELECT 1 FROM agent_claim_actions(b, rb, u1, pg_temp.versions(ra))),
    'agent_claim_actions: a run or an action of the other organization is never claimed');
  -- agent_claim_undo: also not with the admin flag.
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_claim_undo(b, u1, true, ARRAY[a2.id])) AND NOT EXISTS (SELECT 1 FROM agent_claim_undo(a, u1, true, ARRAY[b2.id])),
    'agent_claim_undo: an admin of one organization cannot undo in the other');
  -- agent_cancel_actions: every filter stays inside the organization named in the call.
  PERFORM pg_temp.ok(agent_cancel_actions(b, 'user', p_action_ids => ARRAY[a1.id], p_actor_id => u1) = 0
    AND agent_cancel_actions(a, 'user', p_action_ids => ARRAY[b1.id], p_actor_id => u1) = 0
    AND agent_cancel_actions(a, 'request_deleted', p_trigger_message_id => tb) = 0 AND agent_cancel_actions(b, 'request_deleted', p_trigger_message_id => ta) = 0
    AND agent_cancel_actions(a, 'requester_no_access', p_conversation_id => gbb) = 0 AND agent_cancel_actions(b, 'requester_no_access', p_conversation_id => g, p_user_id => u1) = 0,
    'agent_cancel_actions: ids, request and conversation of the other organization match nothing');
  PERFORM pg_temp.ok(pg_temp.act(ra, 1) = a1 AND pg_temp.act(rb, 1) = b1 AND pg_temp.act(ra, 2) = a2 AND pg_temp.act(rb, 2) = b2
    AND pg_temp.rev(ra) = rev_a AND pg_temp.rev(rb) = rev_b
    AND (SELECT visibility = 'conversation' FROM agent_runs WHERE id = ra) AND (SELECT visibility = 'conversation' FROM agent_runs WHERE id = rb), 'both runs and their actions are untouched');

  -- A list that mixes both organizations: only the own actions are handled.
  SELECT array_agg(c.id) INTO got FROM agent_claim_undo(a, u1, false, ARRAY[a2.id, b2.id]) AS c;
  PERFORM pg_temp.ok(got = ARRAY[a2.id] AND pg_temp.act(rb, 2) = b2, 'agent_claim_undo: of a mixed list only the own organization''s action');
  n := agent_cancel_actions(b, 'user', p_action_ids => ARRAY[a1.id, b1.id], p_actor_id => u1);
  PERFORM pg_temp.ok(n = 1 AND pg_temp.act(ra, 1) = a1 AND (pg_temp.act(rb, 1)).status = 'cancelled',
    'agent_cancel_actions: of a mixed list only the own organization''s action');

  -- agent_complete_action, agent_complete_undo take no organization: a token opens its own action only.
  PERFORM count(*) FROM agent_claim_actions(a, ra, u1, pg_temp.versions(ra, ARRAY[3]));
  PERFORM count(*) FROM agent_claim_actions(b, rb, u1, pg_temp.versions(rb, ARRAY[3]));
  a2 := pg_temp.act(ra, 2); a3 := pg_temp.act(ra, 3); b3 := pg_temp.act(rb, 3);
  PERFORM pg_temp.ok(agent_complete_action(a3.id, b3.exec_token, 'executed', NULL, NULL, NULL) = '{"completed":false,"status":null}'::jsonb
    AND agent_complete_action(b3.id, a3.exec_token, 'executed', NULL, NULL, NULL) = '{"completed":false,"status":null}'::jsonb
    AND agent_complete_undo(a2.id, b3.exec_token, 'undone', NULL, NULL, u1) = '{"completed":false,"status":null}'::jsonb
    AND pg_temp.act(ra, 3) = a3 AND pg_temp.act(rb, 3) = b3 AND pg_temp.act(ra, 2) = a2, 'a token of the other organization completes nothing and reveals nothing');

  -- What an action writes stays in its own organization.
  PERFORM agent_complete_action(b3.id, b3.exec_token, 'executed', NULL, NULL, NULL);
  PERFORM agent_complete_undo(a2.id, a2.exec_token, 'blocked', 'has_comments', NULL, u1);
  PERFORM pg_temp.ok((SELECT count(*) = 2 AND bool_and(o.organization_id = b) FROM agent_object_origins o WHERE o.run_id = rb)
    AND (SELECT count(*) = 1 AND bool_and(o.organization_id = a) FROM agent_object_origins o WHERE o.run_id = ra), 'origin rows stay in the organization of the action');
  PERFORM pg_temp.ok((SELECT count(*) > 5 AND bool_and(e.organization_id = b) FROM agent_audit_events e WHERE e.run_id = rb)
    AND (SELECT count(*) > 5 AND bool_and(e.organization_id = a) FROM agent_audit_events e WHERE e.run_id = ra), 'audit rows stay in the organization of the action');
  -- agent_expire_actions and agent_reclaim_stuck_actions take no ids; the two blocks above show that
  -- each row is closed, handed out and audited in its own organization.
END $$;

-- ---------------------------------------------------------------- actions as the backend's role
SET LOCAL ROLE service_role;
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  robert uuid := '0b3e7000-0000-4000-8000-000000000001';
  rd uuid; r uuid; r2 uuid; x agent_actions; y agent_actions; n int; res jsonb;
BEGIN
  PERFORM pg_temp.ok(current_user = 'service_role', 'this block runs as service_role');
  PERFORM pg_temp.quiesce();
  rd := chat_get_or_create_agent_dm(a, u2, robert);
  r := pg_temp.proposed(a, rd, u2, 5, 'invoker');

  -- All nine functions, once, as the backend calls them.
  PERFORM pg_temp.ok((agent_patch_action(a, (pg_temp.act(r, 1)).id, u2, 1, '{"title":"x"}', '{"confirmable":true}', NULL, '{"spaces":[],"refs":[]}', false, '{"fields":["title"]}') ->> 'updated')::boolean,
    'service_role: edit');
  PERFORM pg_temp.ok((SELECT count(*) = 3 FROM agent_claim_actions(a, r, u2, pg_temp.versions(r, ARRAY[1, 2, 3]))), 'service_role: confirm');
  x := pg_temp.act(r, 1);
  res := agent_complete_action(x.id, x.exec_token, 'executed', NULL, NULL, '{}');
  PERFORM pg_temp.ok(res ->> 'status' = 'executed' AND EXISTS (SELECT 1 FROM agent_object_origins WHERE entity_id = x.entity_id), 'service_role: executed, with the origin row');
  x := pg_temp.act(r, 2);
  PERFORM pg_temp.ok(agent_complete_action(x.id, x.exec_token, 'failed', 'no_create_permission', '{"space":"x"}', NULL) ->> 'status' = 'failed', 'service_role: failed');
  x := pg_temp.act(r, 3);
  PERFORM pg_temp.ok(agent_complete_action(x.id, x.exec_token, 'released', NULL, NULL, NULL) ->> 'status' = 'proposed', 'service_role: released');
  PERFORM pg_temp.ok((agent_link_action(a, (pg_temp.act(r, 4)).id, u2, 1, 'task', gen_random_uuid(), '{"spaces":[],"refs":[]}', true) ->> 'linked')::boolean, 'service_role: link');
  PERFORM pg_temp.ok((SELECT count(*) = 2 FROM agent_claim_undo(a, u2, false, ARRAY[(pg_temp.act(r, 1)).id, (pg_temp.act(r, 4)).id])), 'service_role: undo');
  x := pg_temp.act(r, 1); y := pg_temp.act(r, 4);
  res := agent_complete_undo(x.id, x.exec_token, 'undone', NULL, NULL, u2);
  PERFORM pg_temp.ok(res ->> 'status' = 'undone' AND NOT EXISTS (SELECT 1 FROM agent_object_origins WHERE entity_id = x.entity_id), 'service_role: undone, origin row removed');
  PERFORM pg_temp.ok(agent_complete_undo(y.id, y.exec_token, 'blocked', 'gone', NULL, u2) ->> 'status' = 'linked', 'service_role: undo blocked');
  PERFORM pg_temp.ok(agent_cancel_actions(a, 'user', p_action_ids => ARRAY[(pg_temp.act(r, 2)).id, (pg_temp.act(r, 5)).id], p_actor_id => u2) = 2, 'service_role: cancel');
  UPDATE agent_actions SET expires_at = now() - interval '1 second' WHERE run_id = r AND ordinal = 3;
  n := agent_expire_actions(1000);
  PERFORM pg_temp.ok(n = 1 AND pg_temp.states(r) = 'undone:-,cancelled:user,expired:-,linked:gone,cancelled:user', format('service_role: expiry sweep, got %s', n));
  r2 := pg_temp.proposed(a, rd, u2, 1, 'invoker');
  PERFORM count(*) FROM agent_claim_actions(a, r2, u2, pg_temp.versions(r2));
  UPDATE agent_actions SET exec_started_at = now() - interval '1 hour' WHERE run_id = r2;
  PERFORM pg_temp.ok((SELECT count(*) = 1 FROM agent_reclaim_stuck_actions(1000) AS c WHERE c.run_id = r2), 'service_role: hanging claims');
END $$;
RESET ROLE;

-- ---------------------------------------------------------------- actions: what the audit trail holds (SEC-05)
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
BEGIN
  PERFORM pg_temp.ok((SELECT array_agg(DISTINCT event COLLATE "C" ORDER BY event COLLATE "C") FROM agent_audit_events WHERE organization_id IN (a, b) AND event LIKE 'action.%')
    = ARRAY['action.cancelled', 'action.confirmed', 'action.edited', 'action.executed', 'action.expired', 'action.failed', 'action.linked', 'action.undo_blocked', 'action.undone'],
    'the action functions write the nine agreed action events, and no other');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_audit_events WHERE organization_id IN (a, b) AND event LIKE 'action.%' AND (run_id IS NULL OR action_id IS NULL OR conversation_id IS NULL)),
    'every action event names its run, its action and its conversation');
  -- Ids, codes, numbers and dates only: nothing the invoker typed, no reason parameters, no names.
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_audit_events WHERE organization_id IN (a, b)
    AND (data::text LIKE '%Geheimer Titel%' OR data::text LIKE '%Standort%' OR data::text LIKE '%Markus%' OR data::text LIKE '%AGIT1%' OR data::text LIKE '%zu spaet%')),
    'audit data holds no edited value and no reason parameter');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_audit_events WHERE organization_id IN (a, b) AND event LIKE 'action.%' AND data ? 'reason' AND data ->> 'reason' !~ '^[a-z][a-z0-9_]{0,63}$'),
    'every reason in the audit trail is a code');
  PERFORM pg_temp.ok((SELECT bool_and(x.in_order) FROM (
      SELECT occurred_at >= lag(occurred_at, 1, occurred_at) OVER (ORDER BY seq) AS in_order FROM agent_audit_events WHERE organization_id IN (a, b)) AS x),
    'audit rows carry the real time of each event, in seq order');
END $$;

-- ---------------------------------------------------------------- a person is deleted
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  u5 uuid := 'a9e00000-0000-4000-8000-000000000005';
  g uuid;
  r_done uuid; r_live uuid; lease uuid; fin jsonb; audits bigint;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  INSERT INTO users (id, email, first_name) VALUES (u5, 'agent-it-u5@example.invalid', 'U5');
  INSERT INTO organization_members (organization_id, user_id, role) VALUES (a, u5, 'member');
  g := chat_create_group(a, u5, 'Agent IT leaver', ARRAY['a9e00000-0000-4000-8000-000000000002']::uuid[]);
  r_done := (pg_temp.start(a, pg_temp.say(a, g, u5), u5) ->> 'run_id')::uuid;
  PERFORM pg_temp.finish(r_done, 'completed', pg_temp.actions(1));
  r_live := (pg_temp.start(a, pg_temp.say(a, g, u5), u5) ->> 'run_id')::uuid;
  SELECT lease_token INTO lease FROM agent_runs WHERE id = r_live;
  PERFORM agent_record_model_call(r_live, lease, 20, 10, NULL, true, NULL, NULL);
  SELECT count(*) INTO audits FROM agent_audit_events WHERE organization_id = a AND actor_id = u5;

  -- Pre-existing, not Robert: space_members.added_by has no ON DELETE action (see chat-core.integration.sql).
  UPDATE space_members SET added_by = NULL WHERE added_by = u5;
  DELETE FROM users WHERE id = u5;

  PERFORM pg_temp.ok((SELECT count(*) = 2 AND bool_and(invoker_id IS NULL) FROM agent_runs WHERE id IN (r_done, r_live))
    AND (SELECT count(*) = 1 FROM agent_actions WHERE run_id = r_done), 'deleting a person keeps their runs and proposals, without the invoker');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_audit_events WHERE organization_id = a AND actor_id = u5) = audits AND audits > 0,
    'deleting a person does not touch the audit trail (no cascading UPDATE reaches it)');
  -- A run whose invoker is gone can still be finished: nobody is charged or logged against.
  fin := agent_finalize_run(r_live, lease, 'completed', NULL, 'invoker', '{"provider":"openai"}', pg_temp.actions(1), NULL);
  PERFORM pg_temp.ok((fin ->> 'finalized')::boolean AND fin ->> 'status' = 'completed'
    AND NOT EXISTS (SELECT 1 FROM ai_usage_logs l WHERE l.operation_type = 'robert_run' AND (l.metadata ->> 'run_id')::uuid = r_live)
    AND (SELECT count(*) = 1 AND bool_and(e.actor_id IS NULL) FROM agent_audit_events e WHERE e.run_id = r_live AND e.event = 'run.completed'),
    format('a run without an invoker is finished without a usage row, got %s', fin));
END $$;

-- ---------------------------------------------------------------- space deletion drains runs with their messages
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  u2 uuid := 'a9e00000-0000-4000-8000-000000000002';
  s1 uuid := 'a9e00000-0000-4000-8000-0000000000e1';
  ch uuid := chat_get_or_create_space_channel(a, s1);
  root uuid; t_thread uuid; t_top uuid; t_refused uuid;
  r_thread uuid; r_top uuid; r_refused uuid; act uuid;
  audits bigint; counters bigint; batches int := 0; n int;
BEGIN
  PERFORM pg_temp.quiesce();
  PERFORM pg_temp.settings(a);
  -- In the channel: a live run inside a thread, a finished run with proposals, a refused run.
  root := pg_temp.say(a, ch, u2);
  t_thread := pg_temp.say(a, ch, u1, root);
  t_top := pg_temp.say(a, ch, u1);
  t_refused := pg_temp.say(a, ch, u1);
  r_thread := (pg_temp.start(a, t_thread, u1) ->> 'run_id')::uuid;
  r_top := (pg_temp.start(a, t_top, u1) ->> 'run_id')::uuid;
  PERFORM pg_temp.finish(r_top, 'completed', pg_temp.actions(3));
  r_refused := (pg_temp.start(a, t_refused, u1, p_refusal => 'no_permission') ->> 'run_id')::uuid;
  -- One proposal is being created right now, and an object created earlier carries its origin row.
  SELECT id INTO act FROM agent_actions WHERE run_id = r_top AND ordinal = 1;
  UPDATE agent_actions SET status = 'executing', exec_token = gen_random_uuid(), exec_started_at = now() WHERE id = act;
  INSERT INTO agent_object_origins (organization_id, entity_type, entity_id, action_id, run_id, conversation_id, trigger_message_id, source_message_ids, invoker_id, confirmer_id)
  VALUES (a, 'task', gen_random_uuid(), act, r_top, ch, t_top, ARRAY[root], u1, u1);
  SELECT count(*) INTO audits FROM agent_audit_events WHERE organization_id = a;
  SELECT count(*) INTO counters FROM agent_usage_counters WHERE organization_id = a;
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_runs WHERE conversation_id = ch) = 3 AND (SELECT count(*) FROM agent_actions WHERE run_id = r_top) = 3
    AND (SELECT count(*) FROM chat_messages WHERE conversation_id = ch AND kind = 'agent') = 2 AND audits > 0 AND counters > 0,
    'before the drain: three runs, three proposals, two Robert messages, audit rows and counters');

  UPDATE spaces SET is_archived = true WHERE id = s1;
  PERFORM delete_space_cascade(a, s1, u1);
  LOOP
    n := delete_space_rows_batch(s1, 1);   -- one row per batch: a run goes with whichever of its two messages is removed first
    EXIT WHEN n = 0;
    batches := batches + 1;
    PERFORM pg_temp.ok(batches < 100, 'drain terminates');
  END LOOP;
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_messages WHERE conversation_id = ch), 'all channel messages drained, Robert''s included');
  PERFORM pg_temp.ok(batches = 6, format('one message per batch: 4 typed + 2 from Robert = 6, got %s', batches));
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_runs WHERE id IN (r_thread, r_top, r_refused))
    AND NOT EXISTS (SELECT 1 FROM agent_actions WHERE run_id IN (r_thread, r_top, r_refused)), 'runs and proposals went with their messages');
  PERFORM pg_temp.ok(finalize_space_deletion(s1), 'space finalized');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_conversations WHERE id = ch) AND NOT EXISTS (SELECT 1 FROM spaces WHERE id = s1), 'channel removed with the space');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_audit_events WHERE organization_id = a) = audits
    AND (SELECT count(*) FROM agent_audit_events WHERE run_id IN (r_thread, r_top, r_refused)) >= 7, 'the audit trail of the deleted runs is still complete');
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(conversation_id = ch AND confirmer_id = u1) FROM agent_object_origins WHERE organization_id = a AND run_id = r_top),
    'the "created by Robert" label outlives its conversation');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_usage_counters WHERE organization_id = a) = counters, 'usage counters are untouched by the drain');
END $$;

-- ---------------------------------------------------------------- organization deletion cascades
DO $$
DECLARE
  a uuid := 'a9e00000-0000-4000-8000-00000000000a';
  b uuid := 'a9e00000-0000-4000-8000-00000000000b';
  u1 uuid := 'a9e00000-0000-4000-8000-000000000001';
  g uuid := pg_temp.conv('Agent IT main');
  b_runs bigint; b_audits bigint; b_counters bigint; b_messages bigint;
BEGIN
  -- Organization A holds every kind of row at this point: runs in all six states, proposals,
  -- audit rows, counters of two months, an origin row, settings, Robert conversations.
  PERFORM pg_temp.start(a, pg_temp.say(a, g, u1), u1);
  PERFORM pg_temp.start(a, pg_temp.say(a, g, u1), u1, p_max_running => 0);
  PERFORM pg_temp.ok((SELECT array_agg(DISTINCT status ORDER BY status) FROM agent_runs WHERE organization_id = a)
    = ARRAY['cancelled', 'completed', 'failed', 'queued', 'refused', 'running'], 'organization A has runs in all six states');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM agent_actions WHERE organization_id = a) AND EXISTS (SELECT 1 FROM agent_audit_events WHERE organization_id = a)
    AND (SELECT count(DISTINCT period_start) >= 2 FROM agent_usage_counters WHERE organization_id = a AND scope = 'org_month')
    AND EXISTS (SELECT 1 FROM agent_object_origins WHERE organization_id = a) AND EXISTS (SELECT 1 FROM agent_settings WHERE organization_id = a)
    AND EXISTS (SELECT 1 FROM ai_usage_logs WHERE organization_id = a AND operation_type = 'robert_run'), 'and every other kind of Robert row');
  SELECT count(*) INTO b_runs FROM agent_runs WHERE organization_id = b;
  SELECT count(*) INTO b_audits FROM agent_audit_events WHERE organization_id = b;
  SELECT count(*) INTO b_counters FROM agent_usage_counters WHERE organization_id = b;
  SELECT count(*) INTO b_messages FROM chat_messages WHERE organization_id = b AND kind = 'agent';

  PERFORM delete_organization(a);

  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM organizations WHERE id = a), 'the organization is gone');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_runs WHERE organization_id = a) AND NOT EXISTS (SELECT 1 FROM agent_actions WHERE organization_id = a),
    'org deletion removes runs and proposals');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_audit_events WHERE organization_id = a), 'org deletion removes the audit trail (the only delete it ever sees)');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM agent_usage_counters WHERE organization_id = a) AND NOT EXISTS (SELECT 1 FROM agent_object_origins WHERE organization_id = a)
    AND NOT EXISTS (SELECT 1 FROM agent_settings WHERE organization_id = a), 'org deletion removes counters, origin rows and settings');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_messages WHERE organization_id = a) AND NOT EXISTS (SELECT 1 FROM chat_conversations WHERE organization_id = a),
    'org deletion removes the conversations, Robert''s messages included');
  PERFORM pg_temp.ok(b_runs > 0 AND b_audits > 0 AND b_counters > 0 AND b_messages > 0
    AND (SELECT count(*) FROM agent_runs WHERE organization_id = b) = b_runs AND (SELECT count(*) FROM agent_audit_events WHERE organization_id = b) = b_audits
    AND (SELECT count(*) FROM agent_usage_counters WHERE organization_id = b) = b_counters
    AND (SELECT count(*) FROM chat_messages WHERE organization_id = b AND kind = 'agent') = b_messages, 'organization B keeps everything');
END $$;

\echo chat-agent integration: all checks passed
ROLLBACK;
