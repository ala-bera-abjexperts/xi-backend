-- XE-T353 Robert 1.21: database checks for Undo of a task, a subtask, a page and a process.
-- Run only against a confirmed disposable database (local Supabase) with migration
-- 20261106120000 applied. Everything is rolled back, and it creates its own organizations, users
-- and spaces:
--   psql -f test/agent-undo.integration.sql
-- Success prints "agent undo integration: all checks passed"; any failure aborts with the reason.
--
-- One session in one transaction, so nothing here can race. The races (Undo against Undo, against
-- a comment, against a Confirm) are in scripts/robert-verify.mjs, on committed rows.
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

CREATE FUNCTION pg_temp.own(p_run uuid, p_kind text, p_entity uuid, p_status text DEFAULT 'executed') RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO agent_actions (organization_id, run_id, ordinal, kind, status, intent, entity_type, entity_id,
    executed_at, undo_until, expires_at)
  SELECT r.organization_id, r.id,
         (SELECT coalesce(max(a.ordinal), 0) + 1 FROM agent_actions a WHERE a.run_id = r.id),
         p_kind, p_status, '{}'::jsonb,
         CASE WHEN p_kind IN ('task', 'subtask') THEN 'task' ELSE p_kind END,
         p_entity, now(), now() + interval '10 minutes', now() + interval '24 hours'
  FROM agent_runs r WHERE r.id = p_run
  RETURNING id;
$$;

CREATE FUNCTION pg_temp.task(p_org uuid, p_space uuid, p_summary text, p_creator uuid, p_parent uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO tasks (id, organization_id, space_id, task_type_id, summary, parent_task_id, created_by, updated_by)
  VALUES (v_id, p_org, p_space, 'task', p_summary, p_parent, p_creator, p_creator);
  RETURN v_id;
END $$;

CREATE FUNCTION pg_temp.page(p_org uuid, p_space uuid, p_title text, p_creator uuid, p_parent uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO wiki_pages (id, organization_id, space_id, title, slug, content, parent_id, created_by, updated_by)
  VALUES (v_id, p_org, p_space, p_title, 'agent-undo-it-' || v_id, '<p>text</p>', p_parent, p_creator, p_creator);
  RETURN v_id;
END $$;

CREATE FUNCTION pg_temp.process(p_org uuid, p_space uuid, p_title text, p_creator uuid, p_parent uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO business_processes (id, organization_id, space_id, title, request_type, parent_id, created_by, updated_by)
  VALUES (v_id, p_org, p_space, p_title, 'Prozessbewertung', p_parent, p_creator, p_creator);
  RETURN v_id;
END $$;

-- One automation with one version, for the "automations already ran" checks.
CREATE FUNCTION pg_temp.automation_run(p_org uuid, p_space uuid, p_payload jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE a uuid := gen_random_uuid(); v uuid := gen_random_uuid();
BEGIN
  INSERT INTO automations (id, organization_id, space_id, name) VALUES (a, p_org, p_space, 'Agent Undo Automation ' || a);
  INSERT INTO automation_versions (id, automation_id, space_id, version_number, definition, trigger_kind)
  VALUES (v, a, p_space, 1, '{}', 'app.task.created');
  INSERT INTO automation_runs (automation_id, automation_version_id, space_id, organization_id, trigger_kind, trigger_payload)
  VALUES (a, v, p_space, p_org, 'app.task.created', p_payload);
END $$;

-- u1 invokes. u2 is someone else. u3 is the tenant admin pressing Undo. u9 is in another org.
INSERT INTO organizations (id, name, slug, size) VALUES
  ('ad000000-0000-4000-8000-00000000000a', 'Agent Undo IT A', 'agent-undo-it-a', '1-10'),
  ('ad000000-0000-4000-8000-00000000000b', 'Agent Undo IT B', 'agent-undo-it-b', '1-10');
INSERT INTO users (id, email, first_name, last_name, is_active) VALUES
  ('ad000000-0000-4000-8000-000000000001', 'agent-undo-it-u1@example.invalid', 'Anna', 'Invoker', true),
  ('ad000000-0000-4000-8000-000000000002', 'agent-undo-it-u2@example.invalid', 'Markus', 'Other', true),
  ('ad000000-0000-4000-8000-000000000003', 'agent-undo-it-u3@example.invalid', 'Tina', 'Admin', true),
  ('ad000000-0000-4000-8000-000000000009', 'agent-undo-it-u9@example.invalid', 'Fred', 'Foreign', true);
INSERT INTO organization_members (organization_id, user_id, role) VALUES
  ('ad000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-000000000001', 'member'),
  ('ad000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-000000000002', 'member'),
  ('ad000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-000000000003', 'admin'),
  ('ad000000-0000-4000-8000-00000000000b', 'ad000000-0000-4000-8000-000000000009', 'owner');
INSERT INTO spaces (id, organization_id, name, key) VALUES
  ('ad000000-0000-4000-8000-0000000000e1', 'ad000000-0000-4000-8000-00000000000a', 'Agent Undo IT', 'AGUND1'),
  ('ad000000-0000-4000-8000-0000000000e9', 'ad000000-0000-4000-8000-00000000000b', 'Agent Undo IT B', 'AGUND9');

-- ---------------------------------------------------------------- task and subtask, every blocker
DO $$
DECLARE
  a uuid := 'ad000000-0000-4000-8000-00000000000a';
  u1 uuid := 'ad000000-0000-4000-8000-000000000001';
  u2 uuid := 'ad000000-0000-4000-8000-000000000002';
  u3 uuid := 'ad000000-0000-4000-8000-000000000003';
  s1 uuid := 'ad000000-0000-4000-8000-0000000000e1';
  conv uuid; run1 uuid; root uuid; t uuid; other uuid; k text; c record; j jsonb;
  rel uuid := gen_random_uuid();
  plan1 uuid := gen_random_uuid();
  form uuid := gen_random_uuid();
BEGIN
  conv := chat_create_group(a, u1, 'Agent Undo IT group', ARRAY[u2]);
  run1 := pg_temp.new_run(a, conv, u1);
  other := pg_temp.task(a, s1, 'Undo: a task of someone else', u2);
  INSERT INTO relation_types (id, organization_id, name, outward_description, inward_description) VALUES (rel, a, 'agent-undo-it', 'x', 'y');
  INSERT INTO plans (id, organization_id, space_id, name) VALUES (plan1, a, s1, 'Agent Undo Plan');
  INSERT INTO form_builder (id, organization_id, space_id, name) VALUES (form, a, s1, 'Agent Undo form');

  FOREACH k IN ARRAY ARRAY['task', 'subtask'] LOOP
    FOR c IN SELECT * FROM (VALUES
      ('changed_by_other', format('UPDATE tasks SET description = ''x'', updated_by = %L WHERE id = %%L', u2)),
      ('changed_by_other', format('UPDATE tasks SET assigned_to = %L, updated_by = %L WHERE id = %%L', u1, u2)),
      ('has_comments', format('INSERT INTO task_comments (task_id, organization_id, content, created_by) VALUES (%%L, %L, ''c'', %L)', a, u2)),
      ('has_attachments', format('INSERT INTO task_attachments (task_id, organization_id, file_name, file_path) VALUES (%%L, %L, ''f'', ''x/f'')', a)),
      ('has_time_entries', format('INSERT INTO time_entries (task_id, user_id, organization_id, duration_minutes) VALUES (%%L, %L, %L, 5)', u2, a)),
      ('has_time_entries', format('DELETE FROM active_timers WHERE user_id = %L; INSERT INTO active_timers (task_id, user_id, organization_id) VALUES (%%L, %L, %L)', u2, u2, a)),
      ('has_relationships', format('INSERT INTO task_relationships (organization_id, source_type, source_id, target_type, target_id, relation_type_id, created_by) VALUES (%L, ''task'', %%L, ''task'', %L, %L, %L)', a, other, rel, u2)),
      ('transition', 'UPDATE tasks SET status = ''in_progress'' WHERE id = %L'),
      ('transition', format('INSERT INTO sla_workflow_operations (task_id, organization_id, before_snapshot, lease_until, status) VALUES (%%L, %L, ''{}'', now(), ''committed'')', a)),
      ('has_links', format('INSERT INTO plan_tasks (plan_id, task_id) VALUES (%L, %%L)', plan1)),
      ('has_links', format('INSERT INTO form_builder_submissions (form_id, organization_id, space_id, task_id) VALUES (%L, %L, %L, %%L)', form, a, s1)),
      ('has_links', format('INSERT INTO support_requests (organization_id, space_id, created_by, ticket_number, subject, category, description, task_id) VALUES (%L, %L, %L, floor(random() * 1000000000)::bigint + 90000000, ''s'', ''general'', ''d'', %%L)', a, s1, u2)),
      ('has_subtasks', format('INSERT INTO tasks (organization_id, space_id, task_type_id, summary, parent_task_id, created_by, updated_by) VALUES (%L, %L, ''task'', ''by a person'', %%L, %L, %L)', a, s1, u2, u2))
    ) AS x (code, stmt) LOOP
      root := pg_temp.task(a, s1, 'Undo root', u1);
      PERFORM pg_temp.own(run1, 'task', root);
      t := CASE WHEN k = 'subtask' THEN pg_temp.task(a, s1, 'Undo sub', u1, root) ELSE root END;
      IF k = 'subtask' THEN PERFORM pg_temp.own(run1, 'subtask', t); END IF;
      PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, k || ': fresh, nothing in the way');
      EXECUTE format(c.stmt, t);
      PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, now(), run1)) LIKE '%' || c.code || '%',
        k || ': expected ' || c.code || ' from ' || c.stmt);
    END LOOP;

    -- Edited by the invoker only: allowed. Also when the tenant admin presses it.
    root := pg_temp.task(a, s1, 'Undo own edit', u1);
    PERFORM pg_temp.own(run1, 'task', root);
    t := CASE WHEN k = 'subtask' THEN pg_temp.task(a, s1, 'Undo sub', u1, root) ELSE root END;
    IF k = 'subtask' THEN PERFORM pg_temp.own(run1, 'subtask', t); END IF;
    UPDATE tasks SET description = 'mine', priority = 'high', updated_by = u1 WHERE id = t;
    PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, k || ': my own edit is allowed');
    PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u3, now(), run1) = '[]'::jsonb, k || ': the invoker''s edit does not stop the admin');

    -- The admin's own edit does not stop the admin, but someone else's does.
    UPDATE tasks SET priority = 'low', updated_by = u3 WHERE id = t;
    PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u3, now(), run1) = '[]'::jsonb, k || ': the presser''s own edit is allowed');
    PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, now(), run1)) LIKE '%changed_by_other%', k || ': the admin''s edit is someone else''s for the invoker');

    -- An automation that ran.
    root := pg_temp.task(a, s1, 'Undo auto', u1);
    PERFORM pg_temp.own(run1, 'task', root);
    PERFORM pg_temp.automation_run(a, s1, jsonb_build_object('task_id', root));
    PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', root, u1, now(), run1)) = 'automations_ran', k || ': automations_ran');
  END LOOP;
END $$;

-- ---------------------------------------------------------------- task traps
DO $$
DECLARE
  a uuid := 'ad000000-0000-4000-8000-00000000000a';
  u1 uuid := 'ad000000-0000-4000-8000-000000000001';
  u2 uuid := 'ad000000-0000-4000-8000-000000000002';
  s1 uuid := 'ad000000-0000-4000-8000-0000000000e1';
  conv uuid; run1 uuid; t uuid; pg uuid; kid uuid; j jsonb;
BEGIN
  conv := chat_create_group(a, u1, 'Agent Undo IT group 2', ARRAY[u2]);
  run1 := pg_temp.new_run(a, conv, u1);

  -- Creation itself never blocks: its history row, its SLA rows, its outbox row.
  t := pg_temp.task(a, s1, 'Undo: fresh', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  INSERT INTO task_watchers (organization_id, task_id, user_id) VALUES (a, t, u1);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, 'a fresh task, watched by its creator, has no blockers');

  -- TRAP: a page of the same run linking the task is Robert's own work.
  t := pg_temp.task(a, s1, 'Undo: linked by own page', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  pg := pg_temp.page(a, s1, 'Own page', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', pg);
  INSERT INTO wiki_page_links (source_page_id, target_type, target_id, created_by) VALUES (pg, 'task', t, u1);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, 'a link from a page of this run does not block the task');

  -- ... but the same page's link added by a person does.
  t := pg_temp.task(a, s1, 'Undo: person linked it', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  INSERT INTO wiki_page_links (source_page_id, target_type, target_id, created_by) VALUES (pg, 'task', t, u2);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, now(), run1)) = 'has_links', 'a person''s link blocks, even from a page of this run');

  -- A page outside this run blocks.
  t := pg_temp.task(a, s1, 'Undo: other page', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  INSERT INTO wiki_page_links (source_page_id, target_type, target_id, created_by) VALUES (pg_temp.page(a, s1, 'Their page', u2), 'task', t, u2);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, now(), run1)) = 'has_links', 'a page outside this run blocks');

  -- TRAP: things a person hung on the task that the delete would cascade away.
  t := pg_temp.task(a, s1, 'Undo: budget', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  INSERT INTO git_branch_tasks (organization_id, task_id) SELECT a, t WHERE false;
  PERFORM pg_temp.ok(
    (SELECT prosrc LIKE '%git_commit_tasks%' AND prosrc LIKE '%git_pull_request_tasks%' AND prosrc LIKE '%git_branch_tasks%'
        AND prosrc LIKE '%test_cases%' AND prosrc LIKE '%test_sets%' AND prosrc LIKE '%test_plans%'
        AND prosrc LIKE '%test_case_requirement_links%' AND prosrc LIKE '%test_run_defects%'
        AND prosrc LIKE '%resource_budget_entries%' AND prosrc LIKE '%ai_wiki_generations%'
     FROM pg_proc WHERE proname = 'agent_undo_blockers'),
    'the blockers read every table a task delete would take with it');

  -- Every table with a cascading key to tasks is either read by the blockers or listed here as
  -- written with the task itself. A new table fails this check until someone decides.
  PERFORM pg_temp.ok(NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.confrelid = 'public.tasks'::regclass AND c.contype = 'f' AND c.confdeltype = 'c'
      AND c.conrelid::regclass::text NOT IN ('tasks', 'task_watchers', 'task_history', 'task_key_aliases',
        'task_notification_mutes', 'board_issue_ranking', 'workflow_outbox', 'task_reminders',
        'space_template_provisioning_runs')
      AND (SELECT prosrc FROM pg_proc WHERE proname = 'agent_undo_blockers')
          NOT LIKE '%' || c.conrelid::regclass::text || '%'
  ), 'a table cascades from tasks that the blockers do not read');

  -- Undo of a task: its same-run subtask goes with it, and the delete is real.
  t := pg_temp.task(a, s1, 'Undo: parent', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  kid := pg_temp.task(a, s1, 'Undo: kid', u1, t);
  PERFORM pg_temp.own(run1, 'subtask', kid);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, now(), run1) = '[]'::jsonb, 'a same-run subtask does not block its parent');
  j := agent_undo_task(a, kid, u1, now(), run1);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = kid), 'child first');
  j := agent_undo_task(a, t, u1, now(), run1);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = t), 'then the parent');

  -- A blocked same-run subtask blocks its parent, and nothing is deleted.
  t := pg_temp.task(a, s1, 'Undo: parent blocked', u1);
  PERFORM pg_temp.own(run1, 'task', t);
  kid := pg_temp.task(a, s1, 'Undo: kid blocked', u1, t);
  PERFORM pg_temp.own(run1, 'subtask', kid);
  INSERT INTO task_comments (task_id, organization_id, content, created_by) VALUES (kid, a, 'c', u2);
  j := agent_undo_task(a, t, u1, now(), run1);
  PERFORM pg_temp.ok(NOT (j ->> 'deleted')::boolean AND EXISTS (SELECT 1 FROM tasks WHERE id = kid) AND EXISTS (SELECT 1 FROM tasks WHERE id = t),
    'a blocked subtask keeps the parent and itself');
END $$;

-- ---------------------------------------------------------------- page, every blocker
DO $$
DECLARE
  a uuid := 'ad000000-0000-4000-8000-00000000000a';
  u1 uuid := 'ad000000-0000-4000-8000-000000000001';
  u2 uuid := 'ad000000-0000-4000-8000-000000000002';
  u3 uuid := 'ad000000-0000-4000-8000-000000000003';
  s1 uuid := 'ad000000-0000-4000-8000-0000000000e1';
  conv uuid; run1 uuid; pg uuid; proc uuid; kid uuid; c record; j jsonb; other_t uuid;
  rel uuid := gen_random_uuid();
BEGIN
  conv := chat_create_group(a, u1, 'Agent Undo IT group 3', ARRAY[u2]);
  run1 := pg_temp.new_run(a, conv, u1);
  INSERT INTO relation_types (id, organization_id, name, outward_description, inward_description) VALUES (rel, a, 'agent-undo-it-w', 'x', 'y');
  other_t := pg_temp.task(a, s1, 'A task', u2);

  FOR c IN SELECT * FROM (VALUES
    ('changed_by_other', format('UPDATE wiki_pages SET content = ''<p>theirs</p>'', updated_by = %L WHERE id = %%L', u2)),
    ('has_comments', format('INSERT INTO wiki_page_comments (wiki_page_id, content, created_by) VALUES (%%L, ''c'', %L)', u2)),
    ('has_attachments', format('INSERT INTO file_attachments (organization_id, entity_type, entity_id, file_name) VALUES (%L, ''wiki_page'', %%L, ''f'')', a)),
    ('has_relationships', format('INSERT INTO task_relationships (organization_id, source_type, source_id, target_type, target_id, relation_type_id, created_by) VALUES (%L, ''task'', %L, ''wiki_page'', %%L, %L, %L)', a, other_t, rel, u2)),
    ('has_links', format('INSERT INTO wiki_page_links (source_page_id, target_type, target_id, created_by) VALUES (%%L, ''task'', %L, %L)', other_t, u2)),
    ('has_children', format('INSERT INTO wiki_pages (organization_id, space_id, title, slug, content, parent_id, created_by, updated_by) VALUES (%L, %L, ''kid'', ''au-'' || gen_random_uuid(), ''<p>k</p>'', %%L, %L, %L)', a, s1, u2, u2)),
    ('published', 'UPDATE wiki_pages SET is_published = true WHERE id = %L'),
    ('transition', 'UPDATE wiki_pages SET workflow_status = ''in_review'' WHERE id = %L')
  ) AS x (code, stmt) LOOP
    pg := pg_temp.page(a, s1, 'Undo page ' || gen_random_uuid(), u1);
    PERFORM pg_temp.own(run1, 'wiki_page', pg);
    PERFORM pg_temp.ok(agent_undo_blockers(a, 'wiki_page', pg, u1, now(), run1) = '[]'::jsonb, 'page: fresh, nothing in the way');
    EXECUTE format(c.stmt, pg);
    PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'wiki_page', pg, u1, now(), run1)) LIKE '%' || c.code || '%',
      'page: expected ' || c.code || ' from ' || c.stmt || ', got ' || agent_undo_blockers(a, 'wiki_page', pg, u1, now(), run1)::text);
  END LOOP;

  -- An automation that ran.
  pg := pg_temp.page(a, s1, 'Undo page auto', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', pg);
  PERFORM pg_temp.automation_run(a, s1, jsonb_build_object('page_id', pg));
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'wiki_page', pg, u1, now(), run1)) = 'automations_ran', 'page: automations_ran');

  -- My own edit, and a second version by me: allowed, also for the admin.
  pg := pg_temp.page(a, s1, 'Undo page own edit', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', pg);
  UPDATE wiki_pages SET content = '<p>mine</p>', updated_by = u1 WHERE id = pg;
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'wiki_page', pg, u1, now(), run1) = '[]'::jsonb, 'page: my own edit is allowed');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'wiki_page', pg, u3, now(), run1) = '[]'::jsonb, 'page: the invoker''s edit does not stop the admin');

  -- TRAP: Robert's link to a process of this run does not block the page.
  proc := pg_temp.process(a, s1, 'Undo proc for page', u1);
  PERFORM pg_temp.own(run1, 'process', proc);
  pg := pg_temp.page(a, s1, 'Undo page linked by Robert', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', pg);
  INSERT INTO wiki_page_links (source_page_id, target_type, target_id, created_by) VALUES (pg, 'process', proc, u1);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'wiki_page', pg, u1, now(), run1) = '[]'::jsonb, 'page: Robert''s process link does not block');

  -- A link to a process outside this run, or one a person added, does.
  pg := pg_temp.page(a, s1, 'Undo page person link', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', pg);
  INSERT INTO wiki_page_links (source_page_id, target_type, target_id, created_by) VALUES (pg, 'process', proc, u2);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'wiki_page', pg, u1, now(), run1)) = 'has_links', 'page: a person''s link to the process blocks');
  pg := pg_temp.page(a, s1, 'Undo page outside link', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', pg);
  INSERT INTO wiki_page_links (source_page_id, target_type, target_id, created_by) VALUES (pg, 'process', pg_temp.process(a, s1, 'Their process', u2), u1);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'wiki_page', pg, u1, now(), run1)) = 'has_links', 'page: a link to a process outside this run blocks');

  -- Undo archives, removes Robert's link, and the page reads as gone.
  pg := pg_temp.page(a, s1, 'Undo page to archive', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', pg);
  INSERT INTO wiki_page_links (source_page_id, target_type, target_id, created_by) VALUES (pg, 'process', proc, u1);
  j := agent_undo_wiki_page(a, pg, u1, now(), run1);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean, 'page: undo reports done');
  PERFORM pg_temp.ok((SELECT is_archived FROM wiki_pages WHERE id = pg), 'page: archived, not removed');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM wiki_page_links WHERE source_page_id = pg), 'page: Robert''s link is gone with it');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'wiki_page', pg, u1, now(), run1)) = 'gone', 'page: an archived page is gone');

  -- Blocked: nothing changes.
  pg := pg_temp.page(a, s1, 'Undo page blocked', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', pg);
  INSERT INTO wiki_page_comments (wiki_page_id, content, created_by) VALUES (pg, 'c', u2);
  j := agent_undo_wiki_page(a, pg, u1, now(), run1);
  PERFORM pg_temp.ok(NOT (j ->> 'deleted')::boolean AND pg_temp.codes(j -> 'blockers') = 'has_comments'
    AND (SELECT is_archived IS NOT TRUE FROM wiki_pages WHERE id = pg), 'page: a blocked page stays as it was');

  -- Same-run child page first, then the parent.
  pg := pg_temp.page(a, s1, 'Undo page parent', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', pg);
  kid := pg_temp.page(a, s1, 'Undo page kid', u1, pg);
  PERFORM pg_temp.own(run1, 'wiki_page', kid);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'wiki_page', pg, u1, now(), run1) = '[]'::jsonb, 'page: a same-run child does not block');
  j := agent_undo_wiki_page(a, kid, u1, now(), run1);
  j := agent_undo_wiki_page(a, pg, u1, now(), run1);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean, 'page: child, then parent');

  -- A page of another run is not this run's to undo.
  pg := pg_temp.page(a, s1, 'Not of this run', u1);
  PERFORM pg_temp.own(pg_temp.new_run(a, conv, u1), 'wiki_page', pg);
  BEGIN
    j := agent_undo_wiki_page(a, pg, u1, now(), run1);
    RAISE EXCEPTION 'CHECK FAILED: a page outside the run was accepted';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
END $$;

-- ---------------------------------------------------------------- process, every blocker
DO $$
DECLARE
  a uuid := 'ad000000-0000-4000-8000-00000000000a';
  b uuid := 'ad000000-0000-4000-8000-00000000000b';
  u1 uuid := 'ad000000-0000-4000-8000-000000000001';
  u2 uuid := 'ad000000-0000-4000-8000-000000000002';
  u3 uuid := 'ad000000-0000-4000-8000-000000000003';
  s1 uuid := 'ad000000-0000-4000-8000-0000000000e1';
  conv uuid; run1 uuid; p uuid; kid uuid; t uuid; j jsonb; c record; other_p uuid; n int; prev uuid; ids uuid[] := '{}'; pg uuid;
BEGIN
  conv := chat_create_group(a, u1, 'Agent Undo IT group 4', ARRAY[u2]);
  run1 := pg_temp.new_run(a, conv, u1);
  other_p := pg_temp.process(a, s1, 'A process of someone else', u2);

  p := pg_temp.process(a, s1, 'Undo proc fresh', u1);
  PERFORM pg_temp.own(run1, 'process', p);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'process', p, u1, now(), run1) = '[]'::jsonb, 'process: fresh, nothing in the way');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'process', gen_random_uuid(), u1, now(), run1)) = 'gone', 'process: unknown is gone');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(b, 'process', p, u1, now(), run1)) = 'gone', 'process: another organization reads it as gone');

  FOR c IN SELECT * FROM (VALUES
    ('changed_by_other', format('UPDATE business_processes SET description = ''x'', updated_by = %L WHERE id = %%L', u2)),
    ('changed_by_other', format('INSERT INTO audit_logs (organization_id, user_id, entity_type, entity_id, action) VALUES (%L, %L, ''business_process'', %%L, ''update'')', a, u2)),
    ('has_comments', format('INSERT INTO process_comments (process_id, organization_id, content, created_by) VALUES (%%L, %L, ''c'', %L)', a, u2)),
    ('has_attachments', format('INSERT INTO process_attachments (process_id, organization_id, file_name, file_path, uploaded_by) VALUES (%%L, %L, ''f'', ''x/f'', %L)', a, u2)),
    ('has_diagram', format('INSERT INTO process_diagrams (process_id, organization_id, xml, created_by, updated_by) VALUES (%%L, %L, ''<x/>'', %L, %L)', a, u2, u2)),
    ('has_relationships', format('INSERT INTO process_relationships (organization_id, parent_process_id, child_process_id, relationship_type) VALUES (%L, %%L, %L, ''contains'')', a, other_p)),
    ('has_tasks', format('INSERT INTO tasks (organization_id, space_id, task_type_id, summary, process_id, created_by, updated_by) VALUES (%L, %L, ''task'', ''by a person'', %%L, %L, %L)', a, s1, u2, u2)),
    ('has_children', format('INSERT INTO business_processes (organization_id, space_id, title, request_type, parent_id, created_by, updated_by) VALUES (%L, %L, ''kid'', ''Assetbewertung'', %%L, %L, %L)', a, s1, u2, u2)),
    ('has_links', format('INSERT INTO wiki_page_links (source_page_id, target_type, target_id, created_by) VALUES (%L, ''process'', %%L, %L)', pg_temp.page(a, s1, 'Their page', u2), u2))
  ) AS x (code, stmt) LOOP
    p := pg_temp.process(a, s1, 'Undo proc', u1);
    PERFORM pg_temp.own(run1, 'process', p);
    EXECUTE format(c.stmt, p);
    PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'process', p, u1, now(), run1)) LIKE '%' || c.code || '%',
      'process: expected ' || c.code || ', got ' || agent_undo_blockers(a, 'process', p, u1, now(), run1)::text);
    j := agent_undo_process(a, p, u1, now(), run1);
    PERFORM pg_temp.ok(NOT (j ->> 'deleted')::boolean AND EXISTS (SELECT 1 FROM business_processes WHERE id = p), 'process: blocked stays');
  END LOOP;

  -- An automation that ran.
  p := pg_temp.process(a, s1, 'Undo proc auto', u1);
  PERFORM pg_temp.own(run1, 'process', p);
  PERFORM pg_temp.automation_run(a, s1, jsonb_build_object('process', jsonb_build_object('id', p)));
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'process', p, u1, now(), run1)) = 'automations_ran', 'process: automations_ran');

  -- My own edit: allowed, also for the admin.
  p := pg_temp.process(a, s1, 'Undo proc own edit', u1);
  PERFORM pg_temp.own(run1, 'process', p);
  UPDATE business_processes SET description = 'mine', updated_by = u1 WHERE id = p;
  INSERT INTO audit_logs (organization_id, user_id, entity_type, entity_id, action) VALUES (a, u1, 'business_process', p, 'update');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'process', p, u1, now(), run1) = '[]'::jsonb, 'process: my own edit is allowed');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'process', p, u3, now(), run1) = '[]'::jsonb, 'process: the invoker''s edit does not stop the admin');

  -- A task a person added: blocked, and that task is NEVER deleted.
  p := pg_temp.process(a, s1, 'Undo proc with their task', u1);
  PERFORM pg_temp.own(run1, 'process', p);
  t := gen_random_uuid();
  INSERT INTO tasks (id, organization_id, space_id, task_type_id, summary, process_id, created_by, updated_by) VALUES (t, a, s1, 'task', 'mine', p, u2, u2);
  j := agent_undo_process(a, p, u1, now(), run1);
  PERFORM pg_temp.ok(NOT (j ->> 'deleted')::boolean AND pg_temp.codes(j -> 'blockers') = 'has_tasks', 'process: their task blocks');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM tasks WHERE id = t) AND EXISTS (SELECT 1 FROM business_processes WHERE id = p), 'process: their task and the process stay');

  -- A task of the same run: not a blocker for the card, but the delete refuses while it stands,
  -- so the cascade can never take a task. Children first.
  p := pg_temp.process(a, s1, 'Undo proc with own task', u1);
  PERFORM pg_temp.own(run1, 'process', p);
  t := gen_random_uuid();
  INSERT INTO tasks (id, organization_id, space_id, task_type_id, summary, process_id, created_by, updated_by) VALUES (t, a, s1, 'task', 'own', p, u1, u1);
  PERFORM pg_temp.own(run1, 'task', t);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'process', p, u1, now(), run1) = '[]'::jsonb, 'process: a clean task of this run does not block the card');
  j := agent_undo_process(a, p, u1, now(), run1);
  PERFORM pg_temp.ok(NOT (j ->> 'deleted')::boolean AND EXISTS (SELECT 1 FROM tasks WHERE id = t), 'process: the last guard: no delete while a task stands');
  j := agent_undo_task(a, t, u1, now(), run1);
  j := agent_undo_process(a, p, u1, now(), run1);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM business_processes WHERE id = p), 'process: task first, then the process');

  -- A blocked task of the same run blocks the process.
  p := pg_temp.process(a, s1, 'Undo proc blocked by task', u1);
  PERFORM pg_temp.own(run1, 'process', p);
  t := gen_random_uuid();
  INSERT INTO tasks (id, organization_id, space_id, task_type_id, summary, process_id, created_by, updated_by) VALUES (t, a, s1, 'task', 'own', p, u1, u1);
  PERFORM pg_temp.own(run1, 'task', t);
  INSERT INTO task_comments (task_id, organization_id, content, created_by) VALUES (t, a, 'c', u2);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'process', p, u1, now(), run1)) = 'has_tasks', 'process: a blocked task of this run blocks it');

  -- A child of the same run, and one a person added.
  p := pg_temp.process(a, s1, 'Undo proc parent', u1);
  PERFORM pg_temp.own(run1, 'process', p);
  kid := pg_temp.process(a, s1, 'Undo proc kid', u1, p);
  PERFORM pg_temp.own(run1, 'process', kid);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'process', p, u1, now(), run1) = '[]'::jsonb, 'process: a clean child of this run does not block the card');
  j := agent_undo_process(a, p, u1, now(), run1);
  PERFORM pg_temp.ok(NOT (j ->> 'deleted')::boolean AND EXISTS (SELECT 1 FROM business_processes WHERE id = kid), 'process: the last guard: no delete while a child stands');
  j := agent_undo_process(a, kid, u1, now(), run1);
  j := agent_undo_process(a, p, u1, now(), run1);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean, 'process: child, then parent');

  p := pg_temp.process(a, s1, 'Undo proc parent 2', u1);
  PERFORM pg_temp.own(run1, 'process', p);
  kid := pg_temp.process(a, s1, 'Undo proc their kid', u2, p);
  j := agent_undo_process(a, p, u1, now(), run1);
  PERFORM pg_temp.ok(NOT (j ->> 'deleted')::boolean AND pg_temp.codes(j -> 'blockers') = 'has_children' AND EXISTS (SELECT 1 FROM business_processes WHERE id = kid), 'process: their child blocks and stays');

  -- TRAP from a real run: creating a child also writes a parent_child row. That is the tree itself.
  p := pg_temp.process(a, s1, 'Undo proc parent 3', u1);
  PERFORM pg_temp.own(run1, 'process', p);
  kid := pg_temp.process(a, s1, 'Undo proc kid 3', u1, p);
  PERFORM pg_temp.own(run1, 'process', kid);
  INSERT INTO process_relationships (organization_id, parent_process_id, child_process_id, relationship_type) VALUES (a, p, kid, 'parent_child');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'process', kid, u1, now(), run1) = '[]'::jsonb, 'process: the row of its own place in the tree does not block the child');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'process', p, u1, now(), run1) = '[]'::jsonb, 'process: nor the parent');
  j := agent_undo_process(a, kid, u1, now(), run1);
  j := agent_undo_process(a, p, u1, now(), run1);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean, 'process: and both go');
  -- A child of this run under an older process goes too: that row is its place in the tree as well.
  p := pg_temp.process(a, s1, 'Undo proc kid of older', u1, other_p);
  PERFORM pg_temp.own(run1, 'process', p);
  INSERT INTO process_relationships (organization_id, parent_process_id, child_process_id, relationship_type) VALUES (a, other_p, p, 'parent_child');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'process', p, u1, now(), run1) = '[]'::jsonb, 'process: its row under an older parent does not block');
  -- A relationship a person added between two processes outside the tree does.
  p := pg_temp.process(a, s1, 'Undo proc related', u1);
  PERFORM pg_temp.own(run1, 'process', p);
  INSERT INTO process_relationships (organization_id, parent_process_id, child_process_id, relationship_type) VALUES (a, other_p, p, 'parent_child');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'process', p, u1, now(), run1)) = 'has_relationships', 'process: a relationship that is not its place in the tree blocks');

  -- A page of the same run linked to the process: it does not block, and its link goes too.
  p := pg_temp.process(a, s1, 'Undo proc with page', u1);
  PERFORM pg_temp.own(run1, 'process', p);
  pg := pg_temp.page(a, s1, 'Own page of proc', u1);
  PERFORM pg_temp.own(run1, 'wiki_page', pg);
  INSERT INTO wiki_page_links (source_page_id, target_type, target_id, created_by) VALUES (pg, 'process', p, u1);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'process', p, u1, now(), run1) = '[]'::jsonb, 'process: Robert''s page link does not block');
  j := agent_undo_process(a, p, u1, now(), run1);
  PERFORM pg_temp.ok((j ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM wiki_page_links WHERE target_id = p), 'process: no dead link stays');

  -- A stored calculation is someone's work on it, and the delete would take it along.
  p := pg_temp.process(a, s1, 'Undo proc calculated', u1);
  PERFORM pg_temp.own(run1, 'process', p);
  INSERT INTO calculation_results (organization_id, business_process_id, calculated_values) VALUES (a, p, '{}');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'process', p, u1, now(), run1)) = 'has_links', 'process: a stored calculation blocks');

  -- A 6-level tree of one plan clears bottom up.
  prev := NULL;
  FOR n IN 1..6 LOOP
    p := pg_temp.process(a, s1, 'Level ' || n, u1, prev);
    PERFORM pg_temp.own(run1, 'process', p);
    ids := ids || p;
    prev := p;
  END LOOP;
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'process', ids[1], u1, now(), run1) = '[]'::jsonb, 'process: the top of a clean 6-level tree has no blockers');
  FOR n IN REVERSE 6..1 LOOP
    j := agent_undo_process(a, ids[n], u1, now(), run1);
    PERFORM pg_temp.ok((j ->> 'deleted')::boolean, 'process: level ' || n || ' goes');
  END LOOP;
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM business_processes WHERE id = ANY (ids)), 'process: the tree is gone');

  -- A process of another run is not this run's to undo.
  PERFORM pg_temp.own(pg_temp.new_run(a, conv, u1), 'process', other_p);
  BEGIN
    j := agent_undo_process(a, other_p, u1, now(), run1);
    RAISE EXCEPTION 'CHECK FAILED: a process outside the run was accepted';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
END $$;

-- ---------------------------------------------------------------- claim, complete, state, types
DO $$
DECLARE
  a uuid := 'ad000000-0000-4000-8000-00000000000a';
  u1 uuid := 'ad000000-0000-4000-8000-000000000001';
  u2 uuid := 'ad000000-0000-4000-8000-000000000002';
  u3 uuid := 'ad000000-0000-4000-8000-000000000003';
  s1 uuid := 'ad000000-0000-4000-8000-0000000000e1';
  conv uuid; run1 uuid; run2 uuid; t uuid; t2 uuid; act uuid; act2 uuid; sp_act uuid; tok uuid; r jsonb; n int; j jsonb;
BEGIN
  conv := chat_create_group(a, u1, 'Agent Undo IT group 5', ARRAY[u2]);
  run1 := pg_temp.new_run(a, conv, u1);
  t := pg_temp.task(a, s1, 'Claim me', u1);
  act := pg_temp.own(run1, 'task', t);
  INSERT INTO agent_object_origins (organization_id, entity_type, entity_id, action_id, run_id, conversation_id, trigger_message_id, invoker_id, confirmer_id)
  SELECT a, 'task', t, act, run1, conv, r.trigger_message_id, u1, u1 FROM agent_runs r WHERE r.id = run1;

  -- Space and member kinds cannot be claimed in this release.
  sp_act := pg_temp.own(run1, 'space', s1);
  SELECT count(*) INTO n FROM agent_claim_undo(a, u1, false, ARRAY[sp_act]);
  PERFORM pg_temp.ok(n = 0, 'claim: a space is not claimed');

  -- Someone else: nothing. Expired: nothing.
  SELECT count(*) INTO n FROM agent_claim_undo(a, u2, false, ARRAY[act]);
  PERFORM pg_temp.ok(n = 0, 'claim: another member gets nothing');
  UPDATE agent_actions SET undo_until = now() - interval '1 second' WHERE id = act;
  SELECT count(*) INTO n FROM agent_claim_undo(a, u1, false, ARRAY[act]);
  PERFORM pg_temp.ok(n = 0, 'claim: expired');
  UPDATE agent_actions SET undo_until = NULL WHERE id = act;
  SELECT count(*) INTO n FROM agent_claim_undo(a, u1, false, ARRAY[act]);
  PERFORM pg_temp.ok(n = 0, 'claim: an old action without a window');
  UPDATE agent_actions SET undo_until = now() + interval '1 minute' WHERE id = act;

  -- A Confirm running in the same run: refused, so a delete can't take a child being created.
  UPDATE agent_actions SET status = 'executing', exec_token = gen_random_uuid(), exec_started_at = now() WHERE id = sp_act;
  SELECT count(*) INTO n FROM agent_claim_undo(a, u1, false, ARRAY[act]);
  PERFORM pg_temp.ok(n = 0, 'claim: refused while something of the run is executing');
  UPDATE agent_actions SET status = 'executed', exec_token = NULL WHERE id = sp_act;

  -- The tenant admin, and only one claim wins.
  SELECT exec_token INTO tok FROM agent_claim_undo(a, u3, true, ARRAY[act]);
  PERFORM pg_temp.ok(tok IS NOT NULL, 'claim: the tenant admin claims');
  SELECT count(*) INTO n FROM agent_claim_undo(a, u1, false, ARRAY[act]);
  PERFORM pg_temp.ok(n = 0, 'claim: a second claim gets nothing');

  -- Wrong token: nothing happens.
  r := agent_complete_undo(act, gen_random_uuid(), 'undone', NULL, NULL, u3);
  PERFORM pg_temp.ok(NOT (r ->> 'completed')::boolean, 'complete: a wrong token does nothing');

  -- Blocked: back to executed with the reason.
  r := agent_complete_undo(act, tok, 'blocked', 'has_comments', '{"count": 1}'::jsonb, u3);
  PERFORM pg_temp.ok((SELECT status = 'executed' AND reason = 'has_comments' AND undone_by IS NULL FROM agent_actions WHERE id = act), 'complete: blocked goes back');

  -- Undone: who and when, audit pointing at the original, and THE ORIGIN ROW STAYS.
  INSERT INTO agent_audit_events (organization_id, event, run_id, action_id, conversation_id, actor_id, entity_type, entity_id, data)
  VALUES (a, 'action.executed', run1, act, conv, u1, 'task', t, '{}');
  SELECT exec_token INTO tok FROM agent_claim_undo(a, u3, true, ARRAY[act]);
  r := agent_complete_undo(act, tok, 'undone', NULL, NULL, u3);
  PERFORM pg_temp.ok((SELECT status = 'undone' AND undone_by = u3 AND undone_at IS NOT NULL AND reason IS NULL FROM agent_actions WHERE id = act), 'complete: undone by the admin');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM agent_object_origins WHERE entity_id = t), 'complete: the origin row stays for audit');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM agent_audit_events e WHERE e.action_id = act AND e.event = 'action.undone' AND e.actor_id = u3 AND (e.data ->> 'ref_seq') IS NOT NULL), 'complete: its own audit, pointing at the original');

  -- The state for the card: one row per asked action, its blockers, only live actions.
  run2 := pg_temp.new_run(a, conv, u1);
  t2 := pg_temp.task(a, s1, 'State me', u1);
  act2 := pg_temp.own(run2, 'task', t2);
  INSERT INTO task_comments (task_id, organization_id, content, created_by) VALUES (t2, a, 'c', u2);
  SELECT b.blockers INTO j FROM agent_undo_state(a, u1, ARRAY[act2, act]) b WHERE b.action_id = act2;
  PERFORM pg_temp.ok(pg_temp.codes(j) = 'has_comments', 'state: says what blocks');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_undo_state(a, u1, ARRAY[act2, act])) = 1, 'state: an undone action is not read');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_undo_state('ad000000-0000-4000-8000-00000000000b', u1, ARRAY[act2])) = 0, 'state: another organization reads nothing');

  -- The grants: service role only.
  PERFORM pg_temp.ok(NOT has_function_privilege('authenticated', p.oid, 'execute') AND NOT has_function_privilege('anon', p.oid, 'execute')
    AND has_function_privilege('service_role', p.oid, 'execute'), 'grants: ' || p.proname)
  FROM pg_proc p WHERE p.proname IN ('agent_undo_process', 'agent_undo_wiki_page', 'agent_undo_state', 'agent_undo_blockers', 'agent_claim_undo', 'agent_complete_undo');
END $$;

\echo agent undo integration: all checks passed
ROLLBACK;
