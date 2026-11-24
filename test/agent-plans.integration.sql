-- XE-T353 Robert 1.22: database checks for plans and plan items made by Robert, and their Undo.
-- Run only against a confirmed disposable database (local Supabase) with migration
-- 20261112120000_agent_plans applied. Everything is rolled back; it makes its own organizations,
-- users, spaces and plans:
--   psql -f test/agent-plans.integration.sql
-- Success prints "agent plans integration: all checks passed"; any failure aborts with the reason.
-- Races (two Confirms into one plan, Undo against a person's item) are in scripts/robert-verify.mjs.
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

-- An executed action of the run. A plan item and a task are stored as entity 'task'.
CREATE FUNCTION pg_temp.own(p_run uuid, p_kind text, p_entity uuid, p_depends integer DEFAULT NULL) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO agent_actions (organization_id, run_id, ordinal, kind, status, intent, entity_type, entity_id,
    executed_at, undo_until, expires_at, depends_on)
  SELECT r.organization_id, r.id,
         (SELECT coalesce(max(a.ordinal), 0) + 1 FROM agent_actions a WHERE a.run_id = r.id),
         p_kind, 'executed', '{}'::jsonb,
         CASE WHEN p_kind IN ('task', 'subtask', 'plan_item') THEN 'task' ELSE p_kind END,
         p_entity, now(), now() + interval '10 minutes', now() + interval '24 hours', p_depends
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

-- A plan as createPlan makes it: the creator also gets the admin permission row.
CREATE FUNCTION pg_temp.plan(p_org uuid, p_space uuid, p_name text, p_creator uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO plans (id, organization_id, space_id, name, created_by, status)
  VALUES (v_id, p_org, p_space, p_name, p_creator, 'draft');
  INSERT INTO plan_permissions (plan_id, user_id, permission_level) VALUES (v_id, p_creator, 'admin');
  RETURN v_id;
END $$;

-- u1 invokes. u2 is someone else. u9 is in another org.
INSERT INTO organizations (id, name, slug, size) VALUES
  ('ae000000-0000-4000-8000-00000000000a', 'Agent Plans IT A', 'agent-plans-it-a', '1-10'),
  ('ae000000-0000-4000-8000-00000000000b', 'Agent Plans IT B', 'agent-plans-it-b', '1-10');
INSERT INTO users (id, email, first_name, last_name, is_active) VALUES
  ('ae000000-0000-4000-8000-000000000001', 'agent-plans-it-u1@example.invalid', 'Anna', 'Invoker', true),
  ('ae000000-0000-4000-8000-000000000002', 'agent-plans-it-u2@example.invalid', 'Markus', 'Other', true),
  ('ae000000-0000-4000-8000-000000000009', 'agent-plans-it-u9@example.invalid', 'Fred', 'Foreign', true);
INSERT INTO organization_members (organization_id, user_id, role) VALUES
  ('ae000000-0000-4000-8000-00000000000a', 'ae000000-0000-4000-8000-000000000001', 'member'),
  ('ae000000-0000-4000-8000-00000000000a', 'ae000000-0000-4000-8000-000000000002', 'member'),
  ('ae000000-0000-4000-8000-00000000000b', 'ae000000-0000-4000-8000-000000000009', 'owner');
INSERT INTO spaces (id, organization_id, name, key) VALUES
  ('ae000000-0000-4000-8000-0000000000e1', 'ae000000-0000-4000-8000-00000000000a', 'Agent Plans IT', 'AGPLN1'),
  ('ae000000-0000-4000-8000-0000000000e2', 'ae000000-0000-4000-8000-00000000000a', 'Agent Plans IT Two', 'AGPLN2'),
  ('ae000000-0000-4000-8000-0000000000e9', 'ae000000-0000-4000-8000-00000000000b', 'Agent Plans IT B', 'AGPLN9');

-- ---------------------------------------------------------------- kinds and origins
DO $$
DECLARE
  a uuid := 'ae000000-0000-4000-8000-00000000000a';
  u1 uuid := 'ae000000-0000-4000-8000-000000000001';
  s1 uuid := 'ae000000-0000-4000-8000-0000000000e1';
  c uuid;
  r uuid;
  p uuid;
  act uuid;
BEGIN
  c := chat_create_group(a, u1, 'Agent Plans IT', ARRAY['ae000000-0000-4000-8000-000000000002'::uuid]);
  r := pg_temp.new_run(a, c, u1);
  p := pg_temp.plan(a, s1, 'Kinds plan', u1);
  act := pg_temp.own(r, 'plan', p);
  PERFORM pg_temp.ok((SELECT entity_type FROM agent_actions WHERE id = act) = 'plan', 'a plan action is stored as entity plan');
  INSERT INTO agent_object_origins (organization_id, entity_type, entity_id, action_id, run_id, conversation_id,
    trigger_message_id, invoker_id, confirmer_id)
  SELECT a, 'plan', p, act, r, c, ru.trigger_message_id, u1, u1 FROM agent_runs ru WHERE ru.id = r;
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM agent_object_origins o WHERE o.entity_type = 'plan' AND o.entity_id = p),
    'a plan has an origin row');
  PERFORM pg_temp.ok((SELECT plan_key FROM plans WHERE id = p) ~ '^AGPLN1-P[0-9]+$', 'the plan got its key from the trigger');
END $$;

-- ---------------------------------------------------------------- agent_plan_item_link
DO $$
DECLARE
  a uuid := 'ae000000-0000-4000-8000-00000000000a';
  u1 uuid := 'ae000000-0000-4000-8000-000000000001';
  s1 uuid := 'ae000000-0000-4000-8000-0000000000e1';
  s2 uuid := 'ae000000-0000-4000-8000-0000000000e2';
  p uuid;
  t1 uuid; t2 uuid; t3 uuid; t4 uuid; other uuid;
  res jsonb;
BEGIN
  p := pg_temp.plan(a, s1, 'Link plan', u1);
  t1 := pg_temp.task(a, s1, 'Phase', u1);
  t2 := pg_temp.task(a, s1, 'Second top', u1);
  t3 := pg_temp.task(a, s1, 'Child', u1, t1);
  t4 := pg_temp.task(a, s1, 'Second child', u1, t1);
  other := pg_temp.task(a, s2, 'Other space', u1);

  res := agent_plan_item_link(a, p, t1, 'phase', NULL);
  PERFORM pg_temp.ok((res ->> 'sort_order')::int = 1 AND (res ->> 'adopted')::boolean IS FALSE, 'first top item sits at 1');
  res := agent_plan_item_link(a, p, t2, 'milestone', NULL);
  PERFORM pg_temp.ok((res ->> 'sort_order')::int = 2, 'second top item sits at 2');
  res := agent_plan_item_link(a, p, t3, 'task', '#ff0000');
  PERFORM pg_temp.ok((res ->> 'sort_order')::int = 1, 'first child counts among its own siblings');
  res := agent_plan_item_link(a, p, t4, 'work_package', NULL);
  PERFORM pg_temp.ok((res ->> 'sort_order')::int = 2, 'second child sits at 2 under its parent');
  PERFORM pg_temp.ok((SELECT item_type FROM plan_tasks WHERE task_id = t2) = 'milestone', 'the item type is stored');
  PERFORM pg_temp.ok((SELECT color FROM plan_tasks WHERE task_id = t3) = '#ff0000', 'the colour is stored');

  res := agent_plan_item_link(a, p, t1, 'phase', NULL);
  PERFORM pg_temp.ok((res ->> 'adopted')::boolean AND (SELECT count(*) FROM plan_tasks WHERE task_id = t1) = 1,
    'a second link adopts the row, never a duplicate');

  BEGIN
    PERFORM agent_plan_item_link(a, p, other, 'task', NULL);
    RAISE EXCEPTION 'CHECK FAILED: a task of another space was linked';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
  BEGIN
    PERFORM agent_plan_item_link('ae000000-0000-4000-8000-00000000000b', p, t1, 'task', NULL);
    RAISE EXCEPTION 'CHECK FAILED: another tenant linked into the plan';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
  BEGIN
    PERFORM agent_plan_item_link(a, p, t1, 'epic', NULL);
    RAISE EXCEPTION 'CHECK FAILED: an unknown item type was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  UPDATE plans SET is_archived = true, status = 'archived' WHERE id = p;
  BEGIN
    PERFORM agent_plan_item_link(a, p, pg_temp.task(a, s1, 'Late', u1), 'task', NULL);
    RAISE EXCEPTION 'CHECK FAILED: an archived plan took an item';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$;

-- ---------------------------------------------------------------- plan item blockers
DO $$
DECLARE
  a uuid := 'ae000000-0000-4000-8000-00000000000a';
  u1 uuid := 'ae000000-0000-4000-8000-000000000001';
  u2 uuid := 'ae000000-0000-4000-8000-000000000002';
  s1 uuid := 'ae000000-0000-4000-8000-0000000000e1';
  c uuid; r uuid; p uuid; p2 uuid; t uuid; t2 uuid; rel uuid;
  since timestamptz := now() - interval '1 second';
BEGIN
  c := chat_create_group(a, u1, 'Agent Plans IT items', ARRAY['ae000000-0000-4000-8000-000000000002'::uuid]);
  r := pg_temp.new_run(a, c, u1);
  p := pg_temp.plan(a, s1, 'Item blockers', u1);

  -- Fresh, its own link only: nothing stops it.
  t := pg_temp.task(a, s1, 'Fresh item', u1);
  PERFORM agent_plan_item_link(a, p, t, 'task', NULL);
  PERFORM pg_temp.own(r, 'plan_item', t);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, since, r) = '[]'::jsonb, 'a fresh plan item has no blocker');

  -- The same link made for a plain task card is still a person's plan link (1.21 behaviour).
  t2 := pg_temp.task(a, s1, 'Plain task', u1);
  PERFORM agent_plan_item_link(a, p, t2, 'task', NULL);
  PERFORM pg_temp.own(r, 'task', t2);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t2, u1, since, r)) = 'has_links',
    'a plain task someone put in a plan stays blocked');

  -- The invoker moving their own item is fine; someone else moving it is not.
  INSERT INTO audit_logs (organization_id, user_id, entity_type, entity_id, action, changes)
  VALUES (a, u1, 'plan_item', t, 'move', '{}');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, since, r) = '[]'::jsonb, 'the invoker moving it does not block');
  INSERT INTO audit_logs (organization_id, user_id, entity_type, entity_id, action, changes)
  VALUES (a, u2, 'plan_item', t, 'update', '{}');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, since, r)) = 'moved_in_plan',
    'someone else changing its plan fields blocks');
  PERFORM pg_temp.ok((agent_undo_blockers(a, 'task', t, u1, since, r) -> 0 ->> 'by')::uuid = u2, 'the blocker names who');
  DELETE FROM audit_logs WHERE entity_id = t AND user_id = u2;

  -- A reorder is logged on the plan.
  INSERT INTO audit_logs (organization_id, user_id, entity_type, entity_id, action, changes)
  VALUES (a, u2, 'plan_item', p, 'reorder', '{}');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, since, r)) = 'moved_in_plan',
    'someone else reordering the plan blocks');
  DELETE FROM audit_logs WHERE entity_id = p AND user_id = u2;

  -- A baseline taken since holds the item.
  INSERT INTO plan_baselines (plan_id, name, snapshot_data, created_by) VALUES (p, 'B1', '{}', u1);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, since, r)) = 'baseline_taken',
    'a baseline taken after Confirm blocks, whoever took it');
  DELETE FROM plan_baselines WHERE plan_id = p;
  INSERT INTO plan_baselines (plan_id, name, snapshot_data, created_by, created_at)
  VALUES (p, 'Old', '{}', u1, since - interval '1 hour');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'task', t, u1, since, r) = '[]'::jsonb, 'an older baseline does not count');
  DELETE FROM plan_baselines WHERE plan_id = p;

  -- A dependency someone added.
  INSERT INTO relation_types (id, organization_id, name, outward_description, inward_description)
  VALUES (gen_random_uuid(), a, 'Finish to Start IT', 'precedes', 'follows') RETURNING id INTO rel;
  INSERT INTO task_relationships (organization_id, source_type, source_id, target_type, target_id, relation_type_id)
  VALUES (a, 'task', t2, 'task', t, rel);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, since, r)) = 'has_relationships',
    'a dependency to it blocks');
  DELETE FROM task_relationships WHERE target_id = t;

  -- Put into a second plan by a person.
  p2 := pg_temp.plan(a, s1, 'Second plan', u2);
  INSERT INTO plan_tasks (plan_id, task_id, item_type, sort_order) VALUES (p2, t, 'task', 1);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', t, u1, since, r)) = 'has_links',
    'a person adding it to another plan blocks');
END $$;

-- ---------------------------------------------------------------- plan blockers
DO $$
DECLARE
  a uuid := 'ae000000-0000-4000-8000-00000000000a';
  u1 uuid := 'ae000000-0000-4000-8000-000000000001';
  u2 uuid := 'ae000000-0000-4000-8000-000000000002';
  s1 uuid := 'ae000000-0000-4000-8000-0000000000e1';
  c uuid; r uuid; p uuid; t uuid; mine uuid; sf uuid; pf uuid;
  since timestamptz := now() - interval '1 second';
  b jsonb;
BEGIN
  c := chat_create_group(a, u1, 'Agent Plans IT plans', ARRAY['ae000000-0000-4000-8000-000000000002'::uuid]);
  r := pg_temp.new_run(a, c, u1);
  p := pg_temp.plan(a, s1, 'Plan blockers', u1);
  PERFORM pg_temp.own(r, 'plan', p);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'plan', p, u1, since, r) = '[]'::jsonb,
    'a fresh plan with only its creator''s admin row has no blocker');

  -- Its own item of this run, unblocked, does not stop it; blocked, it does.
  mine := pg_temp.task(a, s1, 'Own item', u1);
  PERFORM agent_plan_item_link(a, p, mine, 'task', NULL);
  PERFORM pg_temp.own(r, 'plan_item', mine);
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'plan', p, u1, since, r) = '[]'::jsonb, 'its own item does not block');
  INSERT INTO task_comments (task_id, organization_id, content, created_by) VALUES (mine, a, 'mine now', u2);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'has_items',
    'its own item that cannot be undone blocks the plan');
  DELETE FROM task_comments WHERE task_id = mine;
  -- Out of the way, so each check below sees one blocker (a baseline would also hold the item).
  DELETE FROM plan_tasks WHERE task_id = mine;

  -- A person's item.
  t := pg_temp.task(a, s1, 'Person item', u2);
  INSERT INTO plan_tasks (plan_id, task_id, item_type, sort_order) VALUES (p, t, 'task', 9);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'has_items', 'a person''s item blocks');
  DELETE FROM plan_tasks WHERE task_id = t;

  -- Everything a plan delete would take along.
  INSERT INTO plan_comments (plan_id, organization_id, content, created_by) VALUES (p, a, 'hi', u2);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'has_comments', 'a comment blocks');
  DELETE FROM plan_comments WHERE plan_id = p;
  INSERT INTO plan_baselines (plan_id, name, snapshot_data, created_by) VALUES (p, 'B', '{}', u1);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'has_links', 'a baseline blocks');
  DELETE FROM plan_baselines WHERE plan_id = p;
  INSERT INTO plan_risks (plan_id, organization_id, name) VALUES (p, a, 'Risk');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'has_links', 'a risk blocks');
  DELETE FROM plan_risks WHERE plan_id = p;
  INSERT INTO plan_stakeholders (plan_id, name) VALUES (p, 'Sponsor');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'has_links', 'a stakeholder blocks');
  DELETE FROM plan_stakeholders WHERE plan_id = p;
  INSERT INTO plan_resource_allocations (organization_id, plan_id, user_id) VALUES (a, p, u2);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'has_links', 'a resource allocation blocks');
  DELETE FROM plan_resource_allocations WHERE plan_id = p;
  INSERT INTO plan_permissions (plan_id, user_id, permission_level) VALUES (p, u2, 'view');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'has_links',
    'a permission row for someone else blocks');
  DELETE FROM plan_permissions WHERE plan_id = p AND user_id = u2;
  UPDATE plan_permissions SET permission_level = 'edit' WHERE plan_id = p AND user_id = u1;
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'has_links',
    'the creator''s row changed away from admin counts');
  UPDATE plan_permissions SET permission_level = 'admin' WHERE plan_id = p AND user_id = u1;
  INSERT INTO portfolios (id, organization_id, name) VALUES (gen_random_uuid(), a, 'Portfolio IT') RETURNING id INTO pf;
  INSERT INTO portfolio_plans (portfolio_id, plan_id) VALUES (pf, p);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'has_links', 'a portfolio blocks');
  DELETE FROM portfolio_plans WHERE plan_id = p;
  INSERT INTO saved_filters (id, organization_id, name, owner_id) VALUES (gen_random_uuid(), a, 'Filter IT', u2) RETURNING id INTO sf;
  UPDATE plans SET filter_id = sf WHERE id = p;
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'has_links', 'a saved filter link blocks');
  UPDATE plans SET filter_id = NULL WHERE id = p;
  UPDATE plans SET rag_set_manually = true, rag_status = 'red' WHERE id = p;
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'rag_set', 'a manual RAG blocks');
  UPDATE plans SET rag_set_manually = false, rag_status = 'unknown' WHERE id = p;

  -- Edits: the invoker's do not count, someone else's do.
  INSERT INTO audit_logs (organization_id, user_id, entity_type, entity_id, action, changes) VALUES (a, u1, 'plan', p, 'update', '{}');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'plan', p, u1, since, r) = '[]'::jsonb, 'the invoker''s own edit does not block');
  INSERT INTO audit_logs (organization_id, user_id, entity_type, entity_id, action, changes) VALUES (a, u2, 'plan', p, 'update', '{}');
  b := agent_undo_blockers(a, 'plan', p, u1, since, r);
  PERFORM pg_temp.ok(pg_temp.codes(b) = 'changed_by_other' AND (b -> 0 ->> 'by')::uuid = u2, 'someone else''s edit blocks and names them');
  DELETE FROM audit_logs WHERE entity_id = p AND user_id = u2;
  -- Someone else's edit is not one when they press Undo themselves (a tenant admin).
  INSERT INTO audit_logs (organization_id, user_id, entity_type, entity_id, action, changes) VALUES (a, u2, 'plan', p, 'update', '{}');
  PERFORM pg_temp.ok(agent_undo_blockers(a, 'plan', p, u2, since, r) = '[]'::jsonb, 'the presser''s own edit does not block');
  DELETE FROM audit_logs WHERE entity_id = p AND user_id = u2;

  -- An automation that ran on app.plan.created.
  DECLARE au uuid := gen_random_uuid(); v uuid := gen_random_uuid();
  BEGIN
    INSERT INTO automations (id, organization_id, space_id, name) VALUES (au, a, s1, 'Agent Plans Automation');
    INSERT INTO automation_versions (id, automation_id, space_id, version_number, definition, trigger_kind)
    VALUES (v, au, s1, 1, '{}', 'app.plan.created');
    INSERT INTO automation_runs (automation_id, automation_version_id, space_id, organization_id, trigger_kind, trigger_payload)
    VALUES (au, v, s1, a, 'app.plan.created', jsonb_build_object('plan', jsonb_build_object('id', p), 'plan_id', p));
    PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', p, u1, since, r)) = 'automations_ran',
      'an automation that ran on it blocks');
    DELETE FROM automation_runs WHERE automation_id = au;
  END;

  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan', gen_random_uuid(), u1, since, r)) = 'gone', 'a missing plan is gone');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers('ae000000-0000-4000-8000-00000000000b', 'plan', p, u1, since, r)) = 'gone',
    'another tenant never sees the plan');
END $$;

-- ---------------------------------------------------------------- undo a plan item, then the plan
DO $$
DECLARE
  a uuid := 'ae000000-0000-4000-8000-00000000000a';
  u1 uuid := 'ae000000-0000-4000-8000-000000000001';
  u2 uuid := 'ae000000-0000-4000-8000-000000000002';
  s1 uuid := 'ae000000-0000-4000-8000-0000000000e1';
  c uuid; r uuid; p uuid; phase uuid; child uuid; person uuid;
  since timestamptz := now() - interval '1 second';
  out jsonb;
BEGIN
  c := chat_create_group(a, u1, 'Agent Plans IT undo', ARRAY['ae000000-0000-4000-8000-000000000002'::uuid]);
  r := pg_temp.new_run(a, c, u1);
  p := pg_temp.plan(a, s1, 'Undo plan', u1);
  PERFORM pg_temp.own(r, 'plan', p);
  phase := pg_temp.task(a, s1, 'Phase', u1);
  child := pg_temp.task(a, s1, 'Child', u1, phase);
  PERFORM agent_plan_item_link(a, p, phase, 'phase', NULL);
  PERFORM agent_plan_item_link(a, p, child, 'task', NULL);
  PERFORM pg_temp.own(r, 'plan_item', phase, 1);
  PERFORM pg_temp.own(r, 'plan_item', child, 2);

  -- The plan while items are still in it: refused by the last guard, nothing deleted.
  out := agent_undo_plan(a, p, u1, since, r);
  PERFORM pg_temp.ok((out ->> 'deleted')::boolean IS FALSE AND pg_temp.codes(out -> 'blockers') = 'has_items',
    'a plan with items left is never deleted');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM plans WHERE id = p) AND EXISTS (SELECT 1 FROM tasks WHERE id = phase),
    'nothing went');

  -- A child of this run that a person commented on holds its phase (the service claims the two
  -- together and goes deepest first; here the database alone).
  INSERT INTO task_comments (task_id, organization_id, content, created_by) VALUES (child, a, 'c', u2);
  out := agent_undo_plan_item(a, phase, u1, since, r);
  PERFORM pg_temp.ok((out ->> 'deleted')::boolean IS FALSE AND pg_temp.codes(out -> 'blockers') = 'has_subtasks'
    AND EXISTS (SELECT 1 FROM tasks WHERE id = child), 'a phase whose child cannot go stays, and so does the child');
  DELETE FROM task_comments WHERE task_id = child;

  out := agent_undo_plan_item(a, child, u1, since, r);
  PERFORM pg_temp.ok((out ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = child)
    AND NOT EXISTS (SELECT 1 FROM plan_tasks WHERE task_id = child), 'the child goes, its link with it');
  out := agent_undo_plan_item(a, phase, u1, since, r);
  PERFORM pg_temp.ok((out ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM plan_tasks WHERE plan_id = p),
    'then the phase');

  out := agent_undo_plan(a, p, u1, since, r);
  PERFORM pg_temp.ok((out ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM plans WHERE id = p)
    AND NOT EXISTS (SELECT 1 FROM plan_permissions WHERE plan_id = p), 'then the plan, with its own permission row');

  -- A plan holding a person's task: blocked, and the task is never touched.
  r := pg_temp.new_run(a, c, u1);
  p := pg_temp.plan(a, s1, 'Person plan', u1);
  PERFORM pg_temp.own(r, 'plan', p);
  person := pg_temp.task(a, s1, 'Person task', u2);
  INSERT INTO plan_tasks (plan_id, task_id, item_type, sort_order) VALUES (p, person, 'task', 1);
  out := agent_undo_plan(a, p, u1, since, r);
  PERFORM pg_temp.ok((out ->> 'deleted')::boolean IS FALSE AND EXISTS (SELECT 1 FROM tasks WHERE id = person)
    AND EXISTS (SELECT 1 FROM plan_tasks WHERE task_id = person), 'a person''s task and its link stay');

  -- Not of this run: not found.
  BEGIN
    PERFORM agent_undo_plan_item(a, person, u1, since, r);
    RAISE EXCEPTION 'CHECK FAILED: a task outside the run was accepted';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
  BEGIN
    PERFORM agent_undo_plan(a, pg_temp.plan(a, s1, 'Stranger', u2), u1, since, r);
    RAISE EXCEPTION 'CHECK FAILED: a plan outside the run was accepted';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
  BEGIN
    PERFORM agent_undo_plan('ae000000-0000-4000-8000-00000000000b', p, u1, since, r);
    RAISE EXCEPTION 'CHECK FAILED: another tenant undid the plan';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
END $$;

-- ---------------------------------------------------------------- state and claim know the new kinds
DO $$
DECLARE
  a uuid := 'ae000000-0000-4000-8000-00000000000a';
  u1 uuid := 'ae000000-0000-4000-8000-000000000001';
  s1 uuid := 'ae000000-0000-4000-8000-0000000000e1';
  c uuid; r uuid; p uuid; t uuid; ap uuid; ai uuid;
BEGIN
  c := chat_create_group(a, u1, 'Agent Plans IT claim', ARRAY['ae000000-0000-4000-8000-000000000002'::uuid]);
  r := pg_temp.new_run(a, c, u1);
  p := pg_temp.plan(a, s1, 'Claim plan', u1);
  t := pg_temp.task(a, s1, 'Claim item', u1);
  PERFORM agent_plan_item_link(a, p, t, 'milestone', NULL);
  ap := pg_temp.own(r, 'plan', p);
  ai := pg_temp.own(r, 'plan_item', t, 1);
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_undo_state(a, u1, ARRAY[ap, ai])) = 2, 'the card state covers both kinds');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_claim_undo(a, u1, false, ARRAY[ap, ai])) = 2, 'both kinds can be claimed');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_actions WHERE id IN (ap, ai) AND status = 'undoing') = 2, 'both are undoing');
END $$;

SELECT 'agent plans integration: all checks passed' AS result;
ROLLBACK;
