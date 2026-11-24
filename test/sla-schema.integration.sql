-- Run only against a confirmed disposable database with both XE-T422 migrations.
-- Every fixture is rolled back; no existing tenant rows are read or changed.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
IF has_function_privilege('authenticated','public.sla_publish_customer_reply(uuid,uuid,uuid,uuid,uuid,text)','EXECUTE') THEN RAISE EXCEPTION 'Requester can call staff publication RPC'; END IF;
IF has_table_privilege('authenticated','public.support_customer_replies','INSERT') THEN RAISE EXCEPTION 'Requester can forge publication'; END IF;
IF has_table_privilege('authenticated','public.sla_task_events','SELECT') THEN RAISE EXCEPTION 'Task evidence leaked to browser'; END IF;
END $$;
INSERT INTO organizations(id,name,size,slug) VALUES('42200000-0000-0000-0000-000000000001','SLA disposable','small','sla-disposable');
INSERT INTO users(id,email) VALUES('42200000-0000-0000-0000-000000000002','sla-disposable@example.invalid');
INSERT INTO spaces(id,organization_id,name,key) VALUES('42200000-0000-0000-0000-000000000003','42200000-0000-0000-0000-000000000001','SLA','SLATEST');
INSERT INTO custom_fields(id,organization_id,space_id,scope,contexts,name,field_key,field_type) VALUES('42200000-0000-0000-0000-000000000004','42200000-0000-0000-0000-000000000001','42200000-0000-0000-0000-000000000003','space','["task"]','Response SLA','sla_response','sla_time');
INSERT INTO tasks(id,organization_id,space_id,task_type_id,summary) VALUES('42200000-0000-0000-0000-000000000005','42200000-0000-0000-0000-000000000001','42200000-0000-0000-0000-000000000003','task','SLA check');
DO $$ DECLARE cal sla_calendars; met sla_metrics;op sla_workflow_operations;s sla_task_streams;r support_customer_replies;n integer; BEGIN
cal:=sla_save_calendar('42200000-0000-0000-0000-000000000001','42200000-0000-0000-0000-000000000003',NULL,NULL,'Work','{"timezone":"UTC","weekly":{"1":[{"startMinute":480,"endMinute":1020}]},"holidays":[]}');
met:=sla_save_metric('42200000-0000-0000-0000-000000000001','42200000-0000-0000-0000-000000000003','42200000-0000-0000-0000-000000000004',NULL,jsonb_build_object('cycle_mode','once','fulfillment','customer_reply','goals',jsonb_build_array(jsonb_build_object('id','goal','target_ms',1000,'calendar_revision_id',cal.current_revision_id))));
PERFORM sla_activate_metric(met.id);
IF NOT (SELECT enabled AND activation_complete FROM sla_metrics WHERE id=met.id) THEN RAISE EXCEPTION 'activation failed'; END IF;
-- Configured revisions must survive deletion attempts before the worker creates any cycle.
IF EXISTS(SELECT 1 FROM sla_cycles WHERE metric_id=met.id) THEN RAISE EXCEPTION 'Pre-cycle deletion fixture is not empty'; END IF;
BEGIN
DELETE FROM custom_fields WHERE id='42200000-0000-0000-0000-000000000004';
RAISE EXCEPTION 'Configured field with queued events was physically deleted';
EXCEPTION WHEN raise_exception THEN
IF SQLERRM='Configured field with queued events was physically deleted' THEN RAISE; END IF;
END;
IF NOT EXISTS(SELECT 1 FROM sla_metric_revisions WHERE id=met.current_revision_id) THEN RAISE EXCEPTION 'Queued metric revision disappeared'; END IF;

SELECT sequence INTO n FROM sla_task_streams WHERE task_id='42200000-0000-0000-0000-000000000005';
op:=sla_begin_workflow('42200000-0000-0000-0000-000000000005','42200000-0000-0000-0000-000000000001',0,(SELECT updated_at FROM tasks WHERE id='42200000-0000-0000-0000-000000000005'));
PERFORM sla_write_workflow_task(op.task_id,op.token,'{"status":"in_progress","summary":"temporary"}');
IF (SELECT sequence FROM sla_task_streams WHERE task_id=op.task_id)<>n THEN RAISE EXCEPTION 'Intermediate workflow event'; END IF;
PERFORM sla_finish_workflow(op.task_id,op.token,true);
IF (SELECT summary FROM tasks WHERE id=op.task_id)<>'SLA check' THEN RAISE EXCEPTION 'Compensation failed'; END IF;
IF (SELECT sequence FROM sla_task_streams WHERE task_id=op.task_id)<>n+1 THEN RAISE EXCEPTION 'Final event missing'; END IF;
SELECT * INTO s FROM sla_claim_streams(1);
IF NOT sla_commit_stream(s.task_id,s.lease_token,s.processed_sequence,s.sequence,'[]') THEN RAISE EXCEPTION 'CAS failed'; END IF;
IF sla_commit_stream(s.task_id,s.lease_token,s.processed_sequence,s.sequence,'[]') THEN RAISE EXCEPTION 'Duplicate CAS accepted'; END IF;
BEGIN UPDATE tasks SET custom_field_values='{"sla_response":3}' WHERE id=op.task_id; RAISE EXCEPTION 'forged value accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='forged value accepted' THEN RAISE; END IF; END;

-- Expired workflow recovery compensates and fences the old token.
op:=sla_begin_workflow(op.task_id,'42200000-0000-0000-0000-000000000001',(SELECT version FROM tasks WHERE id=op.task_id),(SELECT updated_at FROM tasks WHERE id=op.task_id));
PERFORM sla_write_workflow_task(op.task_id,op.token,'{"summary":"expired temporary"}');
UPDATE sla_workflow_operations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=op.id;
IF sla_recover_workflows(10)<>1 THEN RAISE EXCEPTION 'Recovery did not claim operation'; END IF;
IF (SELECT summary FROM tasks WHERE id=op.task_id)<>'SLA check' THEN RAISE EXCEPTION 'Recovery did not compensate'; END IF;
BEGIN PERFORM sla_write_workflow_task(op.task_id,op.token,'{"summary":"stale"}'); RAISE EXCEPTION 'Stale token accepted'; EXCEPTION WHEN no_data_found THEN NULL; END;
END $$;
INSERT INTO support_requests(id,organization_id,created_by,ticket_number,subject,category,description,space_id) VALUES('42200000-0000-0000-0000-000000000006','42200000-0000-0000-0000-000000000001','42200000-0000-0000-0000-000000000002',422,'SLA','general','check','42200000-0000-0000-0000-000000000003');
SELECT sla_link_request_task('42200000-0000-0000-0000-000000000006','42200000-0000-0000-0000-000000000005','42200000-0000-0000-0000-000000000001');
SELECT sla_publish_customer_reply('42200000-0000-0000-0000-000000000006','42200000-0000-0000-0000-000000000005','42200000-0000-0000-0000-000000000001','42200000-0000-0000-0000-000000000002','42200000-0000-0000-0000-000000000007','Safe reply');
SELECT sla_publish_customer_reply('42200000-0000-0000-0000-000000000006','42200000-0000-0000-0000-000000000005','42200000-0000-0000-0000-000000000001','42200000-0000-0000-0000-000000000002','42200000-0000-0000-0000-000000000007','Safe reply');
DO $$ BEGIN IF (SELECT count(*) FROM sla_reply_evidence)<>1 THEN RAISE EXCEPTION 'Duplicate evidence'; END IF; END $$;

DO $$ BEGIN
BEGIN PERFORM sla_link_request_task('42200000-0000-0000-0000-000000000006',NULL,'42200000-0000-0000-0000-000000000001'); RAISE EXCEPTION 'Unlocked published request'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='Unlocked published request' THEN RAISE; END IF; END;
END $$;
INSERT INTO tasks(id,organization_id,space_id,task_type_id,summary,sla_ready) VALUES('42200000-0000-0000-0000-000000000008','42200000-0000-0000-0000-000000000001','42200000-0000-0000-0000-000000000003','task','Pending import',false);
DO $$ BEGIN
IF EXISTS(SELECT 1 FROM sla_task_events WHERE task_id='42200000-0000-0000-0000-000000000008') THEN RAISE EXCEPTION 'Import captured before ready'; END IF;
PERFORM sla_mark_task_ready('42200000-0000-0000-0000-000000000008');
IF (SELECT count(*) FROM sla_task_events WHERE task_id='42200000-0000-0000-0000-000000000008')<>1 THEN RAISE EXCEPTION 'Import final snapshot missing'; END IF;
END $$;

-- Aggregate before pagination: 20,001 completed cycles on the same metric.
INSERT INTO sla_cycles(id,task_id,organization_id,space_id,metric_id,metric_revision_id,cycle_number,lifecycle,outcome,state,started_at,completed_at,elapsed_ms,target_ms,updated_at)
SELECT gen_random_uuid(),'42200000-0000-0000-0000-000000000005',m.organization_id,m.space_id,m.id,m.current_revision_id,n,'completed',CASE WHEN n%2=0 THEN 'met' ELSE 'breached' END,'{}','2026-09-01 00:00:00+00','2026-09-05 23:30:00+00',CASE WHEN n%2=0 THEN 1000 ELSE 1001 END,1000,'2026-09-05 23:30:00+00'
FROM sla_metrics m CROSS JOIN generate_series(1,20001) n;
INSERT INTO sla_cycles(id,task_id,organization_id,space_id,metric_id,metric_revision_id,cycle_number,lifecycle,outcome,state,started_at,elapsed_ms,target_ms)
SELECT gen_random_uuid(),'42200000-0000-0000-0000-000000000005',m.organization_id,m.space_id,m.id,m.current_revision_id,20002,'active','breached','{"paused":true,"calendar":{"timezone":"UTC"}}','2026-09-05',2000,1000 FROM sla_metrics m;
INSERT INTO sla_cycles(id,task_id,organization_id,space_id,metric_id,metric_revision_id,cycle_number,lifecycle,outcome,state,started_at,elapsed_ms,target_ms)
SELECT gen_random_uuid(),'42200000-0000-0000-0000-000000000008',m.organization_id,m.space_id,m.id,m.current_revision_id,1,'active','breached','{"paused":false,"calendar":{"timezone":"UTC"}}','2026-09-05',1500,1000 FROM sla_metrics m;
DO $$ DECLARE report jsonb; timeline jsonb; total bigint;values jsonb;fields jsonb;BEGIN
report:=sla_report('42200000-0000-0000-0000-000000000001','42200000-0000-0000-0000-000000000003',NULL,'completed_pie','Asia/Kolkata','2026-09-06','2026-09-06','day',NULL);
IF (report->>'cycles')::bigint<>20001 OR (report->>'met')::bigint<>10000 OR (report->>'breached')::bigint<>10001 THEN RAISE EXCEPTION 'Completed cohort truncated: %',report; END IF;
timeline:=sla_report('42200000-0000-0000-0000-000000000001','42200000-0000-0000-0000-000000000003',NULL,'completed_timeline','Asia/Kolkata','2026-09-05','2026-09-07','day',NULL);
SELECT sum((b->>'cycles')::bigint) INTO total FROM jsonb_array_elements(timeline->'buckets') b;
IF total<>20001 OR jsonb_array_length(timeline->'buckets')<>3 OR timeline->'buckets'->0->>'cycles'<>'0' THEN RAISE EXCEPTION 'Timeline does not match cohort'; END IF;
report:=sla_report('42200000-0000-0000-0000-000000000001','42200000-0000-0000-0000-000000000003',NULL,'completed_pie','UTC','2027-01-01','2027-01-01','day',NULL);
IF report->>'cycles'<>'0' OR report->'rate'<>'null'::jsonb THEN RAISE EXCEPTION 'Zero denominator is not empty'; END IF;
report:=sla_report('42200000-0000-0000-0000-000000000001','42200000-0000-0000-0000-000000000003',NULL,'active_breached','UTC','2026-09-01','2026-09-30','day',NULL,0,1);
IF report->>'total'<>'2' OR jsonb_array_length(report->'rows')<>1 OR report->'rows'->0->>'lifecycle'<>'paused' THEN RAISE EXCEPTION 'Active paused pagination wrong'; END IF;
report:=sla_report('42200000-0000-0000-0000-000000000001','42200000-0000-0000-0000-000000000003',NULL,'active_breached','UTC','2026-09-01','2026-09-30','day',NULL,1,1);
IF report->>'total'<>'2' OR report->'rows'->0->>'lifecycle'<>'running' THEN RAISE EXCEPTION 'Active next page wrong'; END IF;
values:='{"priority":"high","labels":["a","b"],"due_date":"2026-09-06T00:00:00+05:30","assigned_to":null}';
fields:='[{"id":"priority","type":"string"},{"id":"labels","type":"string[]"},{"id":"due_date","type":"date"},{"id":"assigned_to","type":"string"}]';
IF NOT sla_report_rule('{"combinator":"and","rules":[{"field":"assigned_to","operator":"null"},{"combinator":"or","rules":[{"field":"priority","operator":"=","value":"high"},{"field":"labels","operator":"contains","value":"z"}]},{"combinator":"and","not":true,"rules":[{"field":"labels","operator":"contains","value":"z"}]}]}',values,fields) THEN RAISE EXCEPTION 'Nested null rule failed'; END IF;
IF NOT sla_report_rule('{"field":"labels","operator":"in","value":["b","c"]}',values,fields) THEN RAISE EXCEPTION 'Multivalue rule failed'; END IF;
IF NOT sla_report_rule('{"field":"due_date","operator":"=","value":"2026-09-05T18:30:00Z"}',values,fields) THEN RAISE EXCEPTION 'Date instant comparison failed'; END IF;
IF sla_report_rule('{"field":"assigned_to","operator":"!=","value":"someone"}',values,fields) THEN RAISE EXCEPTION 'Null comparison did not fail closed'; END IF;
BEGIN PERFORM sla_report_rule('{"field":"unknown","operator":"=","value":"x"}',values,fields); RAISE EXCEPTION 'Unknown rule field accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='Unknown rule field accepted' THEN RAISE; END IF; END;
END $$;
INSERT INTO custom_fields(id,organization_id,space_id,scope,contexts,name,field_key,field_type) VALUES('42200000-0000-0000-0000-000000000009','42200000-0000-0000-0000-000000000001','42200000-0000-0000-0000-000000000003','space','["task"]','SLA filter check','filter_check','string');
UPDATE tasks SET custom_field_values='{"filter_check":"captured"}' WHERE id='42200000-0000-0000-0000-000000000005';
DO $$ DECLARE snapshot jsonb;BEGIN
SELECT sla_snapshot(to_jsonb(t)) INTO snapshot FROM tasks t WHERE id='42200000-0000-0000-0000-000000000005';
IF NOT sla_report_rule('{"field":"cf_42200000-0000-0000-0000-000000000009","operator":"=","value":"captured"}',snapshot,'[{"id":"cf_42200000-0000-0000-0000-000000000009","type":"string"}]') THEN RAISE EXCEPTION 'Stored custom field identity mismatch'; END IF;
IF snapshot->>'customer_reply_published'<>'true' THEN RAISE EXCEPTION 'Existing reply evidence missing'; END IF;
END $$;


-- Lease rotation prevents active streams from starving later tasks.
DO $$ DECLARE first_claim sla_task_streams;next_claim sla_task_streams;BEGIN
SELECT * INTO first_claim FROM sla_claim_streams(1);
IF NOT sla_commit_stream(first_claim.task_id,first_claim.lease_token,first_claim.processed_sequence,first_claim.sequence,'[]',first_claim.sequence) THEN RAISE EXCEPTION 'First lease commit failed'; END IF;
SELECT * INTO next_claim FROM sla_claim_streams(1);
IF first_claim.task_id=next_claim.task_id THEN RAISE EXCEPTION 'Lease claim starved next task'; END IF;
UPDATE tasks SET summary=summary||' update' WHERE id=next_claim.task_id;
IF sla_commit_stream(next_claim.task_id,next_claim.lease_token,next_claim.processed_sequence,next_claim.sequence,'[]',next_claim.sequence) THEN RAISE EXCEPTION 'CAS accepted concurrent event'; END IF;
END $$;

-- A cron candidate fetched before explicit disable must not re-enable enrollment.
DO $$ DECLARE m sla_metrics;before_sequence bigint;result jsonb;BEGIN
SELECT * INTO STRICT m FROM sla_metrics WHERE field_id='42200000-0000-0000-0000-000000000004';
UPDATE sla_metrics SET activation_complete=false,activation_cursor=NULL WHERE id=m.id;
PERFORM sla_set_metric_enabled(m.id,m.current_revision_id,false);
SELECT sequence INTO before_sequence FROM sla_task_streams WHERE task_id='42200000-0000-0000-0000-000000000005';
result:=sla_resume_metric_activation(m.id,500);
IF (SELECT enabled FROM sla_metrics WHERE id=m.id) THEN RAISE EXCEPTION 'Stale cron candidate re-enabled metric'; END IF;
IF (SELECT sequence FROM sla_task_streams WHERE task_id='42200000-0000-0000-0000-000000000005')<>before_sequence THEN RAISE EXCEPTION 'Disabled metric captured activation'; END IF;
PERFORM sla_set_metric_enabled(m.id,m.current_revision_id,true);
IF NOT (SELECT enabled AND activation_complete FROM sla_metrics WHERE id=m.id) THEN RAISE EXCEPTION 'Explicit reactivation failed'; END IF;
UPDATE sla_metrics SET activation_complete=false,activation_cursor=NULL WHERE id=m.id;
PERFORM sla_resume_metric_activation(m.id,500);
IF NOT (SELECT enabled AND activation_complete FROM sla_metrics WHERE id=m.id) THEN RAISE EXCEPTION 'Enabled cron resumption failed'; END IF;
IF has_function_privilege('authenticated','public.sla_resume_metric_activation(uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Browser can resume activation'; END IF;
END $$;

-- Configuration diagnostics count only each task/metric's newest cycle and honor filters.
DO $$ DECLARE m sla_metrics;other sla_metrics;r jsonb;BEGIN
SELECT * INTO STRICT m FROM sla_metrics WHERE field_id='42200000-0000-0000-0000-000000000004';
UPDATE sla_cycles SET lifecycle='cancelled' WHERE task_id='42200000-0000-0000-0000-000000000005' AND lifecycle='active';
INSERT INTO sla_cycles(id,task_id,organization_id,space_id,metric_id,metric_revision_id,cycle_number,lifecycle,state,elapsed_ms,target_ms)
VALUES(gen_random_uuid(),'42200000-0000-0000-0000-000000000005',m.organization_id,m.space_id,m.id,m.current_revision_id,20003,'invalid','{"error":"historical invalid"}',0,0),
(gen_random_uuid(),'42200000-0000-0000-0000-000000000005',m.organization_id,m.space_id,m.id,m.current_revision_id,20004,'not_applicable','{}',0,0);
UPDATE sla_cycles SET lifecycle='invalid',state='{"error":"current invalid"}' WHERE task_id='42200000-0000-0000-0000-000000000008' AND lifecycle='active';
INSERT INTO custom_fields(id,organization_id,space_id,scope,contexts,name,field_key,field_type) VALUES('42200000-0000-0000-0000-000000000010',m.organization_id,m.space_id,'space','["task"]','Other SLA','other_sla','sla_time');
other:=sla_save_metric(m.organization_id,m.space_id,'42200000-0000-0000-0000-000000000010',NULL,(SELECT config FROM sla_metric_revisions WHERE id=m.current_revision_id));
INSERT INTO sla_cycles(id,task_id,organization_id,space_id,metric_id,metric_revision_id,cycle_number,lifecycle,state,elapsed_ms,target_ms)
VALUES(gen_random_uuid(),'42200000-0000-0000-0000-000000000005',m.organization_id,m.space_id,other.id,other.current_revision_id,1,'invalid','{"error":"other metric invalid"}',0,0);
UPDATE sla_task_streams SET processing_error='worker unavailable' WHERE task_id='42200000-0000-0000-0000-000000000005';
r:=sla_report(m.organization_id,m.space_id,NULL,'completed_pie','UTC','2026-09-01','2026-09-30','day',NULL);
IF coalesce((r->>'configuration_errors')::int,-1)<>2 OR (r->>'processing_errors')::int<>3 OR (r->>'stream_processing_errors')::int<>1 THEN RAISE EXCEPTION 'Latest error count wrong: %',r; END IF;
r:=sla_report(m.organization_id,m.space_id,ARRAY[m.id],'completed_pie','UTC','2026-09-01','2026-09-30','day',NULL);
IF (r->>'configuration_errors')::int<>1 OR (r->>'processing_errors')::int<>2 THEN RAISE EXCEPTION 'Metric filtered error count wrong'; END IF;
r:=sla_report(m.organization_id,m.space_id,ARRAY[m.id],'completed_pie','UTC','2026-09-01','2026-09-30','day','{"query":{"field":"summary","operator":"contains","value":"Pending"},"fields":[{"id":"summary","type":"string"}]}');
IF (r->>'configuration_errors')::int<>1 OR (r->>'processing_errors')::int<>1 OR (r->>'stream_processing_errors')::int<>0 THEN RAISE EXCEPTION 'Task filtered error count wrong'; END IF;
r:=sla_report(m.organization_id,m.space_id,NULL,'completed_pie','UTC','2026-09-01','2026-09-30','day','{"query":{"field":"summary","operator":"=","value":"not a task"},"fields":[{"id":"summary","type":"string"}]}');
IF (r->>'configuration_errors')::int<>0 OR (r->>'processing_errors')::int<>0 THEN RAISE EXCEPTION 'Excluded errors leaked'; END IF;
END $$;
-- Removing the field disables new enrollment without deleting completed history.
UPDATE custom_fields SET is_active=false WHERE id='42200000-0000-0000-0000-000000000004';
DO $$ BEGIN
IF EXISTS(SELECT 1 FROM sla_metrics WHERE enabled) THEN RAISE EXCEPTION 'Inactive field kept metric enabled'; END IF;
IF (SELECT count(*) FROM sla_cycles WHERE lifecycle='completed')<>20001 THEN RAISE EXCEPTION 'Field removal erased history'; END IF;
END $$;
UPDATE spaces SET is_archived=true WHERE id='42200000-0000-0000-0000-000000000003';
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM sla_task_events WHERE kind='scope_changed' AND after_snapshot->>'scope_active'='false') THEN RAISE EXCEPTION 'Archive not captured'; END IF; END $$;
ROLLBACK;
