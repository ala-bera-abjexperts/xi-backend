-- XE-T353 Robert: database integration checks for the object helper functions
-- (agent_find_members, agent_space_labels, agent_find_similar, agent_undo_blockers,
-- agent_undo_task).
-- Run only against a confirmed disposable database (local Supabase or the xisuite-infra harness)
-- with migrations 20261014130000 and 20261014130200 applied. Everything is rolled back. It
-- creates its own two organizations, users, spaces and objects, so it needs no parameters:
--   psql -f test/chat-agent-objects.integration.sql
-- Success prints "chat-agent objects integration: all checks passed"; any failure aborts with
-- the reason.
--
-- Two limits decide what can be checked here. The script is ONE session in ONE transaction, so
-- now() is frozen: the one time rule (automation runs count from the object's creation or from
-- p_since, whichever is earlier) is checked by backdating rows. And nothing here can race. Left
-- for scripts/robert-verify.mjs, as parallel calls on committed rows:
--   * agent_undo_task against a comment, a subtask, a re-parented older task or a time entry
--     written at the same moment: the writer is either reported as a blocker or fails on the
--     foreign key after the delete; never a deleted task with a surviving dependant.
--   * two Undos of two tasks of one run at once (parent and subtask, two siblings): no
--     deadlock, each task deleted once.
--   * agent_undo_task against the product's own delete of the same task: one wins, the other
--     gets "not found".
--   * agent_undo_task against a workflow transition of the same task (both lock the task row).
--   * the known gap: a file or a task relationship added in the same milliseconds (those tables
--     have no foreign key to tasks).
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

-- The codes of a blocker list in their order, e.g. 'changed_by_other,has_comments'.
CREATE FUNCTION pg_temp.codes(p_blockers jsonb) RETURNS text
LANGUAGE sql AS $$
  SELECT coalesce(string_agg(e.item ->> 'code', ',' ORDER BY e.ord), '')
  FROM jsonb_array_elements(p_blockers) WITH ORDINALITY AS e (item, ord);
$$;

-- One entry of a blocker list.
CREATE FUNCTION pg_temp.entry(p_blockers jsonb, p_code text) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT e.item FROM jsonb_array_elements(p_blockers) AS e (item) WHERE e.item ->> 'code' = p_code;
$$;

-- A finished run of p_user in p_conv: request message, Robert's empty message and the run row.
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

-- Marks p_entity as the object an executed action of p_run created.
CREATE FUNCTION pg_temp.own(p_run uuid, p_kind text, p_entity uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO agent_actions (organization_id, run_id, ordinal, kind, status, intent, entity_type, entity_id, executed_at, expires_at)
  SELECT r.organization_id, r.id,
         (SELECT coalesce(max(a.ordinal), 0) + 1 FROM agent_actions a WHERE a.run_id = r.id),
         p_kind, 'executed', '{}'::jsonb,
         CASE WHEN p_kind IN ('wiki_page', 'asset_object') THEN p_kind ELSE 'task' END,
         p_entity, now(), now() + interval '24 hours'
  FROM agent_runs r WHERE r.id = p_run;
$$;

-- A task as the product creates it: creator and "last edited by" are the same person.
CREATE FUNCTION pg_temp.task(p_org uuid, p_space uuid, p_summary text, p_creator uuid, p_parent uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO tasks (id, organization_id, space_id, task_type_id, summary, parent_task_id, created_by, updated_by)
  VALUES (v_id, p_org, p_space, 'task', p_summary, p_parent, p_creator, p_creator);
  RETURN v_id;
END $$;

CREATE FUNCTION pg_temp.page(p_org uuid, p_space uuid, p_title text, p_creator uuid, p_parent uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO wiki_pages (id, organization_id, space_id, title, slug, content, parent_id, created_by, updated_by)
  VALUES (v_id, p_org, p_space, p_title, 'agent-obj-it-' || v_id, '<p>text</p>', p_parent, p_creator, p_creator);
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------- fixtures
-- Org A: u1 owner (the invoker and the person pressing Undo), u2..u7 and u10 members.
-- Org B: u9 owner.  s1, s2 = spaces of A, s9 = space of B.
INSERT INTO organizations (id, name, slug, size) VALUES
  ('ab0b0000-0000-4000-8000-00000000000a', 'Agent Obj IT A', 'agent-obj-it-a', '1-10'),
  ('ab0b0000-0000-4000-8000-00000000000b', 'Agent Obj IT B', 'agent-obj-it-b', '1-10');
INSERT INTO users (id, email, first_name, last_name, is_active) VALUES
  ('ab0b0000-0000-4000-8000-000000000001', 'agent-obj-it-u1@example.invalid', 'Anna', 'Berger', true),
  ('ab0b0000-0000-4000-8000-000000000002', 'agent-obj-it-u2@example.invalid', 'Anna', 'Moser', NULL),
  ('ab0b0000-0000-4000-8000-000000000003', 'agent-obj-it-u3@example.invalid', 'Annabel', 'Lee', true),
  ('ab0b0000-0000-4000-8000-000000000004', 'agent-obj-it-u4@example.invalid', ' Markus ', 'Müller', true),
  ('ab0b0000-0000-4000-8000-000000000005', 'agent-obj-it-u5@example.invalid', 'Anna', 'Inaktiv', false),
  ('ab0b0000-0000-4000-8000-000000000006', 'agent-obj-it-u6@example.invalid', 'Jörg', 'Annaheim', true),
  ('ab0b0000-0000-4000-8000-000000000007', 'agent-obj-it-u7@example.invalid', 'Michael', NULL, true),
  ('ab0b0000-0000-4000-8000-000000000008', 'agent-obj-it-u8@example.invalid', 'Anna', 'Nirgends', true),
  ('ab0b0000-0000-4000-8000-000000000009', 'agent-obj-it-u9@example.invalid', 'Anna', 'Fremd', true),
  ('ab0b0000-0000-4000-8000-000000000010', 'agent-obj-it-u10@example.invalid', 'Adam', 'Annaberg', true);
-- u8 is a user but a member of no organization.
INSERT INTO organization_members (organization_id, user_id, role) VALUES
  ('ab0b0000-0000-4000-8000-00000000000a', 'ab0b0000-0000-4000-8000-000000000001', 'owner'),
  ('ab0b0000-0000-4000-8000-00000000000a', 'ab0b0000-0000-4000-8000-000000000002', 'member'),
  ('ab0b0000-0000-4000-8000-00000000000a', 'ab0b0000-0000-4000-8000-000000000003', 'member'),
  ('ab0b0000-0000-4000-8000-00000000000a', 'ab0b0000-0000-4000-8000-000000000004', 'member'),
  ('ab0b0000-0000-4000-8000-00000000000a', 'ab0b0000-0000-4000-8000-000000000005', 'member'),
  ('ab0b0000-0000-4000-8000-00000000000a', 'ab0b0000-0000-4000-8000-000000000006', 'member'),
  ('ab0b0000-0000-4000-8000-00000000000a', 'ab0b0000-0000-4000-8000-000000000007', 'viewer'),
  ('ab0b0000-0000-4000-8000-00000000000a', 'ab0b0000-0000-4000-8000-000000000010', 'member'),
  ('ab0b0000-0000-4000-8000-00000000000b', 'ab0b0000-0000-4000-8000-000000000009', 'owner');
INSERT INTO spaces (id, organization_id, name, key) VALUES
  ('ab0b0000-0000-4000-8000-0000000000e1', 'ab0b0000-0000-4000-8000-00000000000a', 'Agent Obj IT Space', 'AGOBJ1'),
  ('ab0b0000-0000-4000-8000-0000000000e2', 'ab0b0000-0000-4000-8000-00000000000a', 'Agent Obj IT Second', 'AGOBJ2'),
  ('ab0b0000-0000-4000-8000-0000000000e9', 'ab0b0000-0000-4000-8000-00000000000b', 'Agent Obj IT B Space', 'AGOBJ9');

-- ---------------------------------------------------------------- grants and wiring
DO $$
DECLARE
  v_fn regprocedure;
  v_count int := 0;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('agent_find_members', 'agent_space_labels', 'agent_find_similar', 'agent_undo_blockers', 'agent_undo_task')
  LOOP
    v_count := v_count + 1;
    PERFORM pg_temp.ok(NOT has_function_privilege('anon', v_fn, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
      AND NOT has_function_privilege('public', v_fn, 'EXECUTE')
      AND has_function_privilege('service_role', v_fn, 'EXECUTE'), v_fn::text || ' is executable by service_role only');
    PERFORM pg_temp.ok((SELECT NOT p.prosecdef AND 'search_path=pg_catalog, public' = ANY (p.proconfig) FROM pg_proc p WHERE p.oid = v_fn),
      v_fn::text || ' is SECURITY INVOKER with a pinned search_path');
  END LOOP;
  PERFORM pg_temp.ok(v_count = 5, 'exactly the five object helper functions exist (no overloads)');
  PERFORM pg_temp.ok((SELECT bool_and(p.provolatile = 's') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('agent_find_members', 'agent_space_labels', 'agent_find_similar', 'agent_undo_blockers')), 'the four read helpers are STABLE');
  PERFORM pg_temp.ok((SELECT p.provolatile = 'v' FROM pg_proc p WHERE p.oid = 'public.agent_undo_task(uuid,uuid,uuid,timestamptz,uuid)'::regprocedure),
    'agent_undo_task is VOLATILE');
END $$;

-- ---------------------------------------------------------------- agent_find_members (ROB-10)
DO $$
DECLARE
  a uuid := 'ab0b0000-0000-4000-8000-00000000000a';
  b uuid := 'ab0b0000-0000-4000-8000-00000000000b';
  u1 uuid := 'ab0b0000-0000-4000-8000-000000000001';
  u2 uuid := 'ab0b0000-0000-4000-8000-000000000002';
  u3 uuid := 'ab0b0000-0000-4000-8000-000000000003';
  u4 uuid := 'ab0b0000-0000-4000-8000-000000000004';
  u6 uuid := 'ab0b0000-0000-4000-8000-000000000006';
  u7 uuid := 'ab0b0000-0000-4000-8000-000000000007';
  u9 uuid := 'ab0b0000-0000-4000-8000-000000000009';
  u10 uuid := 'ab0b0000-0000-4000-8000-000000000010';
  r record;
BEGIN
  -- "Anna": the two people whose first name it is come first (exact), then the people whose
  -- full or last name only begins with it, although "Adam Annaberg" sorts before both Annas by
  -- name. The inactive Anna, the Anna of organization B and the Anna without any membership are
  -- not found.
  PERFORM pg_temp.ok((SELECT array_agg(f.user_id ORDER BY f.ordinality) FROM agent_find_members(a, 'anna') WITH ORDINALITY f)
    = ARRAY[u1, u2, u10, u3, u6], 'find_members: exact first names first, then prefixes, by name');
  PERFORM pg_temp.ok((SELECT array_agg(f.exact ORDER BY f.ordinality) FROM agent_find_members(a, 'anna') WITH ORDINALITY f) = ARRAY[true, true, false, false, false],
    'find_members: exact flag only for a full-name or first-name match');
  SELECT * INTO r FROM agent_find_members(a, 'anna') f WHERE f.user_id = u1;
  PERFORM pg_temp.ok(r.full_name = 'Anna Berger' AND r.email = 'agent-obj-it-u1@example.invalid' AND r.avatar_url IS NULL,
    'find_members: returns name, email and avatar');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_members(a, 'anna', 1)) = 1
    AND (SELECT bool_and(f.exact) FROM agent_find_members(a, 'anna', 1) f), 'find_members: the limit keeps the exact matches');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_members(a, 'anna', 0)) = 1
    AND (SELECT count(*) FROM agent_find_members(a, 'anna', NULL)) = 5 AND (SELECT count(*) FROM agent_find_members(a, 'a', 1000)) <= 50,
    'find_members: limit is clamped, NULL = default');

  -- Full name, any case, extra blanks.
  PERFORM pg_temp.ok((SELECT array_agg(f.user_id) FROM agent_find_members(a, '  ANNA   berger ') f) = ARRAY[u1]
    AND (SELECT bool_and(f.exact) FROM agent_find_members(a, '  ANNA   berger ') f), 'find_members: full name, case and blanks ignored');
  PERFORM pg_temp.ok((SELECT array_agg(f.user_id) FROM agent_find_members(a, 'Anna B') f) = ARRAY[u1]
    AND (SELECT NOT bool_or(f.exact) FROM agent_find_members(a, 'Anna B') f), 'find_members: beginning of a full name is a prefix match');

  -- Accents: "muller" and "MÜLLER" find Müller by last name (a prefix match), "markus" is exact
  -- although the stored first name has blanks around it.
  PERFORM pg_temp.ok((SELECT array_agg(f.user_id) FROM agent_find_members(a, 'muller') f) = ARRAY[u4]
    AND (SELECT array_agg(f.user_id) FROM agent_find_members(a, 'MÜLLER') f) = ARRAY[u4]
    AND (SELECT NOT bool_or(f.exact) FROM agent_find_members(a, 'muller') f), 'find_members: accents ignored, last name is a prefix match');
  SELECT * INTO r FROM agent_find_members(a, 'markus') f;
  PERFORM pg_temp.ok(r.user_id = u4 AND r.exact AND r.full_name = 'Markus Müller', 'find_members: first name exact, shown name trimmed');
  PERFORM pg_temp.ok((SELECT array_agg(f.user_id) FROM agent_find_members(a, 'jorg') f) = ARRAY[u6], 'find_members: "jorg" finds Jörg');
  -- A person without a last name: the first name is also the full name.
  SELECT * INTO r FROM agent_find_members(a, 'michael') f;
  PERFORM pg_temp.ok(r.user_id = u7 AND r.exact AND r.full_name = 'Michael', 'find_members: first name only');

  -- Nothing for an empty name, an unknown name, or text that would be a wildcard in LIKE.
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_members(a, '')) = 0 AND (SELECT count(*) FROM agent_find_members(a, '   ')) = 0
    AND (SELECT count(*) FROM agent_find_members(a, NULL)) = 0, 'find_members: empty name finds nobody');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_members(a, 'zzz')) = 0 AND (SELECT count(*) FROM agent_find_members(a, '%')) = 0
    AND (SELECT count(*) FROM agent_find_members(a, 'ann_')) = 0, 'find_members: unknown names and wildcards find nobody');
  -- A name in the middle is not a match ("Berger" is a last name, "erger" is nothing).
  PERFORM pg_temp.ok((SELECT array_agg(f.user_id) FROM agent_find_members(a, 'berger') f) = ARRAY[u1]
    AND (SELECT count(*) FROM agent_find_members(a, 'erger')) = 0, 'find_members: beginning of a name only');

  -- Cross-organization: B sees only its own Anna, A never sees her, an unknown organization
  -- sees nobody.
  PERFORM pg_temp.ok((SELECT array_agg(f.user_id) FROM agent_find_members(b, 'anna') f) = ARRAY[u9], 'find_members: organization B finds only its own member');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_members(b, 'markus')) = 0 AND (SELECT count(*) FROM agent_find_members(a, 'fremd')) = 0,
    'find_members: no member of another organization');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_members(gen_random_uuid(), 'anna')) = 0 AND (SELECT count(*) FROM agent_find_members(NULL, 'anna')) = 0,
    'find_members: unknown or missing organization finds nobody');

  -- Switching the account off removes the person; switching it on brings them back.
  UPDATE users SET is_active = false WHERE id = u2;
  PERFORM pg_temp.ok((SELECT array_agg(f.user_id ORDER BY f.ordinality) FROM agent_find_members(a, 'anna') WITH ORDINALITY f) = ARRAY[u1, u10, u3, u6], 'find_members: a switched-off account is not found');
  UPDATE users SET is_active = true WHERE id = u2;
END $$;

-- ---------------------------------------------------------------- agent_space_labels
DO $$
DECLARE
  a uuid := 'ab0b0000-0000-4000-8000-00000000000a';
  b uuid := 'ab0b0000-0000-4000-8000-00000000000b';
  u1 uuid := 'ab0b0000-0000-4000-8000-000000000001';
  u9 uuid := 'ab0b0000-0000-4000-8000-000000000009';
  s1 uuid := 'ab0b0000-0000-4000-8000-0000000000e1';
  s2 uuid := 'ab0b0000-0000-4000-8000-0000000000e2';
  s9 uuid := 'ab0b0000-0000-4000-8000-0000000000e9';
  t uuid;
BEGIN
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_space_labels(a, s1)) = 0, 'space_labels: a space without tasks has no labels');
  t := pg_temp.task(a, s1, 'Label task one', u1);
  UPDATE tasks SET labels = '["billing", "regression"]' WHERE id = t;
  t := pg_temp.task(a, s1, 'Label task two', u1);
  UPDATE tasks SET labels = '["regression", "ISO9001 ", "  "]' WHERE id = t;
  t := pg_temp.task(a, s1, 'Label task three', u1);
  UPDATE tasks SET labels = '["regression", "billing"]' WHERE id = t;
  t := pg_temp.task(a, s1, 'Label task four', u1);
  UPDATE tasks SET labels = '"not a list"' WHERE id = t;
  t := pg_temp.task(a, s2, 'Label task other space', u1);
  UPDATE tasks SET labels = '["other-space"]' WHERE id = t;
  t := pg_temp.task(b, s9, 'Label task other org', u9);
  UPDATE tasks SET labels = '["secret-b"]' WHERE id = t;

  PERFORM pg_temp.ok((SELECT array_agg(l.label) FROM agent_space_labels(a, s1) l) = ARRAY['regression', 'billing', 'ISO9001 '],
    'space_labels: distinct labels as stored, most used first, blank ones and non-lists skipped');
  PERFORM pg_temp.ok((SELECT array_agg(l.label) FROM agent_space_labels(a, s1, 1) l) = ARRAY['regression'], 'space_labels: limit');
  PERFORM pg_temp.ok((SELECT array_agg(l.label) FROM agent_space_labels(a, s2) l) = ARRAY['other-space'], 'space_labels: only this space');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_space_labels(b, s1)) = 0 AND (SELECT count(*) FROM agent_space_labels(a, s9)) = 0,
    'space_labels: a space of another organization gives nothing');
  PERFORM pg_temp.ok((SELECT array_agg(l.label) FROM agent_space_labels(b, s9) l) = ARRAY['secret-b'], 'space_labels: organization B reads its own');
END $$;

-- ---------------------------------------------------------------- agent_find_similar (ROB-11)
DO $$
DECLARE
  a uuid := 'ab0b0000-0000-4000-8000-00000000000a';
  b uuid := 'ab0b0000-0000-4000-8000-00000000000b';
  u1 uuid := 'ab0b0000-0000-4000-8000-000000000001';
  u9 uuid := 'ab0b0000-0000-4000-8000-000000000009';
  s1 uuid := 'ab0b0000-0000-4000-8000-0000000000e1';
  s2 uuid := 'ab0b0000-0000-4000-8000-0000000000e2';
  s9 uuid := 'ab0b0000-0000-4000-8000-0000000000e9';
  t_sso uuid; t_done uuid; t_completed uuid; t_other uuid; t_s2 uuid; t_b uuid; t_plan uuid;
  st uuid := gen_random_uuid();
  plan1 uuid := gen_random_uuid(); plan2 uuid := gen_random_uuid(); plan_b uuid := gen_random_uuid();
  w_root uuid; w_child uuid; w_archived uuid; w_s2 uuid; w_b uuid;
  schema1 uuid := gen_random_uuid(); type1 uuid := gen_random_uuid(); type2 uuid := gen_random_uuid();
  schema_b uuid := gen_random_uuid(); type_b uuid := gen_random_uuid();
  o_mac uuid := gen_random_uuid(); o_dell uuid := gen_random_uuid(); o_type2 uuid := gen_random_uuid();
  o_archived uuid := gen_random_uuid(); o_b uuid := gen_random_uuid();
  v_threshold text := current_setting('pg_trgm.similarity_threshold');
  r record;
BEGIN
  -- Tasks. The requirement's own example: "Fix SSO login" exists, Robert proposes
  -- "Fix the SSO login bug".
  t_sso := pg_temp.task(a, s1, 'Fix SSO login', u1);
  t_done := pg_temp.task(a, s1, 'Fix SSO login page', u1);
  UPDATE tasks SET status = 'done' WHERE id = t_done;
  INSERT INTO task_statuses (id, organization_id, name, key, color, is_completed) VALUES (st, a, 'Erledigt', 'agent-obj-it-erledigt', '#00aa00', true);
  t_completed := pg_temp.task(a, s1, 'Fix SSO login bug now', u1);
  UPDATE tasks SET status_id = st WHERE id = t_completed;
  t_other := pg_temp.task(a, s1, 'Quarterly budget review', u1);
  t_s2 := pg_temp.task(a, s2, 'Fix SSO login for partners', u1);
  t_b := pg_temp.task(b, s9, 'Fix SSO login', u9);

  SELECT * INTO r FROM agent_find_similar(a, 'task', ARRAY[s1], 'Fix the SSO login bug');
  PERFORM pg_temp.ok((SELECT array_agg(f.entity_id) FROM agent_find_similar(a, 'task', ARRAY[s1], 'Fix the SSO login bug') f) = ARRAY[t_sso],
    'find_similar: finds the near title, not the different one, not the completed ones');
  PERFORM pg_temp.ok(r.space_id = s1 AND r.score >= 0.45 AND r.score < 1 AND NOT r.exact, 'find_similar: returns space, score and exact = false for a task');
  PERFORM pg_temp.ok((SELECT f.score FROM agent_find_similar(a, 'task', ARRAY[s1], 'fix sso LOGIN') f WHERE f.entity_id = t_sso) = 1,
    'find_similar: the same title in another case scores 1');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[s1], 'Quarterly budget review')) = 1
    AND (SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[s1], 'Order new office chairs')) = 0, 'find_similar: a different title finds nothing');

  -- p_space_ids is the boundary.
  PERFORM pg_temp.ok((SELECT array_agg(f.entity_id ORDER BY f.entity_id) FROM agent_find_similar(a, 'task', ARRAY[s1, s2], 'Fix SSO login') f)
    = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[t_sso, t_s2]) x), 'find_similar: both spaces when both are passed');
  PERFORM pg_temp.ok((SELECT array_agg(f.entity_id) FROM agent_find_similar(a, 'task', ARRAY[s2], 'Fix SSO login') f) = ARRAY[t_s2],
    'find_similar: only the spaces in p_space_ids');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[]::uuid[], 'Fix SSO login')) = 0
    AND (SELECT count(*) FROM agent_find_similar(a, 'task', NULL, 'Fix SSO login')) = 0, 'find_similar: no space, no result');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[s1], '')) = 0
    AND (SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[s1], NULL)) = 0, 'find_similar: no title, no result');

  -- Cross-organization: B's identical task is never found from A, and A's never from B.
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[s9], 'Fix SSO login')) = 0
    AND (SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[s1, s9], 'Fix SSO login') f WHERE f.entity_id = t_b) = 0,
    'find_similar: a space of another organization gives nothing');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(b, 'task', ARRAY[s1, s2], 'Fix SSO login')) = 0
    AND (SELECT array_agg(f.entity_id) FROM agent_find_similar(b, 'task', ARRAY[s9], 'Fix SSO login') f) = ARRAY[t_b],
    'find_similar: organization B finds only its own task');

  -- p_min and p_limit.
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[s1], 'Fix the SSO login bug', NULL, NULL, 0.99)) = 0
    AND (SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[s1, s2], 'Fix SSO login', NULL, NULL, 0.45, 1)) = 1
    AND (SELECT f.entity_id FROM agent_find_similar(a, 'task', ARRAY[s1, s2], 'Fix SSO login', NULL, NULL, 0.45, 1) f) = t_sso,
    'find_similar: p_min raises the bar, p_limit keeps the best');
  -- "Quarterly report" is 0.41 like "Quarterly budget review": below the default bar of 0.45,
  -- above the database's own 0.3.
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[s1], 'Quarterly report')) = 0
    AND (SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[s1], 'Quarterly report', NULL, NULL, NULL)) = 0
    AND (SELECT array_agg(f.entity_id) FROM agent_find_similar(a, 'task', ARRAY[s1], 'Quarterly report', NULL, NULL, 0.3) f) = ARRAY[t_other]
    AND (SELECT array_agg(f.entity_id) FROM agent_find_similar(a, 'task', ARRAY[s1], 'Quarterly report', NULL, NULL, 0.01) f) = ARRAY[t_other],
    'find_similar: default bar is 0.45 (also for NULL); a lower p_min lets a weaker match in');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[s1, s2], 'Fix SSO login', NULL, NULL, 0.45, 0)) = 1
    AND (SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[s1, s2], 'Fix SSO login', NULL, NULL, 0.45, NULL)) = 2, 'find_similar: limit is clamped, NULL = default');
  -- Reopening the done task brings it back.
  UPDATE tasks SET status = 'open' WHERE id = t_done;
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[s1], 'Fix SSO login page') f WHERE f.entity_id = t_done) = 1,
    'find_similar: an open task is found again');
  UPDATE tasks SET status = 'closed' WHERE id = t_done;
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'task', ARRAY[s1], 'Fix SSO login page') f WHERE f.entity_id = t_done) = 0,
    'find_similar: a closed task is not found');

  -- Plan items: only tasks that are items of the given plan.
  INSERT INTO plans (id, organization_id, space_id, name) VALUES (plan1, a, s1, 'Agent Obj Plan 1'), (plan2, a, s1, 'Agent Obj Plan 2'), (plan_b, b, s9, 'Agent Obj Plan B');
  t_plan := pg_temp.task(a, s1, 'Fix SSO login rollout', u1);
  INSERT INTO plan_tasks (plan_id, task_id) VALUES (plan1, t_plan);
  PERFORM pg_temp.ok((SELECT array_agg(f.entity_id) FROM agent_find_similar(a, 'plan_item', ARRAY[s1], 'Fix SSO login', plan1) f) = ARRAY[t_plan],
    'find_similar: plan item = tasks of that plan only');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'plan_item', ARRAY[s1], 'Fix SSO login', plan2)) = 0
    AND (SELECT count(*) FROM agent_find_similar(a, 'plan_item', ARRAY[s1], 'Fix SSO login', NULL)) = 0
    AND (SELECT count(*) FROM agent_find_similar(b, 'plan_item', ARRAY[s1], 'Fix SSO login', plan1)) = 0
    AND (SELECT count(*) FROM agent_find_similar(a, 'plan_item', ARRAY[s2], 'Fix SSO login', plan1)) = 0,
    'find_similar: another plan, no plan, another organization or another space find no plan item');
  -- A link row that ties this task to a plan of organization B must not make B's plan usable.
  INSERT INTO plan_tasks (plan_id, task_id) VALUES (plan_b, t_plan);
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'plan_item', ARRAY[s1], 'Fix SSO login', plan_b)) = 0,
    'find_similar: a plan of another organization finds nothing, whatever is linked to it');

  -- Wiki pages: same parent only, never archived.
  w_root := pg_temp.page(a, s1, 'Onboarding Handbuch', u1);
  w_child := pg_temp.page(a, s1, 'Onboarding Handbuch IT', u1, w_root);
  w_archived := pg_temp.page(a, s1, 'Onboarding Handbuch alt', u1);
  UPDATE wiki_pages SET is_archived = true WHERE id = w_archived;
  w_s2 := pg_temp.page(a, s2, 'Onboarding Handbuch', u1);
  w_b := pg_temp.page(b, s9, 'Onboarding Handbuch', u9);
  PERFORM pg_temp.ok((SELECT array_agg(f.entity_id) FROM agent_find_similar(a, 'wiki_page', ARRAY[s1], 'Onboarding-Handbuch') f) = ARRAY[w_root],
    'find_similar: top-level page with a near title, not the archived one, not the child');
  PERFORM pg_temp.ok((SELECT array_agg(f.entity_id) FROM agent_find_similar(a, 'wiki_page', ARRAY[s1], 'Onboarding Handbuch', w_root) f) = ARRAY[w_child],
    'find_similar: pages under the given parent');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'wiki_page', ARRAY[s1], 'Onboarding Handbuch IT')) = 1
    AND (SELECT count(*) FROM agent_find_similar(a, 'wiki_page', ARRAY[s1], 'Onboarding Handbuch IT', NULL, NULL, 0.99)) = 0,
    'find_similar: p_min applies to wiki pages');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'wiki_page', ARRAY[s9], 'Onboarding Handbuch')) = 0
    AND (SELECT count(*) FROM agent_find_similar(b, 'wiki_page', ARRAY[s1, s2], 'Onboarding Handbuch')) = 0
    AND (SELECT array_agg(f.entity_id) FROM agent_find_similar(a, 'wiki_page', ARRAY[s2], 'Onboarding Handbuch') f) = ARRAY[w_s2],
    'find_similar: wiki pages respect organization and spaces');

  -- Assets: by name inside one asset type, and by identifier.
  INSERT INTO asset_object_schemas (id, organization_id, space_id, name, object_key) VALUES (schema1, a, s1, 'Agent Obj Hardware', 'AOH'), (schema_b, b, s9, 'Agent Obj Hardware B', 'AOHB');
  INSERT INTO asset_object_types (id, organization_id, space_id, schema_id, name) VALUES
    (type1, a, s1, schema1, 'Laptop'), (type2, a, s1, schema1, 'Phone'), (type_b, b, s9, schema_b, 'Laptop');
  INSERT INTO asset_objects (id, organization_id, space_id, schema_id, object_type_id, name, attribute_values, is_archived) VALUES
    (o_mac, a, s1, schema1, type1, 'MacBook Pro Lukas', '{"serial_number": "C02XYZ", "model": "M4"}', false),
    (o_dell, a, s1, schema1, type1, 'Dell Latitude 5550', '{"serial_number": "DL-77"}', false),
    (o_type2, a, s1, schema1, type2, 'MacBook Pro Lukas', '{"serial_number": "C02XYZ"}', false),
    (o_archived, a, s1, schema1, type1, 'MacBook Pro Lukas (alt)', '{"serial_number": "C02XYZ"}', true),
    (o_b, b, s9, schema_b, type_b, 'MacBook Pro Lukas', '{"serial_number": "C02XYZ"}', false);

  SELECT * INTO r FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'Lukas MacBook Pro', type1);
  PERFORM pg_temp.ok((SELECT array_agg(f.entity_id) FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'Lukas MacBook Pro', type1) f) = ARRAY[o_mac]
    AND NOT r.exact AND r.score >= 0.45, 'find_similar: asset with a near name in the same type, not archived, exact = false');
  -- A completely different name, but the same serial number: found, and flagged exact.
  SELECT * INTO r FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'Neues Notebook', type1, '{"serial_number": "C02XYZ"}');
  PERFORM pg_temp.ok((SELECT array_agg(f.entity_id) FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'Neues Notebook', type1, '{"serial_number": "C02XYZ"}') f) = ARRAY[o_mac]
    AND r.exact AND r.score < 0.45, 'find_similar: an identifier match is found and flagged exact whatever the name');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'asset_object', ARRAY[s1], NULL, type1, '{"serial_number": "C02XYZ"}') f WHERE f.exact) = 1,
    'find_similar: identifiers work without a title');
  -- The exact one first, then the similar name.
  UPDATE asset_objects SET name = 'Neues Notebook Lukas' WHERE id = o_dell;
  PERFORM pg_temp.ok((SELECT array_agg(f.entity_id ORDER BY f.ordinality) FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'Neues Notebook Lukas', type1, '{"serial_number": "C02XYZ"}') WITH ORDINALITY f)
    = ARRAY[o_mac, o_dell], 'find_similar: exact identifier match is listed before a similar name');
  PERFORM pg_temp.ok((SELECT array_agg(f.exact ORDER BY f.ordinality) FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'Neues Notebook Lukas', type1, '{"serial_number": "C02XYZ"}') WITH ORDINALITY f) = ARRAY[true, false],
    'find_similar: exact only for the identifier match');
  -- Every pair of p_identifiers must be on the object; values are compared as stored.
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'x', type1, '{"serial_number": "C02XYZ", "model": "M4"}')) = 1
    AND (SELECT count(*) FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'x', type1, '{"serial_number": "C02XYZ", "model": "M1"}')) = 0
    AND (SELECT count(*) FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'x', type1, '{"serial_number": "c02xyz"}')) = 0
    AND (SELECT count(*) FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'x', type1, '{"serial_number": "NOPE"}')) = 0,
    'find_similar: all identifier pairs must match, as stored');
  -- An empty identifier object or a non-object must not match every asset.
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'x', type1, '{}')) = 0
    AND (SELECT count(*) FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'x', type1, '[]')) = 0
    AND (SELECT count(*) FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'x', type1, 'null')) = 0,
    'find_similar: empty identifiers match nothing');
  -- Another type, no type, another space, another organization.
  PERFORM pg_temp.ok((SELECT array_agg(f.entity_id) FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'MacBook Pro Lukas', type2, '{"serial_number": "C02XYZ"}') f) = ARRAY[o_type2]
    AND (SELECT count(*) FROM agent_find_similar(a, 'asset_object', ARRAY[s1], 'MacBook Pro Lukas', NULL, '{"serial_number": "C02XYZ"}')) = 0
    AND (SELECT count(*) FROM agent_find_similar(a, 'asset_object', ARRAY[s2], 'MacBook Pro Lukas', type1, '{"serial_number": "C02XYZ"}')) = 0,
    'find_similar: assets only of the given type and spaces');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_find_similar(a, 'asset_object', ARRAY[s1, s9], 'MacBook Pro Lukas', type_b, '{"serial_number": "C02XYZ"}')) = 0
    AND (SELECT count(*) FROM agent_find_similar(b, 'asset_object', ARRAY[s1], 'MacBook Pro Lukas', type1, '{"serial_number": "C02XYZ"}')) = 0
    AND (SELECT array_agg(f.entity_id) FROM agent_find_similar(b, 'asset_object', ARRAY[s9], 'MacBook Pro Lukas', type_b) f) = ARRAY[o_b],
    'find_similar: assets never cross the organization');

  PERFORM pg_temp.expect_error(format('SELECT * FROM agent_find_similar(%L, %L, ARRAY[%L]::uuid[], %L)', a, 'plan', s1, 'x'), '22023');
  PERFORM pg_temp.expect_error(format('SELECT * FROM agent_find_similar(%L, NULL, ARRAY[%L]::uuid[], %L)', a, s1, 'x'), '22023');
  PERFORM pg_temp.ok(current_setting('pg_trgm.similarity_threshold') = v_threshold, 'find_similar: the session similarity threshold is untouched');
END $$;

-- ---------------------------------------------------------------- agent_undo_blockers: tasks (ROB-12)
DO $$
DECLARE
  a uuid := 'ab0b0000-0000-4000-8000-00000000000a';
  b uuid := 'ab0b0000-0000-4000-8000-00000000000b';
  u1 uuid := 'ab0b0000-0000-4000-8000-000000000001';
  u2 uuid := 'ab0b0000-0000-4000-8000-000000000002';
  u3 uuid := 'ab0b0000-0000-4000-8000-000000000003';
  u9 uuid := 'ab0b0000-0000-4000-8000-000000000009';
  s1 uuid := 'ab0b0000-0000-4000-8000-0000000000e1';
  s9 uuid := 'ab0b0000-0000-4000-8000-0000000000e9';
  conv uuid; run1 uuid; run2 uuid; run_b uuid;
  t uuid; child uuid; older uuid; other uuid;
  j jsonb;
  form uuid := gen_random_uuid();
  rel uuid := gen_random_uuid();
  plan1 uuid := gen_random_uuid(); plan2 uuid := gen_random_uuid();
  schema1 uuid := gen_random_uuid(); type1 uuid := gen_random_uuid(); obj uuid := gen_random_uuid();
  auto uuid := gen_random_uuid(); auto_v uuid := gen_random_uuid();
  auto_b uuid := gen_random_uuid(); auto_bv uuid := gen_random_uuid();
  page uuid;
BEGIN
  conv := chat_create_group(a, u1, 'Agent Obj IT group', ARRAY[u2]);
  run1 := pg_temp.new_run(a, conv, u1);
  run2 := pg_temp.new_run(a, conv, u1);
  run_b := pg_temp.new_run(b, chat_get_or_create_dm(b, u9, u9), u9);

  -- A task Robert just created: nothing in the way. The creation's own history row, the
  -- creator's stamp in "last edited by" and the SLA rows written by triggers are no reasons.
  t := pg_temp.task(a, s1, 'Undo: fresh task', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  PERFORM pg_temp.ok((SELECT count(*) FROM task_history WHERE task_id = t AND action = 'create') = 1, 'fixture: the task has its create history row');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, 'blockers: a fresh task has none');
  -- The same without a run and for another person: still nothing (the creator is not "someone else").
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, NULL, NULL) = '[]'::jsonb AND agent_undo_blockers(a, 'task', t, u2, now(), run1) = '[]'::jsonb,
    'blockers: a fresh task has none without a run, and none for an admin either');

  -- gone: unknown id, a task of another organization, this task asked for as another organization.
  other := pg_temp.task(b, s9, 'Undo: task of B', u9);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', gen_random_uuid(), u1, now(), run1) = '[{"code": "gone", "count": 1, "by": null}]'::jsonb, 'blockers: gone for an unknown task');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', other, u1, now(), run1)) = 'gone'
    AND pg_temp.codes(agent_undo_blockers(b, 'task', t, u9, now(), run1)) = 'gone', 'blockers: a task of another organization is gone');
  PERFORM pg_temp.ok(agent_undo_blockers(b, 'task', other, u9, now(), NULL) = '[]'::jsonb, 'blockers: organization B reads its own task');
  PERFORM pg_temp.expect_error(format('SELECT agent_undo_blockers(%L, %L, %L, %L, now(), %L)', a, 'plan_item', t, u1, run1), '22023');
  PERFORM pg_temp.expect_error(format('SELECT agent_undo_blockers(%L, NULL, %L, %L, now(), %L)', a, t, u1, run1), '22023');

  -- changed_by_other: a change the history records (priority), by someone else.
  UPDATE tasks SET priority = 'high', updated_by = u2 WHERE id = t;
  j := agent_undo_blockers(a, 'task', t, u1, now(), run1);
  PERFORM pg_temp.ok(pg_temp.codes(j) = 'changed_by_other' AND pg_temp.entry(j, 'changed_by_other') = jsonb_build_object('code', 'changed_by_other', 'count', 1, 'by', u2),
    'blockers: changed_by_other with count and the person');
  -- The same change is u2's own: for u2 it is not "someone else".
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u2, now(), run1) = '[]'::jsonb, 'blockers: one''s own change is not changed_by_other');

  -- The actor's own changes never count, however many.
  t := pg_temp.task(a, s1, 'Undo: own edits', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  UPDATE tasks SET priority = 'low', due_date = now() + interval '3 days', assigned_to = u2, updated_by = u1 WHERE id = t;
  PERFORM pg_temp.ok((SELECT count(*) FROM task_history WHERE task_id = t AND action <> 'create') = 3, 'fixture: three history rows by the actor');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, 'blockers: the actor''s own changes do not block');
  -- 1.21: nor for a tenant admin pressing Undo: what the invoker did is not "someone else".
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u2, now(), run1) = '[]'::jsonb, 'blockers: the invoker''s changes do not stop an admin');
  -- Without a run there is no invoker to know of, so they are someone else's changes.
  j := agent_undo_blockers(a, 'task', t, u2, now(), NULL);
  PERFORM pg_temp.ok(pg_temp.codes(j) = 'changed_by_other' AND (pg_temp.entry(j, 'changed_by_other') ->> 'count')::int = 3 AND pg_temp.entry(j, 'changed_by_other') ->> 'by' = u1::text,
    'blockers: for someone else the same changes block, with their number');
  -- History rows filed under another organization are not read.
  UPDATE task_history SET organization_id = b WHERE task_id = t AND action <> 'create';
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u2, now(), NULL) = '[]'::jsonb, 'blockers: history rows of another organization are not read');
  -- Two other people changed the task: "by" names the one who changed it last.
  t := pg_temp.task(a, s1, 'Undo: two editors', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  INSERT INTO task_history (task_id, organization_id, action, field_name, changed_by, changed_at) VALUES
    (t, a, 'update', 'summary', u3, now() - interval '1 minute'),
    (t, a, 'update', 'description', u2, now() - interval '5 minutes');
  j := agent_undo_blockers(a, 'task', t, u1, now(), run1);
  PERFORM pg_temp.ok(pg_temp.entry(j, 'changed_by_other') = jsonb_build_object('code', 'changed_by_other', 'count', 2, 'by', u3), 'blockers: "by" is the person who changed the task last');
  -- A change the history does not record (sort order) is seen through "last edited by".
  t := pg_temp.task(a, s1, 'Undo: silent edit', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  UPDATE tasks SET sort_order = 7, updated_by = u2 WHERE id = t;
  j := agent_undo_blockers(a, 'task', t, u1, now(), run1);
  PERFORM pg_temp.ok((SELECT count(*) FROM task_history WHERE task_id = t) = 1 AND pg_temp.codes(j) = 'changed_by_other'
    AND pg_temp.entry(j, 'changed_by_other') = jsonb_build_object('code', 'changed_by_other', 'count', 1, 'by', u2), 'blockers: a change without a history row is still seen');
  -- A system write without a person is not "someone else".
  t := pg_temp.task(a, s1, 'Undo: system write', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  INSERT INTO task_history (task_id, organization_id, action, field_name, changed_by) VALUES (t, a, 'update', 'due_date', NULL);
  UPDATE tasks SET sort_order = 3, updated_by = NULL WHERE id = t;
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, 'blockers: writes without a person do not block');

  -- transition: a status change, also the actor's own; and a workflow transition that left the
  -- old status bucket unchanged (no history row, only the operation row).
  t := pg_temp.task(a, s1, 'Undo: status change', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  UPDATE tasks SET status = 'in_progress', updated_by = u1 WHERE id = t;
  j := agent_undo_blockers(a, 'task', t, u1, now(), run1);
  PERFORM pg_temp.ok(pg_temp.codes(j) = 'transition' AND pg_temp.entry(j, 'transition') = '{"code": "transition", "count": 1, "by": null}'::jsonb, 'blockers: transition after a status change');
  t := pg_temp.task(a, s1, 'Undo: workflow transition', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  INSERT INTO sla_workflow_operations (task_id, organization_id, before_snapshot, lease_until, status) VALUES (t, a, '{}', now(), 'compensated');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, 'blockers: a rolled-back workflow transition does not block');
  INSERT INTO sla_workflow_operations (task_id, organization_id, before_snapshot, lease_until, status) VALUES (t, a, '{}', now(), 'committed');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, now(), run1)) = 'transition', 'blockers: transition after a workflow transition');

  -- has_subtasks. A subtask of the same run is Robert's own work; one made by a person or by
  -- another run is a dependant.
  t := pg_temp.task(a, s1, 'Undo: parent', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  child := pg_temp.task(a, s1, 'Undo: same-run subtask', u1, t);
  PERFORM pg_temp.own(run1, 'subtask', child);
  -- the product writes this row on the parent when a subtask is created.
  INSERT INTO task_history (task_id, organization_id, action, new_value, changed_by) VALUES (t, a, 'subtask_created', jsonb_build_object('id', child), u1);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, 'blockers: a subtask of the same run is ignored');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u2, now(), run1) = '[]'::jsonb, 'blockers: ... also for an admin (the subtask_created row is not a change)');
  -- Without the run, or seen from another run, the same subtask counts.
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, now(), NULL)) = 'has_subtasks'
    AND pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, now(), run2)) = 'has_subtasks', 'blockers: a subtask of another run counts');
  -- A run of organization B that claims the subtask as its own does not make it Robert's here.
  PERFORM pg_temp.own(run_b, 'subtask', child);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, now(), run_b)) = 'has_subtasks', 'blockers: a run of another organization owns nothing here');
  -- The same-run subtask gets a reason of its own (someone commented on it): removing the
  -- parent would take it along, so now it counts.
  INSERT INTO task_comments (task_id, organization_id, content, created_by) VALUES (child, a, 'Bitte nicht löschen', u2);
  j := agent_undo_blockers(a, 'task', t, u1, now(), run1);
  PERFORM pg_temp.ok(pg_temp.codes(j) = 'has_subtasks' AND (pg_temp.entry(j, 'has_subtasks') ->> 'count')::int = 1, 'blockers: a same-run subtask with its own reason blocks the parent');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', child, u1, now(), run1)) = 'has_comments', 'blockers: ... and the subtask reports the reason itself');
  DELETE FROM task_comments WHERE task_id = child;
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, 'blockers: reason gone, parent free again');
  -- An OLDER task re-parented under the new task (EC-B11): it would be deleted with it.
  older := pg_temp.task(a, s1, 'Undo: older task', u2);
  UPDATE tasks SET parent_task_id = t, updated_by = u2 WHERE id = older;
  j := agent_undo_blockers(a, 'task', t, u1, now(), run1);
  PERFORM pg_temp.ok(pg_temp.codes(j) = 'has_subtasks' AND pg_temp.entry(j, 'has_subtasks') = '{"code": "has_subtasks", "count": 1, "by": null}'::jsonb,
    'blockers: an older task re-parented under the new task blocks');

  -- has_comments (ROB-12 AC-2): a comment by someone else, with the count.
  t := pg_temp.task(a, s1, 'Undo: comments', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  INSERT INTO task_comments (task_id, organization_id, content, created_by) VALUES (t, a, 'Erster Kommentar', u2);
  j := agent_undo_blockers(a, 'task', t, u1, now(), run1);
  PERFORM pg_temp.ok(j = '[{"code": "has_comments", "count": 1, "by": null}]'::jsonb, 'blockers: a comment by someone else blocks: "It now has 1 comment"');
  INSERT INTO task_comments (task_id, organization_id, content, created_by) VALUES (t, a, 'Zweiter Kommentar', u1);
  PERFORM pg_temp.ok((pg_temp.entry(agent_undo_blockers(a, 'task', t, u1, now(), run1), 'has_comments') ->> 'count')::int = 2, 'blockers: comment count');
  -- a comment in another organization's rows for the same task id cannot exist; one filed under
  -- the wrong organization is not counted.
  UPDATE task_comments SET organization_id = b WHERE task_id = t;
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, 'blockers: rows of another organization are not read');

  -- has_attachments: the old attachment table and the file table.
  t := pg_temp.task(a, s1, 'Undo: attachments', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  INSERT INTO task_attachments (task_id, organization_id, file_name, file_path) VALUES (t, a, 'alt.pdf', 'x/alt.pdf');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[{"code": "has_attachments", "count": 1, "by": null}]'::jsonb, 'blockers: has_attachments (task_attachments)');
  INSERT INTO file_attachments (organization_id, entity_type, entity_id, file_name) VALUES (a, 'task', t, 'neu.pdf');
  -- a file of a wiki page with the same id must not count for the task.
  INSERT INTO file_attachments (organization_id, entity_type, entity_id, file_name) VALUES (a, 'wiki_page', t, 'page.pdf');
  PERFORM pg_temp.ok((pg_temp.entry(agent_undo_blockers(a, 'task', t, u1, now(), run1), 'has_attachments') ->> 'count')::int = 2, 'blockers: has_attachments counts both tables');

  -- has_relationships: the task as source and as target.
  INSERT INTO relation_types (id, organization_id, name, outward_description, inward_description) VALUES (rel, a, 'agent-obj-it-blocks', 'blocks', 'is blocked by');
  t := pg_temp.task(a, s1, 'Undo: relationships', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  other := pg_temp.task(a, s1, 'Undo: related task', u2);
  INSERT INTO task_relationships (organization_id, source_type, source_id, target_type, target_id, relation_type_id, created_by) VALUES (a, 'task', t, 'task', other, rel, u2);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[{"code": "has_relationships", "count": 1, "by": null}]'::jsonb, 'blockers: has_relationships as source');
  DELETE FROM task_relationships WHERE source_id = t;
  INSERT INTO task_relationships (organization_id, source_type, source_id, target_type, target_id, relation_type_id, created_by) VALUES (a, 'task', other, 'task', t, rel, u2);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, now(), run1)) = 'has_relationships', 'blockers: has_relationships as target');

  -- has_time_entries: logged time and a running timer.
  t := pg_temp.task(a, s1, 'Undo: time', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  INSERT INTO time_entries (task_id, user_id, organization_id, duration_minutes) VALUES (t, u2, a, 30);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[{"code": "has_time_entries", "count": 1, "by": null}]'::jsonb, 'blockers: has_time_entries');
  INSERT INTO active_timers (task_id, user_id, organization_id) VALUES (t, u2, a);
  PERFORM pg_temp.ok((pg_temp.entry(agent_undo_blockers(a, 'task', t, u1, now(), run1), 'has_time_entries') ->> 'count')::int = 2, 'blockers: a running timer counts as well');

  -- has_links: an asset link, a wiki page that links to the task, a plan risk, a resource booking.
  INSERT INTO asset_object_schemas (id, organization_id, space_id, name, object_key) VALUES (schema1, a, s1, 'Agent Obj Undo', 'AOU');
  INSERT INTO asset_object_types (id, organization_id, space_id, schema_id, name) VALUES (type1, a, s1, schema1, 'Thing');
  INSERT INTO asset_objects (id, organization_id, space_id, schema_id, object_type_id, name, created_by, updated_by) VALUES (obj, a, s1, schema1, type1, 'Linked thing', u2, u2);
  INSERT INTO plans (id, organization_id, space_id, name) VALUES (plan1, a, s1, 'Agent Obj Undo Plan 1'), (plan2, a, s1, 'Agent Obj Undo Plan 2');
  t := pg_temp.task(a, s1, 'Undo: links', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  INSERT INTO asset_object_task_links (organization_id, space_id, object_id, task_id, created_by) VALUES (a, s1, obj, t, u2);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[{"code": "has_links", "count": 1, "by": null}]'::jsonb, 'blockers: has_links (asset link)');
  page := pg_temp.page(a, s1, 'Undo: page linking a task', u2);
  INSERT INTO wiki_page_links (source_page_id, target_type, target_id, created_by) VALUES (page, 'task', t, u2);
  INSERT INTO plan_risks (plan_id, organization_id, name, task_id) VALUES (plan1, a, 'Agent Obj Risk', t);
  INSERT INTO task_resource_allocations (organization_id, task_id, user_id) VALUES (a, t, u2);
  PERFORM pg_temp.ok((pg_temp.entry(agent_undo_blockers(a, 'task', t, u1, now(), run1), 'has_links') ->> 'count')::int = 4, 'blockers: has_links counts wiki link, plan risk and resource booking too');
  -- A support request and a form submission that point at the task. (A task with a support
  -- request cannot be deleted at all: the database refuses it.)
  INSERT INTO support_requests (organization_id, space_id, created_by, ticket_number, subject, category, description, task_id)
  VALUES (a, s1, u2, 99000001, 'Agent Obj request', 'general', 'x', t);
  INSERT INTO form_builder (id, organization_id, space_id, name) VALUES (form, a, s1, 'Agent Obj form');
  INSERT INTO form_builder_submissions (form_id, organization_id, space_id, task_id) VALUES (form, a, s1, t);
  PERFORM pg_temp.ok((pg_temp.entry(agent_undo_blockers(a, 'task', t, u1, now(), run1), 'has_links') ->> 'count')::int = 6, 'blockers: has_links counts a support request and a form submission');

  -- A task that a person put on a plan is linked. A plan item Robert created carries its own
  -- plan link, which is not a reason; a SECOND plan is.
  other := pg_temp.task(a, s1, 'Undo: task put on a plan', u1);
  PERFORM pg_temp.own(run1, 'task', other);
  INSERT INTO plan_tasks (plan_id, task_id) VALUES (plan1, other);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', other, u1, now(), run1) = '[{"code": "has_links", "count": 1, "by": null}]'::jsonb, 'blockers: a plan link on a plain task is a link');
  t := pg_temp.task(a, s1, 'Undo: plan item', u1);
  PERFORM pg_temp.own(run1, 'plan_item', t);
  INSERT INTO plan_tasks (plan_id, task_id) VALUES (plan1, t);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, 'blockers: the own plan link of a plan item is ignored');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', other, u1, now(), run1)) = 'has_links', 'blockers: ... the plain task of the same run keeps its plan link as a reason');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, now(), run2)) = 'has_links', 'blockers: ... but only for the run that made it');
  INSERT INTO plan_tasks (plan_id, task_id) VALUES (plan2, t);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[{"code": "has_links", "count": 1, "by": null}]'::jsonb, 'blockers: a second plan blocks a plan item');
  DELETE FROM plan_tasks WHERE task_id = t;
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, 'blockers: a plan item whose link is already removed is free');
  -- ... and with the link removed another link still counts in full.
  INSERT INTO asset_object_task_links (organization_id, space_id, object_id, task_id, created_by) VALUES (a, s1, obj, t, u2);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[{"code": "has_links", "count": 1, "by": null}]'::jsonb, 'blockers: a plan item without its plan link still reports other links');

  -- automations_ran: an automation run that names the task. Time rule by backdating: the task
  -- was created 5 minutes ago and the action was marked executed "now"; a run from 2 minutes ago
  -- counts (it started before the action was marked executed), a run from before the task existed
  -- does not.
  INSERT INTO automations (id, organization_id, space_id, name) VALUES (auto, a, s1, 'Agent Obj Automation');
  INSERT INTO automation_versions (id, automation_id, space_id, version_number, definition, trigger_kind) VALUES (auto_v, auto, s1, 1, '{}', 'app.task.created');
  INSERT INTO automations (id, organization_id, space_id, name) VALUES (auto_b, b, s9, 'Agent Obj Automation B');
  INSERT INTO automation_versions (id, automation_id, space_id, version_number, definition, trigger_kind) VALUES (auto_bv, auto_b, s9, 1, '{}', 'app.task.created');
  t := pg_temp.task(a, s1, 'Undo: automation', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  UPDATE tasks SET created_at = now() - interval '5 minutes' WHERE id = t;
  -- a run for another task, a run of another organization naming this task, a run before the task existed.
  INSERT INTO automation_runs (automation_id, automation_version_id, space_id, organization_id, trigger_kind, trigger_payload, created_at) VALUES
    (auto, auto_v, s1, a, 'app.task.created', jsonb_build_object('task_id', gen_random_uuid()), now()),
    (auto_b, auto_bv, s1, b, 'app.task.created', jsonb_build_object('task_id', t), now()),
    (auto, auto_v, s1, a, 'app.task.created', jsonb_build_object('task_id', t), now() - interval '20 minutes'),
    (auto, auto_v, s1, a, 'app.wiki.page_created', jsonb_build_object('page_id', t), now());
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, 'blockers: runs for other objects, other organizations or from before the task do not count');
  INSERT INTO automation_runs (automation_id, automation_version_id, space_id, organization_id, trigger_kind, trigger_payload, created_at)
  VALUES (auto, auto_v, s1, a, 'app.task.created', jsonb_build_object('task_id', t, 'task', jsonb_build_object('id', t)), now() - interval '2 minutes');
  j := agent_undo_blockers(a, 'task', t, u1, now(), run1);
  PERFORM pg_temp.ok(j = '[{"code": "automations_ran", "count": 1, "by": null}]'::jsonb, 'blockers: an automation run for the task blocks, also one from before the action was marked executed');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, NULL, run1)) = 'automations_ran', 'blockers: p_since NULL counts from the creation');
  -- p_since earlier than the creation widens the window.
  PERFORM pg_temp.ok((pg_temp.entry(agent_undo_blockers(a, 'task', t, u1, now() - interval '30 minutes', run1), 'automations_ran') ->> 'count')::int = 2, 'blockers: an earlier p_since counts from there');

  -- Several reasons come in the fixed order.
  UPDATE tasks SET priority = 'critical', status = 'review', updated_by = u2 WHERE id = t;
  INSERT INTO task_comments (task_id, organization_id, content, created_by) VALUES (t, a, 'Kommentar', u2);
  PERFORM pg_temp.task(a, s1, 'Undo: foreign subtask', u2, t);
  INSERT INTO time_entries (task_id, user_id, organization_id, duration_minutes) VALUES (t, u2, a, 5);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, now(), run1))
    = 'changed_by_other,transition,has_subtasks,has_comments,has_time_entries,automations_ran', 'blockers: reasons in the fixed order');
  -- Still nothing leaks to organization B.
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(b, 'task', t, u9, now(), run1)) = 'gone', 'blockers: organization B sees none of it');
END $$;

-- ---------------------------------------------------------------- agent_undo_blockers: wiki pages
DO $$
DECLARE
  a uuid := 'ab0b0000-0000-4000-8000-00000000000a';
  b uuid := 'ab0b0000-0000-4000-8000-00000000000b';
  u1 uuid := 'ab0b0000-0000-4000-8000-000000000001';
  u2 uuid := 'ab0b0000-0000-4000-8000-000000000002';
  u9 uuid := 'ab0b0000-0000-4000-8000-000000000009';
  s1 uuid := 'ab0b0000-0000-4000-8000-0000000000e1';
  conv uuid := (SELECT c.id FROM chat_conversations c WHERE c.organization_id = 'ab0b0000-0000-4000-8000-00000000000a' AND c.title = 'Agent Obj IT group');
  run1 uuid; run2 uuid;
  p uuid; child uuid; other uuid; t uuid;
  j jsonb;
  rel uuid := (SELECT r.id FROM relation_types r WHERE r.organization_id = 'ab0b0000-0000-4000-8000-00000000000a' AND r.name = 'agent-obj-it-blocks');
  auto uuid := (SELECT x.id FROM automations x WHERE x.organization_id = 'ab0b0000-0000-4000-8000-00000000000a' AND x.name = 'Agent Obj Automation');
  auto_v uuid;
BEGIN
  auto_v := (SELECT v.id FROM automation_versions v WHERE v.automation_id = auto);
  run1 := pg_temp.new_run(a, conv, u1);
  run2 := pg_temp.new_run(a, conv, u1);

  -- Version 1 is written by the page's own INSERT and must not count.
  p := pg_temp.page(a, s1, 'Undo: fresh page', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', p);
  PERFORM pg_temp.ok((SELECT array_agg(v.version) FROM wiki_page_versions v WHERE v.wiki_page_id = p) = ARRAY[1], 'fixture: creating a page writes version 1');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1) = '[]'::jsonb, 'blockers: version 1 of a wiki page is ignored');
  -- ... also for an admin, although version 1 was "changed by" the creator.
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'wiki_page', p, u2, now(), run1) = '[]'::jsonb, 'blockers: version 1 is ignored for an admin too');
  -- The actor edits the text: version 2 by the actor, still free.
  UPDATE wiki_pages SET content = '<p>mehr</p>', updated_by = u1 WHERE id = p;
  PERFORM pg_temp.ok((SELECT max(v.version) FROM wiki_page_versions v WHERE v.wiki_page_id = p) = 2
    AND agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1) = '[]'::jsonb, 'blockers: the actor''s own page edit does not block');
  -- Someone else edits: a later version by them.
  UPDATE wiki_pages SET title = 'Undo: fresh page (bearbeitet)', updated_by = u2 WHERE id = p;
  j := agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1);
  PERFORM pg_temp.ok(pg_temp.codes(j) = 'changed_by_other' AND pg_temp.entry(j, 'changed_by_other') = jsonb_build_object('code', 'changed_by_other', 'count', 1, 'by', u2),
    'blockers: a later page version by someone else blocks');
  -- The actor edits once more ("last edited by" is the actor again): the other person's version
  -- is still there and still a reason.
  UPDATE wiki_pages SET content = '<p>noch mehr</p>', updated_by = u1 WHERE id = p;
  j := agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1);
  PERFORM pg_temp.ok(pg_temp.entry(j, 'changed_by_other') = jsonb_build_object('code', 'changed_by_other', 'count', 1, 'by', u2),
    'blockers: someone else''s page version still blocks after the actor edited again');

  -- A change without a version (tags) is seen through "last edited by"; access rules count.
  p := pg_temp.page(a, s1, 'Undo: silent page edit', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', p);
  UPDATE wiki_pages SET tags = '["x"]', updated_by = u2 WHERE id = p;
  PERFORM pg_temp.ok((SELECT count(*) FROM wiki_page_versions v WHERE v.wiki_page_id = p) = 1
    AND pg_temp.codes(agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1)) = 'changed_by_other', 'blockers: a page change without a version is still seen');
  p := pg_temp.page(a, s1, 'Undo: page access', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', p);
  INSERT INTO wiki_page_permissions (wiki_page_id, entity_type, entity_id, created_by) VALUES (p, 'user', u1, u1);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1) = '[]'::jsonb, 'blockers: the actor''s own access rule does not block');
  INSERT INTO wiki_page_permissions (wiki_page_id, entity_type, entity_id, created_by) VALUES (p, 'user', u2, u2);
  j := agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1);
  PERFORM pg_temp.ok(pg_temp.codes(j) = 'changed_by_other' AND pg_temp.entry(j, 'changed_by_other') ->> 'by' = u2::text, 'blockers: an access rule set by someone else blocks');

  -- published, in review (transition).
  p := pg_temp.page(a, s1, 'Undo: published page', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', p);
  UPDATE wiki_pages SET workflow_status = 'in_review', updated_by = u1 WHERE id = p;
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1) = '[{"code": "transition", "count": 1, "by": null}]'::jsonb, 'blockers: a page in review reports transition');
  UPDATE wiki_pages SET workflow_status = 'published', is_published = true, updated_by = u1 WHERE id = p;
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1) = '[{"code": "published", "count": 1, "by": null}]'::jsonb, 'blockers: a published page reports published');

  -- has_children: a page of the same run is ignored, a person's page counts, an archived one
  -- is out of the way.
  p := pg_temp.page(a, s1, 'Undo: parent page', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', p);
  child := pg_temp.page(a, s1, 'Undo: same-run child page', u1, p);
  PERFORM pg_temp.own(run1, 'wiki_page', child);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1) = '[]'::jsonb, 'blockers: a child page of the same run is ignored');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'wiki_page', p, u1, now(), run2)) = 'has_children', 'blockers: seen from another run the child page counts');
  INSERT INTO wiki_page_comments (wiki_page_id, content, created_by) VALUES (child, 'Kommentar', u2);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1)) = 'has_children', 'blockers: a same-run child page with its own reason blocks the parent');
  UPDATE wiki_pages SET is_archived = true WHERE id = child;
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1) = '[]'::jsonb, 'blockers: an archived (undone) child page is out of the way');
  other := pg_temp.page(a, s1, 'Undo: foreign child page', u2, p);
  j := agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1);
  PERFORM pg_temp.ok(j = '[{"code": "has_children", "count": 1, "by": null}]'::jsonb, 'blockers: a child page made by a person blocks');

  -- comments (both tables), attachments (three tables), relationship, links, automation.
  p := pg_temp.page(a, s1, 'Undo: page dependants', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', p);
  INSERT INTO wiki_page_comments (wiki_page_id, content, created_by) VALUES (p, 'Kommentar', u2);
  INSERT INTO wiki_comments (wiki_page_id, content, created_by) VALUES (p, 'Alter Kommentar', u2);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1) = '[{"code": "has_comments", "count": 2, "by": null}]'::jsonb, 'blockers: page comments');
  INSERT INTO wiki_page_attachments (wiki_page_id, file_name, file_path, file_size) VALUES (p, 'a.pdf', 'x/a.pdf', 1);
  INSERT INTO wiki_attachments (wiki_page_id, file_name, file_path) VALUES (p, 'b.pdf', 'x/b.pdf');
  INSERT INTO file_attachments (organization_id, entity_type, entity_id, file_name) VALUES (a, 'wiki_page', p, 'c.pdf');
  PERFORM pg_temp.ok((pg_temp.entry(agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1), 'has_attachments') ->> 'count')::int = 3, 'blockers: page attachments');
  t := pg_temp.task(a, s1, 'Undo: task related to a page', u2);
  INSERT INTO task_relationships (organization_id, source_type, source_id, target_type, target_id, relation_type_id, created_by) VALUES (a, 'task', t, 'wiki_page', p, rel, u2);
  -- a link to the page from another page, and a link from the page to a task.
  INSERT INTO wiki_page_links (source_page_id, target_type, target_id, created_by) VALUES (other, 'page', p, u2), (p, 'task', t, u2);
  INSERT INTO automation_runs (automation_id, automation_version_id, space_id, organization_id, trigger_kind, trigger_payload)
  VALUES (auto, auto_v, s1, a, 'app.wiki.page_created', jsonb_build_object('page_id', p));
  j := agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1);
  PERFORM pg_temp.ok(pg_temp.codes(j) = 'has_comments,has_attachments,has_relationships,has_links,automations_ran'
    AND (pg_temp.entry(j, 'has_links') ->> 'count')::int = 2 AND (pg_temp.entry(j, 'has_relationships') ->> 'count')::int = 1,
    'blockers: page relationships, links and automation runs, in the fixed order');

  -- gone: unknown, archived (that is what an Undo leaves behind), another organization.
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'wiki_page', gen_random_uuid(), u1, now(), run1)) = 'gone'
    AND pg_temp.codes(agent_undo_blockers(b, 'wiki_page', p, u9, now(), run1)) = 'gone', 'blockers: an unknown page and a page of another organization are gone');
  UPDATE wiki_pages SET is_archived = true WHERE id = p;
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'wiki_page', p, u1, now(), run1) = '[{"code": "gone", "count": 1, "by": null}]'::jsonb, 'blockers: an archived page is gone');
END $$;

-- ---------------------------------------------------------------- agent_undo_blockers: assets
DO $$
DECLARE
  a uuid := 'ab0b0000-0000-4000-8000-00000000000a';
  b uuid := 'ab0b0000-0000-4000-8000-00000000000b';
  u1 uuid := 'ab0b0000-0000-4000-8000-000000000001';
  u2 uuid := 'ab0b0000-0000-4000-8000-000000000002';
  u9 uuid := 'ab0b0000-0000-4000-8000-000000000009';
  s1 uuid := 'ab0b0000-0000-4000-8000-0000000000e1';
  conv uuid := (SELECT c.id FROM chat_conversations c WHERE c.organization_id = 'ab0b0000-0000-4000-8000-00000000000a' AND c.title = 'Agent Obj IT group');
  run1 uuid;
  schema1 uuid := (SELECT x.id FROM asset_object_schemas x WHERE x.organization_id = 'ab0b0000-0000-4000-8000-00000000000a' AND x.object_key = 'AOU');
  type1 uuid;
  o uuid; other uuid := gen_random_uuid(); t uuid;
  j jsonb;
  auto uuid := (SELECT x.id FROM automations x WHERE x.organization_id = 'ab0b0000-0000-4000-8000-00000000000a' AND x.name = 'Agent Obj Automation');
  auto_v uuid;
BEGIN
  type1 := (SELECT x.id FROM asset_object_types x WHERE x.schema_id = schema1);
  auto_v := (SELECT v.id FROM automation_versions v WHERE v.automation_id = auto);
  run1 := pg_temp.new_run(a, conv, u1);
  INSERT INTO asset_objects (id, organization_id, space_id, schema_id, object_type_id, name, created_by, updated_by) VALUES (other, a, s1, schema1, type1, 'Other thing', u2, u2);

  -- A fresh asset with its "created" change row.
  o := gen_random_uuid();
  INSERT INTO asset_objects (id, organization_id, space_id, schema_id, object_type_id, name, created_by, updated_by) VALUES (o, a, s1, schema1, type1, 'Undo: fresh asset', u1, u1);
  INSERT INTO asset_object_changes (organization_id, space_id, object_id, schema_id, change_type, changed_by) VALUES (a, s1, o, schema1, 'object_create', u1);
  PERFORM pg_temp.own(run1, 'asset_object', o);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'asset_object', o, u1, now(), run1) = '[]'::jsonb AND agent_undo_blockers(a, 'asset_object', o, u2, now(), run1) = '[]'::jsonb,
    'blockers: a fresh asset has none (the create change row is not a change)');
  INSERT INTO asset_object_changes (organization_id, space_id, object_id, schema_id, change_type, attribute_key, changed_by) VALUES (a, s1, o, schema1, 'attribute_update', 'model', u1);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'asset_object', o, u1, now(), run1) = '[]'::jsonb, 'blockers: the actor''s own asset change does not block');
  INSERT INTO asset_object_changes (organization_id, space_id, object_id, schema_id, change_type, attribute_key, changed_by) VALUES (a, s1, o, schema1, 'attribute_update', 'model', u2);
  j := agent_undo_blockers(a, 'asset_object', o, u1, now(), run1);
  PERFORM pg_temp.ok(j = jsonb_build_array(jsonb_build_object('code', 'changed_by_other', 'count', 1, 'by', u2)), 'blockers: an asset change by someone else blocks');

  -- A change without a change row is seen through "last edited by".
  o := gen_random_uuid();
  INSERT INTO asset_objects (id, organization_id, space_id, schema_id, object_type_id, name, created_by, updated_by) VALUES (o, a, s1, schema1, type1, 'Undo: silent asset edit', u1, u1);
  PERFORM pg_temp.own(run1, 'asset_object', o);
  UPDATE asset_objects SET description = 'x', updated_by = u2 WHERE id = o;
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'asset_object', o, u1, now(), run1)) = 'changed_by_other', 'blockers: an asset change without a change row is still seen');

  -- comments, attachments and image, references (both ends), task link, automation.
  o := gen_random_uuid();
  INSERT INTO asset_objects (id, organization_id, space_id, schema_id, object_type_id, name, created_by, updated_by) VALUES (o, a, s1, schema1, type1, 'Undo: asset dependants', u1, u1);
  PERFORM pg_temp.own(run1, 'asset_object', o);
  INSERT INTO asset_object_comments (organization_id, space_id, object_id, content, created_by) VALUES (a, s1, o, 'Kommentar', u2);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'asset_object', o, u1, now(), run1) = '[{"code": "has_comments", "count": 1, "by": null}]'::jsonb, 'blockers: asset comment');
  INSERT INTO asset_object_attachments (organization_id, space_id, object_id, schema_id, file_name, file_path, file_size, mime_type) VALUES (a, s1, o, schema1, 'a.pdf', 'x/a.pdf', 1, 'application/pdf');
  UPDATE asset_objects SET image_path = 'x/img.png', updated_by = u1 WHERE id = o;
  PERFORM pg_temp.ok((pg_temp.entry(agent_undo_blockers(a, 'asset_object', o, u1, now(), run1), 'has_attachments') ->> 'count')::int = 2, 'blockers: asset attachment and image');
  INSERT INTO asset_object_references (organization_id, space_id, source_object_id, target_object_id, created_by) VALUES (a, s1, o, other, u2), (a, s1, other, o, u2);
  t := pg_temp.task(a, s1, 'Undo: task linked to an asset', u2);
  INSERT INTO asset_object_task_links (organization_id, space_id, object_id, task_id, created_by) VALUES (a, s1, o, t, u2);
  INSERT INTO automation_runs (automation_id, automation_version_id, space_id, organization_id, trigger_kind, trigger_payload)
  VALUES (auto, auto_v, s1, a, 'app.asset_object.created', jsonb_build_object('asset_id', o));
  j := agent_undo_blockers(a, 'asset_object', o, u1, now(), run1);
  PERFORM pg_temp.ok(pg_temp.codes(j) = 'has_comments,has_attachments,has_relationships,has_links,automations_ran'
    AND (pg_temp.entry(j, 'has_relationships') ->> 'count')::int = 2 AND (pg_temp.entry(j, 'has_links') ->> 'count')::int = 1,
    'blockers: asset references, task link and automation run, in the fixed order');

  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'asset_object', gen_random_uuid(), u1, now(), run1)) = 'gone'
    AND pg_temp.codes(agent_undo_blockers(b, 'asset_object', o, u9, now(), run1)) = 'gone', 'blockers: an unknown asset and an asset of another organization are gone');
  -- An id is looked up only under the type that was asked for.
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', o, u1, now(), run1)) = 'gone'
    AND pg_temp.codes(agent_undo_blockers(a, 'wiki_page', o, u1, now(), run1)) = 'gone', 'blockers: an asset id is not a task or a page');
END $$;

-- ---------------------------------------------------------------- agent_undo_task (ROB-12)
DO $$
DECLARE
  a uuid := 'ab0b0000-0000-4000-8000-00000000000a';
  b uuid := 'ab0b0000-0000-4000-8000-00000000000b';
  u1 uuid := 'ab0b0000-0000-4000-8000-000000000001';
  u2 uuid := 'ab0b0000-0000-4000-8000-000000000002';
  u9 uuid := 'ab0b0000-0000-4000-8000-000000000009';
  s1 uuid := 'ab0b0000-0000-4000-8000-0000000000e1';
  s9 uuid := 'ab0b0000-0000-4000-8000-0000000000e9';
  conv uuid := (SELECT c.id FROM chat_conversations c WHERE c.organization_id = 'ab0b0000-0000-4000-8000-00000000000a' AND c.title = 'Agent Obj IT group');
  conv_b uuid;
  run1 uuid; run2 uuid; run_b uuid;
  t uuid; child uuid; grandchild uuid; older uuid; plain uuid; t_b uuid; item uuid;
  plan1 uuid := (SELECT p.id FROM plans p WHERE p.organization_id = 'ab0b0000-0000-4000-8000-00000000000a' AND p.name = 'Agent Obj Undo Plan 1');
  j jsonb;
  v_tasks_before bigint;
BEGIN
  run1 := pg_temp.new_run(a, conv, u1);
  run2 := pg_temp.new_run(a, conv, u1);
  conv_b := chat_get_or_create_dm(b, u9, u9);
  run_b := pg_temp.new_run(b, conv_b, u9);

  -- Not found (P0002): unknown task, a task of another organization (from either side), and a
  -- task of this organization that no action of the run created.
  t := pg_temp.task(a, s1, 'Undo task: own', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  plain := pg_temp.task(a, s1, 'Undo task: made by a person', u1);
  t_b := pg_temp.task(b, s9, 'Undo task: of B', u9);
  PERFORM pg_temp.own(run_b, 'task', t_b);
  PERFORM pg_temp.expect_error(format('SELECT agent_undo_task(%L, %L, %L, now(), %L)', a, gen_random_uuid(), u1, run1), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT agent_undo_task(%L, %L, %L, now(), %L)', a, t_b, u1, run1), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT agent_undo_task(%L, %L, %L, now(), %L)', a, t_b, u1, run_b), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT agent_undo_task(%L, %L, %L, now(), %L)', b, t, u9, run1), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT agent_undo_task(%L, %L, %L, now(), %L)', b, t, u9, run_b), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT agent_undo_task(%L, %L, %L, now(), %L)', a, plain, u1, run1), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT agent_undo_task(%L, %L, %L, now(), %L)', a, t, u1, run2), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT agent_undo_task(%L, %L, %L, now(), NULL)', a, t, u1), 'P0002');
  PERFORM pg_temp.ok((SELECT count(*) FROM tasks WHERE id IN (t, plain, t_b)) = 3, 'undo_task: a refused call deletes nothing');

  -- Blocked: a comment by someone else. Nothing is deleted and the reason comes back.
  INSERT INTO task_comments (task_id, organization_id, content, created_by) VALUES (t, a, 'Kommentar von Markus', u2);
  j := agent_undo_task(a, t, u1, now(), run1);
  PERFORM pg_temp.ok(j = '{"deleted": false, "blockers": [{"code": "has_comments", "count": 1, "by": null}]}'::jsonb, 'undo_task: blocked by a comment, with the count');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM tasks WHERE id = t) AND (SELECT count(*) FROM task_comments WHERE task_id = t) = 1, 'undo_task: a blocked task and its comment stay');
  DELETE FROM task_comments WHERE task_id = t;

  -- Blocked: an older task was moved under the new one. Both stay.
  older := pg_temp.task(a, s1, 'Undo task: older task', u2);
  UPDATE tasks SET parent_task_id = t, updated_by = u2 WHERE id = older;
  j := agent_undo_task(a, t, u1, now(), run1);
  PERFORM pg_temp.ok(NOT (j ->> 'deleted')::boolean AND pg_temp.codes(j -> 'blockers') = 'has_subtasks', 'undo_task: an older task re-parented under the new task blocks the undo');
  PERFORM pg_temp.ok((SELECT count(*) FROM tasks WHERE id IN (t, older)) = 2, 'undo_task: neither the task nor the older task is deleted');
  UPDATE tasks SET parent_task_id = NULL, updated_by = u2 WHERE id = older;

  -- Clean: the task goes, exactly as the product's own delete removes it. The actor's own edit
  -- does not stand in the way.
  UPDATE tasks SET priority = 'high', updated_by = u1 WHERE id = t;
  SELECT count(*) INTO v_tasks_before FROM tasks WHERE organization_id = a;
  j := agent_undo_task(a, t, u1, now(), run1);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean AND j -> 'blockers' = '[]'::jsonb AND j -> 'deleted_task_ids' = jsonb_build_array(t)
    AND j -> 'storage_paths' = '[]'::jsonb AND j ->> 'summary' = 'Undo task: own', 'undo_task: deleted, with the result of the product''s delete function');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM tasks WHERE id = t) AND NOT EXISTS (SELECT 1 FROM task_history WHERE task_id = t)
    AND (SELECT count(*) FROM tasks WHERE organization_id = a) = v_tasks_before - 1, 'undo_task: exactly this task and its history are gone');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM tasks WHERE id = older) AND EXISTS (SELECT 1 FROM tasks WHERE id = plain), 'undo_task: other tasks stay');
  -- Afterwards: gone, and a second Undo is "not found".
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, now(), run1)) = 'gone', 'undo_task: the deleted task is gone');
  PERFORM pg_temp.expect_error(format('SELECT agent_undo_task(%L, %L, %L, now(), %L)', a, t, u1, run1), 'P0002');

  -- Parent with a subtask and a sub-subtask of the same run ("Undo all", parent pressed alone):
  -- the clean ones go with the parent.
  t := pg_temp.task(a, s1, 'Undo task: parent', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  child := pg_temp.task(a, s1, 'Undo task: subtask', u1, t);
  PERFORM pg_temp.own(run1, 'subtask', child);
  grandchild := pg_temp.task(a, s1, 'Undo task: sub-subtask', u1, child);
  PERFORM pg_temp.own(run1, 'subtask', grandchild);
  -- A reason on the sub-subtask reaches the top: nothing may be deleted.
  INSERT INTO time_entries (task_id, user_id, organization_id, duration_minutes) VALUES (grandchild, u2, a, 15);
  j := agent_undo_task(a, t, u1, now(), run1);
  PERFORM pg_temp.ok(NOT (j ->> 'deleted')::boolean AND pg_temp.codes(j -> 'blockers') = 'has_subtasks' AND (SELECT count(*) FROM tasks WHERE id IN (t, child, grandchild)) = 3,
    'undo_task: a reason two levels down blocks the parent; nothing is deleted');
  -- Children first: the sub-subtask is blocked itself, the subtask is blocked through it.
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_task(a, grandchild, u1, now(), run1) -> 'blockers') = 'has_time_entries'
    AND pg_temp.codes(agent_undo_task(a, child, u1, now(), run1) -> 'blockers') = 'has_subtasks', 'undo_task: each level reports its own reason');
  DELETE FROM time_entries WHERE task_id = grandchild;
  j := agent_undo_task(a, t, u1, now(), run1);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean AND jsonb_array_length(j -> 'deleted_task_ids') = 3
    AND (SELECT count(*) FROM tasks WHERE id IN (t, child, grandchild)) = 0, 'undo_task: parent, subtask and sub-subtask of the same run go together');
  PERFORM pg_temp.expect_error(format('SELECT agent_undo_task(%L, %L, %L, now(), %L)', a, child, u1, run1), 'P0002');

  -- Children first, one at a time, also works.
  t := pg_temp.task(a, s1, 'Undo task: parent 2', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  child := pg_temp.task(a, s1, 'Undo task: subtask 2', u1, t);
  PERFORM pg_temp.own(run1, 'subtask', child);
  j := agent_undo_task(a, child, u1, now(), run1);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = child) AND EXISTS (SELECT 1 FROM tasks WHERE id = t),
    'undo_task: the subtask alone, the parent stays');
  j := agent_undo_task(a, t, u1, now(), run1);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = t), 'undo_task: then the parent');

  -- A plan item: its own plan link goes with the task (the backend removes the link first; if
  -- it did not, the link still must not block or stay behind).
  item := pg_temp.task(a, s1, 'Undo task: plan item', u1);
  PERFORM pg_temp.own(run1, 'plan_item', item);
  INSERT INTO plan_tasks (plan_id, task_id) VALUES (plan1, item);
  j := agent_undo_task(a, item, u1, now(), run1);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM plan_tasks WHERE task_id = item) AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = item),
    'undo_task: a plan item and its own plan link are removed');

  -- An admin (u2) undoes the invoker's untouched task.
  t := pg_temp.task(a, s1, 'Undo task: by admin', u1);
  PERFORM pg_temp.own(run2, 'task', t);
  j := agent_undo_task(a, t, u2, now(), run2);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = t), 'undo_task: an admin can undo an untouched task');

  -- Organization B is untouched by everything above.
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM tasks WHERE id = t_b), 'undo_task: the task of organization B is still there');
  j := agent_undo_task(b, t_b, u9, now(), run_b);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = t_b), 'undo_task: organization B undoes its own task');
END $$;

-- ---------------------------------------------------------------- as the application role
-- The backend calls these functions as service_role. This proves the role can reach everything
-- they read (the extensions schema included) and can run the product's delete function.
INSERT INTO tasks (id, organization_id, space_id, task_type_id, summary, created_by, updated_by) VALUES
  ('ab0b0000-0000-4000-8000-0000000000d1', 'ab0b0000-0000-4000-8000-00000000000a', 'ab0b0000-0000-4000-8000-0000000000e1', 'task', 'Service role undo target', 'ab0b0000-0000-4000-8000-000000000001', 'ab0b0000-0000-4000-8000-000000000001');
SELECT pg_temp.own(
  pg_temp.new_run('ab0b0000-0000-4000-8000-00000000000a',
    (SELECT c.id FROM chat_conversations c WHERE c.organization_id = 'ab0b0000-0000-4000-8000-00000000000a' AND c.title = 'Agent Obj IT group'),
    'ab0b0000-0000-4000-8000-000000000001'),
  'task', 'ab0b0000-0000-4000-8000-0000000000d1');
SELECT a.run_id AS sr_run FROM agent_actions a WHERE a.entity_id = 'ab0b0000-0000-4000-8000-0000000000d1' \gset

SET LOCAL ROLE service_role;
SELECT count(*) AS sr_members FROM agent_find_members('ab0b0000-0000-4000-8000-00000000000a', 'Müller') \gset
SELECT count(*) AS sr_labels FROM agent_space_labels('ab0b0000-0000-4000-8000-00000000000a', 'ab0b0000-0000-4000-8000-0000000000e1') \gset
SELECT count(*) AS sr_similar FROM agent_find_similar('ab0b0000-0000-4000-8000-00000000000a', 'task',
  ARRAY['ab0b0000-0000-4000-8000-0000000000e1']::uuid[], 'Service role undo target') \gset
SELECT agent_undo_blockers('ab0b0000-0000-4000-8000-00000000000a', 'task', 'ab0b0000-0000-4000-8000-0000000000d1',
  'ab0b0000-0000-4000-8000-000000000001', now(), :'sr_run') = '[]'::jsonb AS sr_blockers \gset
SELECT (agent_undo_task('ab0b0000-0000-4000-8000-00000000000a', 'ab0b0000-0000-4000-8000-0000000000d1',
  'ab0b0000-0000-4000-8000-000000000001', now(), :'sr_run') ->> 'deleted')::boolean AS sr_deleted \gset
RESET ROLE;

SELECT pg_temp.ok(:sr_members = 1 AND :sr_labels = 3 AND :sr_similar = 1, 'service_role can run the three lookups');
SELECT pg_temp.ok(:'sr_blockers'::boolean AND :'sr_deleted'::boolean
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = 'ab0b0000-0000-4000-8000-0000000000d1'), 'service_role can read the blockers and undo a task');

\echo chat-agent objects integration: all checks passed
ROLLBACK;
