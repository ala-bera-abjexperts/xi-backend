-- Run only against a confirmed disposable database (e.g. xisuite-infra harness) with migration
-- 20260922140100_drain_claim_tokens applied. Everything is rolled back. Needs one organization
-- row: pass it as  psql -v org=<organizations.id> -f test/drain-claims.integration.sql
\set ON_ERROR_STOP on
\if :{?org}
\else
\echo usage: psql -v org=<organization-id> -f test/drain-claims.integration.sql
\quit
\endif
BEGIN;
INSERT INTO spaces(id,organization_id,name,key) VALUES ('00000000-0000-0000-0000-0000000000cc',:'org','Claims','CLM');
INSERT INTO tasks(id,organization_id,space_id,task_type_id,summary) VALUES ('00000000-0000-0000-0000-0000000000c1',:'org','00000000-0000-0000-0000-0000000000cc','task','claims');
INSERT INTO workflow_outbox(id,organization_id,task_id,rule_type,payload,status,next_attempt_at)
VALUES ('00000000-0000-0000-0000-0000000000d1',:'org','00000000-0000-0000-0000-0000000000c1','webhook','{}','pending',now()-interval '1 minute');
DO $$
DECLARE r workflow_outbox; tok1 uuid; tok2 uuid; n int;
BEGIN
  SELECT * INTO r FROM drain_workflow_outbox(50) WHERE id='00000000-0000-0000-0000-0000000000d1';
  IF r.claim_token IS NULL OR r.claimed_at IS NULL THEN RAISE EXCEPTION 'claim did not stamp token'; END IF;
  tok1 := r.claim_token;
  -- claimed 2 minutes ago (old code reclaimed after 60 s): must NOT be handed out again
  UPDATE workflow_outbox SET claimed_at=now()-interval '2 minutes', updated_at=now()-interval '2 minutes' WHERE id=r.id;
  SELECT count(*) INTO n FROM drain_workflow_outbox(50) WHERE id=r.id;
  IF n <> 0 THEN RAISE EXCEPTION 'row reclaimed after only 2 minutes'; END IF;
  IF (SELECT claim_token FROM workflow_outbox WHERE id=r.id) <> tok1 THEN RAISE EXCEPTION 'token changed without reclaim'; END IF;
  -- claimed 16 minutes ago: abandoned -> reclaimed with a NEW token
  UPDATE workflow_outbox SET claimed_at=now()-interval '16 minutes' WHERE id=r.id;
  SELECT claim_token INTO tok2 FROM drain_workflow_outbox(50) WHERE id=r.id;
  IF tok2 IS NULL OR tok2 = tok1 THEN RAISE EXCEPTION 'stale row not reclaimed with a fresh token'; END IF;
  -- the slow original worker finishing late (fenced on its old token) records nothing
  UPDATE workflow_outbox SET status='succeeded' WHERE id=r.id AND status='in_progress' AND claim_token=tok1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'stale worker overwrote a reclaimed row'; END IF;
  -- the current holder's fenced write succeeds
  UPDATE workflow_outbox SET status='succeeded' WHERE id=r.id AND status='in_progress' AND claim_token=tok2;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'current claim holder could not complete'; END IF;
  -- a row claimed by an OLD backend (no claimed_at) falls back to updated_at
  -- the updated_at trigger would overwrite back-dated timestamps; an old backend's claim just keeps its claim time
  ALTER TABLE workflow_outbox DISABLE TRIGGER trg_workflow_outbox_updated_at;
  UPDATE workflow_outbox SET status='in_progress', claim_token=NULL, claimed_at=NULL, updated_at=now()-interval '2 minutes' WHERE id=r.id;
  SELECT count(*) INTO n FROM drain_workflow_outbox(50) WHERE id=r.id;
  IF n <> 0 THEN RAISE EXCEPTION 'legacy claim reclaimed after 2 minutes'; END IF;
  UPDATE workflow_outbox SET updated_at=now()-interval '16 minutes' WHERE id=r.id;
  ALTER TABLE workflow_outbox ENABLE TRIGGER trg_workflow_outbox_updated_at;
  SELECT count(*) INTO n FROM drain_workflow_outbox(50) WHERE id=r.id;
  IF n <> 1 THEN RAISE EXCEPTION 'legacy stale claim not reclaimed'; END IF;
  RAISE NOTICE 'claim-token checks passed';
END $$;
ROLLBACK;
