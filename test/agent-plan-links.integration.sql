-- XE-T353 Robert 1.22.1: existing tasks into plans (plan_link) and dependencies between plan items.
-- Run only against a confirmed disposable database (local Supabase) with migration
-- 20261113120000_agent_plan_links applied. Everything is rolled back; it makes its own data:
--   psql -f test/agent-plan-links.integration.sql
-- Success prints "agent plan links integration: all checks passed"; any failure aborts with the reason.
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

-- An executed action of the run, with its reserved id as entity id.
CREATE FUNCTION pg_temp.own(p_run uuid, p_kind text, p_entity uuid) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO agent_actions (organization_id, run_id, ordinal, kind, status, intent, entity_type, entity_id,
    executed_at, undo_until, expires_at, confirmed_by)
  SELECT r.organization_id, r.id,
         (SELECT coalesce(max(a.ordinal), 0) + 1 FROM agent_actions a WHERE a.run_id = r.id),
         p_kind, 'executed', '{}'::jsonb,
         CASE WHEN p_kind IN ('task', 'subtask', 'plan_item') THEN 'task' ELSE p_kind END,
         p_entity, now(), now() + interval '10 minutes', now() + interval '24 hours', r.invoker_id
  FROM agent_runs r WHERE r.id = p_run
  RETURNING id;
$$;

CREATE FUNCTION pg_temp.task(p_org uuid, p_space uuid, p_summary text, p_creator uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO tasks (id, organization_id, space_id, task_type_id, summary, created_by, updated_by)
  VALUES (v_id, p_org, p_space, 'task', p_summary, p_creator, p_creator);
  RETURN v_id;
END $$;

INSERT INTO organizations (id, name, slug, size) VALUES
  ('ad000000-0000-4000-8000-00000000000a', 'Agent Links IT A', 'agent-links-it-a', '1-10');
INSERT INTO users (id, email, first_name, last_name, is_active) VALUES
  ('ad000000-0000-4000-8000-000000000001', 'agent-links-it-u1@example.invalid', 'Anna', 'Invoker', true),
  ('ad000000-0000-4000-8000-000000000002', 'agent-links-it-u2@example.invalid', 'Markus', 'Other', true);
INSERT INTO organization_members (organization_id, user_id, role) VALUES
  ('ad000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-000000000001', 'member'),
  ('ad000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-000000000002', 'member');
INSERT INTO spaces (id, organization_id, name, key) VALUES
  ('ad000000-0000-4000-8000-0000000000e1', 'ad000000-0000-4000-8000-00000000000a', 'Agent Links IT', 'AGLNK1'),
  ('ad000000-0000-4000-8000-0000000000e2', 'ad000000-0000-4000-8000-00000000000a', 'Agent Links IT Two', 'AGLNK2');

DO $$
DECLARE
  a uuid := 'ad000000-0000-4000-8000-00000000000a';
  u1 uuid := 'ad000000-0000-4000-8000-000000000001';
  u2 uuid := 'ad000000-0000-4000-8000-000000000002';
  s1 uuid := 'ad000000-0000-4000-8000-0000000000e1';
  s2 uuid := 'ad000000-0000-4000-8000-0000000000e2';
  c uuid; r uuid; p uuid; p2 uuid;
  person uuid; other_space uuid; build uuid; pen uuid; golive uuid; x uuid;
  link uuid := gen_random_uuid(); link2 uuid := gen_random_uuid();
  act_link uuid; act_pen uuid; res jsonb; before_row text; fs uuid;
  since timestamptz := now() - interval '1 minute';
BEGIN
  c := chat_create_group(a, u1, 'Agent Links IT', ARRAY[u2]);
  r := pg_temp.new_run(a, c, u1);
  p := gen_random_uuid();
  INSERT INTO plans (id, organization_id, space_id, name, created_by, status) VALUES (p, a, s1, 'Q4 Security', u2, 'active');
  p2 := gen_random_uuid();
  INSERT INTO plans (id, organization_id, space_id, name, created_by, status) VALUES (p2, a, s1, 'Other plan', u2, 'active');

  -- ------------------------------------------------------------ kinds
  person := pg_temp.task(a, s1, 'XE-T353 person task', u2);
  act_link := pg_temp.own(r, 'plan_link', link);
  PERFORM pg_temp.ok((SELECT entity_type FROM agent_actions WHERE id = act_link) = 'plan_link', 'a link is entity plan_link');
  INSERT INTO agent_object_origins (organization_id, entity_type, entity_id, action_id, run_id, conversation_id,
    trigger_message_id, invoker_id, confirmer_id)
  SELECT a, 'plan_link', link, act_link, r, c, ru.trigger_message_id, u1, u1 FROM agent_runs ru WHERE ru.id = r;

  -- ------------------------------------------------------------ agent_plan_link_add
  SELECT row(t.*)::text INTO before_row FROM tasks t WHERE t.id = person;
  res := agent_plan_link_add(a, p, person, link, 'task');
  PERFORM pg_temp.ok((res ->> 'linked')::boolean AND NOT (res ->> 'adopted')::boolean, 'linked: ' || res::text);
  PERFORM pg_temp.ok((SELECT id FROM plan_tasks WHERE plan_id = p AND task_id = person) = link, 'the row has the reserved id');
  PERFORM pg_temp.ok((SELECT row(t.*)::text FROM tasks t WHERE t.id = person) = before_row, 'the task is not touched');
  res := agent_plan_link_add(a, p, person, link, 'task');
  PERFORM pg_temp.ok((res ->> 'adopted')::boolean, 'a retry adopts its own row');
  res := agent_plan_link_add(a, p, person, gen_random_uuid(), 'task');
  PERFORM pg_temp.ok(res ->> 'reason' = 'already_in_plan', 'someone else''s row: already in the plan');
  -- In another plan as well: allowed, a task may be in several plans.
  res := agent_plan_link_add(a, p2, person, link2, 'task');
  PERFORM pg_temp.ok((res ->> 'linked')::boolean, 'in a second plan too');
  DELETE FROM plan_tasks WHERE id = link2;
  other_space := pg_temp.task(a, s2, 'Elsewhere', u2);
  BEGIN
    PERFORM agent_plan_link_add(a, p, other_space, gen_random_uuid(), 'task');
    PERFORM pg_temp.ok(false, 'a task of another space must be refused');
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
  UPDATE plans SET is_archived = true WHERE id = p2;
  BEGIN
    PERFORM agent_plan_link_add(a, p2, other_space, gen_random_uuid(), 'task');
    PERFORM pg_temp.ok(false, 'an archived plan must be refused');
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  UPDATE plans SET is_archived = false WHERE id = p2;

  -- ------------------------------------------------------------ link Undo blockers
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_link', link, u1, since, r)) = '', 'a fresh link: none');
  -- The owner edits the task, comments, attaches: none of it blocks the link Undo.
  UPDATE tasks SET summary = 'XE-T353 renamed', updated_by = u2 WHERE id = person;
  INSERT INTO task_comments (task_id, organization_id, created_by, content) VALUES (person, a, u2, 'hi');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_link', link, u1, since, r)) = '', 'the task''s own edits do not block');
  -- Someone moved it in the plan, or reordered the plan.
  INSERT INTO audit_logs (organization_id, user_id, action, entity_type, entity_id) VALUES (a, u2, 'move', 'plan_item', person);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_link', link, u1, since, r)) = 'moved_in_plan', 'a move blocks');
  DELETE FROM audit_logs WHERE entity_id = person AND action = 'move';
  INSERT INTO audit_logs (organization_id, user_id, action, entity_type, entity_id) VALUES (a, u2, 'reorder', 'plan_item', p);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_link', link, u1, since, r)) = 'moved_in_plan', 'a reorder blocks');
  DELETE FROM audit_logs WHERE entity_id = p AND action = 'reorder';
  -- A baseline since.
  INSERT INTO plan_baselines (plan_id, name, snapshot_data, created_by) VALUES (p, 'B', '{}', u2);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_link', link, u1, since, r)) = 'baseline_taken', 'a baseline blocks');
  DELETE FROM plan_baselines WHERE plan_id = p;

  -- ------------------------------------------------------------ dependencies
  build := pg_temp.task(a, s1, 'Build', u2);
  INSERT INTO plan_tasks (plan_id, task_id, item_type, sort_order) VALUES (p, build, 'phase', 5);
  pen := pg_temp.task(a, s1, 'Pen test', u1);
  INSERT INTO plan_tasks (plan_id, task_id, item_type, sort_order) VALUES (p, pen, 'phase', 6);
  act_pen := pg_temp.own(r, 'plan_item', pen);

  res := agent_plan_dependency_add(a, p, act_pen, build, pen, 'Finish to Start');
  PERFORM pg_temp.ok((res ->> 'created')::boolean AND NOT (res ->> 'adopted')::boolean, 'FS created: ' || res::text);
  PERFORM pg_temp.ok((SELECT created_rows ? (res ->> 'id') FROM agent_actions WHERE id = act_pen), 'the row is on the card');
  PERFORM pg_temp.ok((SELECT created_by FROM task_relationships WHERE id = (res ->> 'id')::uuid) = u1, 'written as the confirmer');
  PERFORM pg_temp.ok((agent_plan_dependency_add(a, p, act_pen, build, pen, 'Finish to Start') ->> 'adopted')::boolean, 'retry adopts');
  PERFORM pg_temp.ok(agent_plan_dependency_add(a, p, gen_random_uuid(), build, pen, 'Finish to Start') ->> 'reason' = 'dependency_exists',
    'someone else''s same dependency: exists');
  PERFORM pg_temp.ok(agent_plan_dependency_add(a, p, act_pen, pen, pen, 'Start to Start') ->> 'reason' = 'dependency_self', 'to itself');
  PERFORM pg_temp.ok(agent_plan_dependency_add(a, p, act_pen, other_space, pen, 'Start to Start') ->> 'reason' = 'dependency_end_gone',
    'an end not in the plan');
  -- All four types by name.
  PERFORM pg_temp.ok((agent_plan_dependency_add(a, p, act_pen, build, pen, 'Start to Start') ->> 'created')::boolean, 'SS');
  PERFORM pg_temp.ok((agent_plan_dependency_add(a, p, act_pen, build, pen, 'Finish to Finish') ->> 'created')::boolean, 'FF');
  PERFORM pg_temp.ok((agent_plan_dependency_add(a, p, act_pen, build, pen, 'Start to Finish') ->> 'created')::boolean, 'SF');
  -- A cycle of three through an existing (a person's) dependency: Pen -> Go-live (person), Go-live -> Build?
  golive := pg_temp.task(a, s1, 'Go-live', u2);
  INSERT INTO plan_tasks (plan_id, task_id, item_type, sort_order) VALUES (p, golive, 'milestone', 7);
  SELECT id INTO fs FROM relation_types WHERE organization_id = a AND name = 'Finish to Start';
  INSERT INTO task_relationships (organization_id, source_type, source_id, target_type, target_id, relation_type_id, created_by)
  VALUES (a, 'task', pen, 'task', golive, fs, u2);
  PERFORM pg_temp.ok(agent_plan_dependency_add(a, p, act_pen, golive, build, 'Finish to Start') ->> 'reason' = 'dependency_cycle',
    'build -> pen -> go-live -> build is a cycle');
  -- Relation type missing, and doubled (another case of the same name).
  UPDATE relation_types SET name = 'FS renamed' WHERE id = fs;
  PERFORM pg_temp.ok(agent_plan_dependency_add(a, p, act_pen, golive, pen, 'Finish to Start') ->> 'reason' = 'relation_type_missing',
    'a renamed type is missing');
  UPDATE relation_types SET name = 'Finish to Start' WHERE id = fs;
  INSERT INTO relation_types (organization_id, name, outward_description, inward_description) VALUES (a, 'finish to start', 'x', 'y');
  PERFORM pg_temp.ok(agent_plan_dependency_add(a, p, act_pen, golive, pen, 'Finish to Start') ->> 'reason' = 'relation_type_ambiguous',
    'two of one name');
  DELETE FROM relation_types WHERE organization_id = a AND name = 'finish to start';

  -- ------------------------------------------------------------ item Undo with Robert's dependencies
  -- Robert's rows do not block; a person's dependency does.
  DELETE FROM task_relationships WHERE source_id = pen AND target_id = golive;
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', pen, u1, since, r)) = '', 'own dependencies: none');
  INSERT INTO task_relationships (organization_id, source_type, source_id, target_type, target_id, relation_type_id, created_by)
  VALUES (a, 'task', golive, 'task', pen, fs, u2);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', pen, u1, since, r)) = 'has_relationships', 'a person''s dependency blocks');
  DELETE FROM task_relationships WHERE source_id = golive AND target_id = pen;
  -- The link Undo also sees a person's dependency to the linked task, not Robert's.
  INSERT INTO task_relationships (organization_id, source_type, source_id, target_type, target_id, relation_type_id, created_by)
  VALUES (a, 'task', person, 'task', golive, fs, u2);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_link', link, u1, since, r)) = 'has_relationships',
    'a person''s dependency to the linked task blocks its link Undo');
  DELETE FROM task_relationships WHERE source_id = person;

  res := agent_undo_plan_item(a, pen, u1, since, r);
  PERFORM pg_temp.ok((res ->> 'deleted')::boolean, 'the item goes: ' || res::text);
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM task_relationships WHERE source_id = pen OR target_id = pen), 'its dependencies go with it');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM tasks WHERE id = build) AND EXISTS (SELECT 1 FROM tasks WHERE id = golive),
    'the existing items stay');

  -- ------------------------------------------------------------ plan Undo with a link of the run
  x := gen_random_uuid();
  INSERT INTO plans (id, organization_id, space_id, name, created_by, status) VALUES (x, a, s1, 'Robert plan', u1, 'draft');
  INSERT INTO plan_permissions (plan_id, user_id, permission_level) VALUES (x, u1, 'admin');
  PERFORM pg_temp.own(r, 'plan', x);
  link2 := gen_random_uuid();
  PERFORM pg_temp.own(r, 'plan_link', link2);
  PERFORM agent_plan_link_add(a, x, build, link2, 'task');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', x, u1, since, r)) = '', 'a clean link of the run: the plan can go');
  INSERT INTO audit_logs (organization_id, user_id, action, entity_type, entity_id) VALUES (a, u2, 'move', 'plan_item', build);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', x, u1, since, r)) = 'has_items', 'a link someone moved keeps the plan');
  DELETE FROM audit_logs WHERE entity_id = build AND action = 'move';

  -- ------------------------------------------------------------ link Undo
  -- Blocked: someone moved it; the row stays.
  INSERT INTO audit_logs (organization_id, user_id, action, entity_type, entity_id) VALUES (a, u2, 'move', 'plan_item', person);
  res := agent_undo_plan_link(a, link, u1, since, r);
  PERFORM pg_temp.ok(NOT (res ->> 'deleted')::boolean AND pg_temp.codes(res -> 'blockers') = 'moved_in_plan', 'a blocked link stays: ' || res::text);
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM plan_tasks WHERE id = link), 'the blocked row is still there');
  DELETE FROM audit_logs WHERE entity_id = person AND action = 'move';
  -- A link row that is no card of this run (a person's) is never undone by it.
  BEGIN
    PERFORM agent_undo_plan_link(a, (SELECT id FROM plan_tasks WHERE plan_id = p AND task_id = golive), u1, since, r);
    PERFORM pg_temp.ok(false, 'a person''s link must not be undone through a run');
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM plan_tasks WHERE plan_id = p AND task_id = golive), 'the person''s link stays');
  SELECT row(t.*)::text INTO before_row FROM tasks t WHERE t.id = person;
  res := agent_undo_plan_link(a, link, u1, since, r);
  PERFORM pg_temp.ok((res ->> 'deleted')::boolean, 'the link goes: ' || res::text);
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM plan_tasks WHERE id = link), 'only the row goes');
  PERFORM pg_temp.ok((SELECT row(t.*)::text FROM tasks t WHERE t.id = person) = before_row, 'the task is as it was');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM agent_object_origins WHERE entity_type = 'plan_link' AND entity_id = link),
    'the origin stays for audit');
  BEGIN
    PERFORM agent_undo_plan_link(a, gen_random_uuid(), u1, since, r);
    PERFORM pg_temp.ok(false, 'a link of no card of this run must not be undone');
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;

  -- ------------------------------------------------------------ claim and state know the kind
  UPDATE agent_actions SET status = 'executed', undo_until = now() + interval '5 minutes' WHERE id = act_link;
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_undo_state(a, u1, ARRAY[act_link])) = 1, 'undo state lists a link');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_claim_undo(a, u1, false, ARRAY[act_link])) = 1, 'a link can be claimed');
END $$;

\echo 'agent plan links integration: all checks passed'
ROLLBACK;
