-- XE-T353 Robert 1.23: suggested dependencies, dates, risks and stakeholders, and a baseline on request.
-- Run only against a confirmed disposable database (local Supabase) with migration
-- 20261113140000_agent_plan_suggestions applied. Everything is rolled back; it makes its own data:
--   psql -f test/agent-plan-suggestions.integration.sql
-- Success prints "agent plan suggestions integration: all checks passed"; any failure aborts with the reason.
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
  ('ae000000-0000-4000-8000-00000000000a', 'Agent Suggest IT A', 'agent-suggest-it-a', '1-10');
INSERT INTO users (id, email, first_name, last_name, is_active) VALUES
  ('ae000000-0000-4000-8000-000000000001', 'agent-suggest-it-u1@example.invalid', 'Anna', 'Invoker', true),
  ('ae000000-0000-4000-8000-000000000002', 'agent-suggest-it-u2@example.invalid', 'Markus', 'Other', true),
  ('ae000000-0000-4000-8000-000000000003', 'agent-suggest-it-u3@example.invalid', 'Nora', 'Outside', true);
INSERT INTO organization_members (organization_id, user_id, role) VALUES
  ('ae000000-0000-4000-8000-00000000000a', 'ae000000-0000-4000-8000-000000000001', 'member'),
  ('ae000000-0000-4000-8000-00000000000a', 'ae000000-0000-4000-8000-000000000002', 'member'),
  ('ae000000-0000-4000-8000-00000000000a', 'ae000000-0000-4000-8000-000000000003', 'member');
INSERT INTO spaces (id, organization_id, name, key) VALUES
  ('ae000000-0000-4000-8000-0000000000e1', 'ae000000-0000-4000-8000-00000000000a', 'Agent Suggest IT', 'AGSUG1');
INSERT INTO space_members (space_id, member_type, user_id, space_role, is_active) VALUES
  ('ae000000-0000-4000-8000-0000000000e1', 'user', 'ae000000-0000-4000-8000-000000000001', 'admin', true),
  ('ae000000-0000-4000-8000-0000000000e1', 'user', 'ae000000-0000-4000-8000-000000000002', 'member', true);

DO $$
DECLARE
  a uuid := 'ae000000-0000-4000-8000-00000000000a';
  u1 uuid := 'ae000000-0000-4000-8000-000000000001';
  u2 uuid := 'ae000000-0000-4000-8000-000000000002';
  u3 uuid := 'ae000000-0000-4000-8000-000000000003';
  s1 uuid := 'ae000000-0000-4000-8000-0000000000e1';
  c uuid; r uuid; r2 uuid; p uuid; parch uuid;
  robert_item uuid; person_item uuid; build uuid;
  res jsonb; g jsonb; before_row text;
  risk uuid := gen_random_uuid(); risk2 uuid := gen_random_uuid();
  sh uuid := gen_random_uuid(); dep uuid := gen_random_uuid(); dates uuid := gen_random_uuid();
  bl_old uuid; bl uuid := gen_random_uuid();
  act_risk uuid; act_sh uuid; act_dep uuid; act_dates uuid; act_bl uuid;
  since timestamptz := now() - interval '1 minute';
BEGIN
  c := chat_create_group(a, u1, 'Agent Suggest IT', ARRAY[u2]);
  r := pg_temp.new_run(a, c, u1);
  p := gen_random_uuid();
  INSERT INTO plans (id, organization_id, space_id, name, created_by, status, start_date, end_date)
  VALUES (p, a, s1, 'Q4 Security', u2, 'active', '2026-12-01', '2027-02-28');
  parch := gen_random_uuid();
  INSERT INTO plans (id, organization_id, space_id, name, created_by, status, is_archived) VALUES (parch, a, s1, 'Old', u2, 'archived', true);

  robert_item := pg_temp.task(a, s1, 'Pen test', u1);
  person_item := pg_temp.task(a, s1, 'Build', u2);
  build := person_item;
  INSERT INTO plan_tasks (plan_id, task_id, item_type, sort_order) VALUES (p, robert_item, 'task', 1), (p, person_item, 'task', 2);
  INSERT INTO agent_object_origins (organization_id, entity_type, entity_id, action_id, run_id, conversation_id, trigger_message_id, invoker_id, confirmer_id)
  SELECT a, 'task', robert_item, pg_temp.own(r, 'plan_item', robert_item), r, c, ru.trigger_message_id, u1, u1 FROM agent_runs ru WHERE ru.id = r;
  UPDATE tasks SET start_date = '2026-12-01', end_date = '2026-12-12', estimated_time = 2400 WHERE id = person_item;

  -- ------------------------------------------------------------ kinds
  act_risk := pg_temp.own(r, 'plan_risk', risk);
  act_sh := pg_temp.own(r, 'plan_stakeholder', sh);
  act_dep := pg_temp.own(r, 'plan_dependency', dep);
  act_dates := pg_temp.own(r, 'plan_dates', dates);
  act_bl := pg_temp.own(r, 'plan_baseline', bl);
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_actions WHERE run_id = r AND entity_type = kind) = 5, 'each new kind is its own entity');
  BEGIN
    PERFORM pg_temp.own(r, 'plan_budget', gen_random_uuid());
    PERFORM pg_temp.ok(false, 'an unknown kind must be refused');
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ------------------------------------------------------------ agent_plan_graph
  g := agent_plan_graph(a, p);
  PERFORM pg_temp.ok(jsonb_array_length(g -> 'items') = 2, 'graph: both items');
  PERFORM pg_temp.ok((SELECT (i ->> 'robert')::boolean FROM jsonb_array_elements(g -> 'items') i WHERE i ->> 'task_id' = robert_item::text), 'graph: Robert''s item is marked');
  PERFORM pg_temp.ok(NOT (SELECT (i ->> 'robert')::boolean FROM jsonb_array_elements(g -> 'items') i WHERE i ->> 'task_id' = person_item::text), 'graph: a person''s item is not');
  PERFORM pg_temp.ok(jsonb_array_length(g -> 'edges') = 0, 'graph: no edges yet');
  PERFORM pg_temp.ok(jsonb_array_length(agent_plan_graph(gen_random_uuid(), p) -> 'items') = 0, 'graph: another org sees nothing');

  -- ------------------------------------------------------------ risks
  res := agent_plan_risk_add(a, p, risk, u1, jsonb_build_object('name', ' Supplier delay ', 'probability', 4, 'impact', 5,
    'category', 'Schedule', 'mitigation_strategy', 'Second supplier', 'owner_id', u2));
  PERFORM pg_temp.ok((res ->> 'created')::boolean AND NOT (res ->> 'adopted')::boolean, 'risk created: ' || res::text);
  PERFORM pg_temp.ok((SELECT name || probability || impact || status || created_by::text FROM plan_risks WHERE id = risk)
                     = 'Supplier delay45identified' || u1::text, 'risk values as given, trimmed, status identified');
  PERFORM pg_temp.ok((agent_plan_risk_add(a, p, risk, u1, '{"name":"x"}') ->> 'adopted')::boolean, 'a retry adopts its own risk');
  PERFORM pg_temp.ok(agent_plan_risk_add(a, p, risk2, u1, '{"name":"supplier DELAY"}') ->> 'reason' = 'same_name_in_plan', 'same name, any case: already in the plan (D4)');
  PERFORM pg_temp.ok(agent_plan_risk_add(a, p, risk2, u1, jsonb_build_object('name', 'Other', 'owner_id', u3)) ->> 'reason' = 'not_space_member', 'an owner outside the space is refused');
  PERFORM pg_temp.ok(agent_plan_risk_add(a, parch, risk2, u1, '{"name":"Other"}') ->> 'reason' = 'plan_archived', 'archived plan: refused');
  BEGIN
    PERFORM agent_plan_risk_add(a, p, risk2, u1, jsonb_build_object('name', 'Bad', 'probability', 9));
    PERFORM pg_temp.ok(false, 'probability 9 must be refused by the table');
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM agent_plan_risk_add(gen_random_uuid(), p, risk2, u1, '{"name":"Other"}');
    PERFORM pg_temp.ok(false, 'another org''s plan must be refused');
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_risk', risk, u1, since, r)) = '', 'a fresh risk: none');
  -- A person's edit comes in a later transaction: within this one, the row is made older instead.
  UPDATE plan_risks SET mitigation_strategy = 'changed', created_at = now() - interval '1 minute' WHERE id = risk;
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_risk', risk, u1, since, r)) = 'changed_by_other', 'an edited risk blocks its Undo');
  res := agent_undo_plan_suggestion(a, 'plan_risk', risk, u1, since, r);
  PERFORM pg_temp.ok(NOT (res ->> 'deleted')::boolean AND EXISTS (SELECT 1 FROM plan_risks WHERE id = risk), 'blocked Undo keeps the risk');
  UPDATE plan_risks SET created_at = now() WHERE id = risk;
  res := agent_undo_plan_suggestion(a, 'plan_risk', risk, u1, since, r);
  PERFORM pg_temp.ok((res ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM plan_risks WHERE id = risk), 'risk Undo deletes only it');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_risk', risk, u1, since, r)) = 'gone', 'an undone risk is gone');

  -- ------------------------------------------------------------ stakeholders
  res := agent_plan_stakeholder_add(a, p, sh, jsonb_build_object('name', 'CISO', 'role', 'Approver', 'power_level', 9,
    'interest_level', 7, 'attitude', 'supportive', 'user_id', u2));
  PERFORM pg_temp.ok((res ->> 'created')::boolean, 'stakeholder created');
  PERFORM pg_temp.ok((SELECT user_id = u2 AND power_level = 9 FROM plan_stakeholders WHERE id = sh), 'stakeholder values as given');
  PERFORM pg_temp.ok(agent_plan_stakeholder_add(a, p, gen_random_uuid(), '{"name":"ciso"}') ->> 'reason' = 'same_name_in_plan', 'stakeholder dedupe');
  PERFORM pg_temp.ok(agent_plan_stakeholder_add(a, p, gen_random_uuid(), jsonb_build_object('name', 'N', 'user_id', u3)) ->> 'reason' = 'not_space_member', 'a user outside the space is refused');
  BEGIN
    PERFORM agent_plan_stakeholder_add(a, p, gen_random_uuid(), '{"name":"Bad","attitude":"angry"}');
    PERFORM pg_temp.ok(false, 'attitude angry must be refused');
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE plan_stakeholders SET notes = 'x', created_at = now() - interval '1 minute' WHERE id = sh;
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_stakeholder', sh, u1, since, r)) = 'changed_by_other', 'an edited stakeholder blocks');
  UPDATE plan_stakeholders SET created_at = now() WHERE id = sh;
  res := agent_undo_plan_suggestion(a, 'plan_stakeholder', sh, u1, since, r);
  PERFORM pg_temp.ok((res ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM plan_stakeholders WHERE id = sh), 'stakeholder Undo');

  -- ------------------------------------------------------------ dependencies under a reserved id
  res := agent_plan_dependency_add(a, p, act_dep, person_item, robert_item, 'Finish to Start', dep);
  PERFORM pg_temp.ok((res ->> 'created')::boolean AND (res ->> 'id')::uuid = dep, 'dependency under the reserved id: ' || res::text);
  PERFORM pg_temp.ok((agent_plan_dependency_add(a, p, act_dep, person_item, robert_item, 'Finish to Start', dep) ->> 'adopted')::boolean, 'retry adopts');
  PERFORM pg_temp.ok(agent_plan_dependency_add(a, p, gen_random_uuid(), robert_item, person_item, 'Start to Start', gen_random_uuid()) ->> 'reason' = 'dependency_exists',
                     'two items linked the other way are linked already');
  PERFORM pg_temp.ok(agent_plan_dependency_add(a, p, gen_random_uuid(), person_item, robert_item, 'Start to Start', gen_random_uuid()) ->> 'reason' = 'dependency_exists',
                     'two items linked by another type are linked already');
  PERFORM pg_temp.ok(jsonb_array_length(agent_plan_graph(a, p) -> 'edges') = 1, 'graph: the edge');
  -- A person's dependency since blocks nothing, and Undo leaves it.
  INSERT INTO task_relationships (organization_id, source_type, source_id, target_type, target_id, relation_type_id, created_by)
  SELECT a, 'task', robert_item, 'task', pg_temp.task(a, s1, 'Later', u2), id, u2 FROM relation_types WHERE organization_id = a AND name = 'Finish to Start';
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_dependency', dep, u1, since, r)) = '', 'a dependency: nothing blocks');

  -- ------------------------------------------------------------ dates
  SELECT row(t.*)::text INTO before_row FROM tasks t WHERE t.id = person_item;
  PERFORM pg_temp.ok(agent_plan_dates_set(a, p, act_dates, person_item, '2026-12-14', '2026-12-18', 4) ->> 'reason' IN ('not_robert_item', 'has_dates'), 'a person''s item is never dated');
  UPDATE tasks SET start_date = NULL, end_date = NULL WHERE id = person_item;
  SELECT row(t.*)::text INTO before_row FROM tasks t WHERE t.id = person_item;
  PERFORM pg_temp.ok(agent_plan_dates_set(a, p, act_dates, person_item, '2026-12-14', '2026-12-18', 4) ->> 'reason' = 'not_robert_item', 'D3: not even without dates');
  PERFORM pg_temp.ok((SELECT row(t.*)::text FROM tasks t WHERE t.id = person_item) = before_row, 'the person''s item is untouched');
  UPDATE tasks SET duration = 7 WHERE id = robert_item;
  res := agent_plan_dates_set(a, p, act_dates, robert_item, '2026-12-14', '2026-12-18', 4);
  PERFORM pg_temp.ok((res ->> 'set')::boolean, 'dates set on Robert''s item: ' || res::text);
  PERFORM pg_temp.ok((SELECT start_date::date = '2026-12-14' AND end_date::date = '2026-12-18' AND duration = 4 AND updated_by = u1 FROM tasks WHERE id = robert_item), 'the dates as confirmed');
  PERFORM pg_temp.ok((SELECT before_values ->> 'duration' FROM agent_actions WHERE id = act_dates) = '7', 'the duration before is kept');
  PERFORM pg_temp.ok((agent_plan_dates_set(a, p, act_dates, robert_item, '2026-12-14', '2026-12-18', 4) ->> 'adopted')::boolean, 'retry adopts');
  PERFORM pg_temp.ok(agent_plan_dates_set(a, p, pg_temp.own(r, 'plan_dates', gen_random_uuid()), robert_item, '2026-12-20', '2026-12-21', 1) ->> 'reason' = 'has_dates', 'another card: has dates now (D1)');
  BEGIN
    PERFORM agent_plan_dates_set(a, p, act_dates, robert_item, '2026-12-18', '2026-12-14', 0);
    PERFORM pg_temp.ok(false, 'end before start must be refused');
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  PERFORM pg_temp.ok(agent_plan_dates_set(a, parch, act_dates, robert_item, '2026-12-14', '2026-12-18', 4) ->> 'reason' = 'not_in_plan', 'not an item of that plan');
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_dates', dates, u1, since, r)) = '', 'fresh dates: none');
  UPDATE tasks SET end_date = '2026-12-19', updated_by = u2 WHERE id = robert_item;
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_dates', dates, u1, since, r)) = 'dates_changed', 'someone moved the date: blocked');
  res := agent_undo_plan_suggestion(a, 'plan_dates', dates, u1, since, r);
  PERFORM pg_temp.ok(NOT (res ->> 'deleted')::boolean AND (SELECT end_date::date FROM tasks WHERE id = robert_item) = '2026-12-19', 'blocked Undo keeps the person''s date');
  UPDATE tasks SET end_date = '2026-12-18' WHERE id = robert_item;
  -- A baseline taken since holds the dates.
  INSERT INTO plan_baselines (plan_id, name, snapshot_data, created_by) VALUES (p, 'Person''s', '{}', u2) RETURNING id INTO bl_old;
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_dates', dates, u1, since, r)) = 'baseline_taken', 'a baseline since blocks dates');
  DELETE FROM plan_baselines WHERE id = bl_old;
  res := agent_undo_plan_suggestion(a, 'plan_dates', dates, u1, since, r);
  PERFORM pg_temp.ok((res ->> 'deleted')::boolean, 'dates Undo: ' || res::text);
  PERFORM pg_temp.ok((SELECT start_date IS NULL AND end_date IS NULL AND duration = 7 FROM tasks WHERE id = robert_item), 'back to no dates, duration as before');

  -- ------------------------------------------------------------ baselines
  INSERT INTO plan_baselines (plan_id, name, snapshot_data, created_by, is_active, created_at)
  VALUES (p, 'Kick-off', '{}', u2, false, now() - interval '1 hour') RETURNING id INTO bl_old;
  INSERT INTO plan_baselines (id, plan_id, name, snapshot_data, created_by, is_active) VALUES (bl, p, 'Before pen test', '{"items":[]}', u1, true);
  UPDATE agent_actions SET before_values = jsonb_build_object('previous_active_id', bl_old) WHERE id = act_bl;
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_baseline', bl, u1, since, r)) = '', 'the newest active baseline: none');
  UPDATE plan_baselines SET is_active = false WHERE id = bl;
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_baseline', bl, u1, since, r)) = 'baseline_superseded', 'not active any more: blocked');
  UPDATE plan_baselines SET is_active = true WHERE id = bl;
  INSERT INTO plan_baselines (plan_id, name, snapshot_data, created_by, is_active) VALUES (p, 'Later', '{}', u2, false);
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'plan_baseline', bl, u1, since, r)) = 'baseline_superseded', 'a later baseline blocks');
  DELETE FROM plan_baselines WHERE plan_id = p AND name = 'Later';
  res := agent_undo_plan_suggestion(a, 'plan_baseline', bl, u1, since, r);
  PERFORM pg_temp.ok((res ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM plan_baselines WHERE id = bl), 'baseline Undo deletes it');
  PERFORM pg_temp.ok((SELECT is_active FROM plan_baselines WHERE id = bl_old), 'the baseline active before is active again');

  -- ------------------------------------------------------------ dependency Undo last (only its own row)
  res := agent_undo_plan_suggestion(a, 'plan_dependency', dep, u1, since, r);
  PERFORM pg_temp.ok((res ->> 'deleted')::boolean AND NOT EXISTS (SELECT 1 FROM task_relationships WHERE id = dep), 'dependency Undo');
  PERFORM pg_temp.ok((SELECT count(*) FROM task_relationships WHERE source_id = robert_item) = 1, 'the person''s dependency stays');

  -- ------------------------------------------------------------ guards
  BEGIN
    PERFORM agent_undo_plan_suggestion(a, 'plan_risk', gen_random_uuid(), u1, since, r);
    PERFORM pg_temp.ok(false, 'a risk of no card of this run must not be undone');
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;
  BEGIN
    PERFORM agent_undo_plan_suggestion(a, 'task', robert_item, u1, since, r);
    PERFORM pg_temp.ok(false, 'only suggestion kinds');
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  r2 := pg_temp.new_run(a, c, u1);
  BEGIN
    PERFORM agent_undo_plan_suggestion(a, 'plan_risk', risk, u1, since, r2);
    PERFORM pg_temp.ok(false, 'another run''s card must not be undone');
  EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
  END;

  -- ------------------------------------------------------------ 1.22.1 rules unchanged
  PERFORM pg_temp.ok(pg_temp.codes(agent_undo_blockers(a, 'task', person_item, u1, since, r)) LIKE '%has_links%', 'task branch as before: a person''s item in a plan');

  -- ------------------------------------------------------------ claim and state know the kinds
  UPDATE agent_actions SET status = 'executed', undo_until = now() + interval '5 minutes' WHERE run_id = r;
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_undo_state(a, u1, ARRAY[act_risk, act_sh, act_dep, act_dates, act_bl])) >= 5, 'undo state lists all five');
  PERFORM pg_temp.ok((SELECT count(*) FROM agent_claim_undo(a, u1, false, ARRAY[act_risk, act_sh, act_dep, act_dates, act_bl])) >= 5, 'all five can be claimed');
END $$;

\echo 'agent plan suggestions integration: all checks passed'
ROLLBACK;
