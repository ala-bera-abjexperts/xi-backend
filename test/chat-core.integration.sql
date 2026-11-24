-- XE-T353 chat core: database integration checks.
-- Run only against a confirmed disposable database (local Supabase or the xisuite-infra harness)
-- with migrations 20260928120000..20261011100200 applied. Everything is rolled back. It creates
-- its own two organizations, users and spaces, so it needs no parameters:
--   psql -f test/chat-core.integration.sql
-- Success prints "chat-core integration: all checks passed"; any failure aborts with the reason.
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

-- ---------------------------------------------------------------- fixtures
-- Org A: u1 owner, u2..u4 members.  Org B: u9 owner.  S1 = active space, S2 = archived space.
INSERT INTO organizations (id, name, slug, size) VALUES
  ('c0000000-0000-0000-0000-00000000000a', 'Chat IT A', 'chat-it-a', '1-10'),
  ('c0000000-0000-0000-0000-00000000000b', 'Chat IT B', 'chat-it-b', '1-10');
INSERT INTO users (id, email, first_name) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'chat-it-u1@example.invalid', 'U1'),
  ('c0000000-0000-0000-0000-000000000002', 'chat-it-u2@example.invalid', 'U2'),
  ('c0000000-0000-0000-0000-000000000003', 'chat-it-u3@example.invalid', 'U3'),
  ('c0000000-0000-0000-0000-000000000004', 'chat-it-u4@example.invalid', 'U4'),
  ('c0000000-0000-0000-0000-000000000009', 'chat-it-u9@example.invalid', 'U9');
INSERT INTO organization_members (organization_id, user_id, role) VALUES
  ('c0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000001', 'owner'),
  ('c0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000002', 'member'),
  ('c0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000003', 'member'),
  ('c0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000004', 'member'),
  ('c0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-000000000009', 'owner');
INSERT INTO spaces (id, organization_id, name, key) VALUES
  ('c0000000-0000-0000-0000-0000000000e1', 'c0000000-0000-0000-0000-00000000000a', 'Chat IT Space', 'CHATIT1'),
  ('c0000000-0000-0000-0000-0000000000e2', 'c0000000-0000-0000-0000-00000000000a', 'Chat IT Archived', 'CHATIT2');
UPDATE spaces SET is_archived = true WHERE id = 'c0000000-0000-0000-0000-0000000000e2';

-- ---------------------------------------------------------------- grants and wiring
DO $$
BEGIN
  PERFORM pg_temp.ok(NOT has_function_privilege('anon', 'public.chat_post_message(uuid,uuid,uuid,uuid,text,text,uuid,uuid,jsonb,jsonb)', 'EXECUTE'), 'anon cannot execute chat_post_message');
  PERFORM pg_temp.ok(NOT has_function_privilege('authenticated', 'public.chat_get_or_create_dm(uuid,uuid,uuid)', 'EXECUTE'), 'authenticated cannot execute chat_get_or_create_dm');
  PERFORM pg_temp.ok(has_function_privilege('service_role', 'public.chat_post_message(uuid,uuid,uuid,uuid,text,text,uuid,uuid,jsonb,jsonb)', 'EXECUTE'), 'service_role can execute chat_post_message');
  PERFORM pg_temp.ok(has_function_privilege('service_role', 'public.delete_space_rows_batch(uuid,integer)', 'EXECUTE'), 'delete_space_rows_batch grant kept');
  PERFORM pg_temp.ok(NOT has_function_privilege('anon', 'public.delete_space_rows_batch(uuid,integer)', 'EXECUTE'), 'delete_space_rows_batch still closed to anon');
  PERFORM pg_temp.ok(NOT has_table_privilege('anon', 'public.chat_messages', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.chat_conversations', 'SELECT')
    AND has_table_privilege('service_role', 'public.chat_messages', 'INSERT'), 'chat tables reachable by service_role only');
  PERFORM pg_temp.ok((SELECT count(*) FROM pg_policies WHERE schemaname = 'realtime' AND policyname IN ('chat_topics_read', 'chat_topics_presence_write')) = 2, 'realtime chat policies exist');
  PERFORM pg_temp.ok((SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN (
    'public.chat_conversations'::regclass, 'public.chat_members'::regclass, 'public.chat_messages'::regclass,
    'public.chat_message_versions'::regclass, 'public.chat_message_refs'::regclass,
    'public.chat_reactions'::regclass, 'public.chat_user_settings'::regclass)), 'RLS enabled on every chat table');
END $$;

-- file_attachments accepts chat messages and still rejects unknown types.
INSERT INTO file_attachments (organization_id, entity_type, entity_id, file_name)
VALUES ('c0000000-0000-0000-0000-00000000000a', 'chat_message', gen_random_uuid(), 'a.pdf');
SELECT pg_temp.expect_error($q$INSERT INTO file_attachments (organization_id, entity_type, entity_id, file_name)
  VALUES ('c0000000-0000-0000-0000-00000000000a', 'nonsense', gen_random_uuid(), 'b.pdf')$q$, '23514');

-- ---------------------------------------------------------------- DMs (CHAT-01/02)
DO $$
DECLARE
  a uuid := 'c0000000-0000-0000-0000-00000000000a';
  u1 uuid := 'c0000000-0000-0000-0000-000000000001';
  u2 uuid := 'c0000000-0000-0000-0000-000000000002';
  d1 uuid; d2 uuid; self_dm uuid;
BEGIN
  d1 := chat_get_or_create_dm(a, u1, u2);
  d2 := chat_get_or_create_dm(a, u2, u1);
  PERFORM pg_temp.ok(d1 = d2, 'one DM per pair regardless of order');
  PERFORM pg_temp.ok((SELECT count(*) FROM chat_members WHERE conversation_id = d1) = 2, 'DM has two members');
  self_dm := chat_get_or_create_dm(a, u1, u1);
  PERFORM pg_temp.ok(self_dm <> d1 AND (SELECT count(*) FROM chat_members WHERE conversation_id = self_dm) = 1, 'self-DM has one member');

  -- A member row that vanished is restored on the next open.
  DELETE FROM chat_members WHERE conversation_id = d1 AND user_id = u2;
  PERFORM pg_temp.ok(chat_get_or_create_dm(a, u2, u1) = d1, 'DM reopened, same conversation');
  PERFORM pg_temp.ok((SELECT count(*) FROM chat_members WHERE conversation_id = d1) = 2, 'missing DM member restored');
END $$;

-- Cross-tenant: a DM with a user of another organization is refused.
SELECT pg_temp.expect_error($q$SELECT chat_get_or_create_dm('c0000000-0000-0000-0000-00000000000a',
  'c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000009')$q$, '42501');

-- ---------------------------------------------------------------- posting (CHAT-05/15)
DO $$
DECLARE
  a uuid := 'c0000000-0000-0000-0000-00000000000a';
  b uuid := 'c0000000-0000-0000-0000-00000000000b';
  u1 uuid := 'c0000000-0000-0000-0000-000000000001';
  u2 uuid := 'c0000000-0000-0000-0000-000000000002';
  u3 uuid := 'c0000000-0000-0000-0000-000000000003';
  u9 uuid := 'c0000000-0000-0000-0000-000000000009';
  d1 uuid := chat_get_or_create_dm(a, u1, u2);
  r record;
BEGIN
  SELECT * INTO r FROM chat_post_message(a, d1, 'd0000000-0000-0000-0000-000000000001', u1, '<p>first</p>', 'first');
  PERFORM pg_temp.ok(r.message_seq = 1 AND NOT r.duplicate, 'first message gets seq 1');
  SELECT * INTO r FROM chat_post_message(a, d1, 'd0000000-0000-0000-0000-000000000001', u1, '<p>first</p>', 'first');
  PERFORM pg_temp.ok(r.message_seq = 1 AND r.duplicate, 'resend with the same id is idempotent');
  PERFORM pg_temp.ok((SELECT last_seq FROM chat_conversations WHERE id = d1) = 1, 'resend does not advance seq');

  SELECT * INTO r FROM chat_post_message(a, d1, 'd0000000-0000-0000-0000-000000000002', u2, '<p>second</p>', 'second');
  PERFORM pg_temp.ok(r.message_seq = 2, 'second message gets seq 2');

  PERFORM pg_temp.ok((SELECT last_read_seq FROM chat_members WHERE conversation_id = d1 AND user_id = u2) = 2, 'own message is read');
  PERFORM pg_temp.ok((SELECT unread_count FROM chat_unread_summary(a, u1) WHERE conversation_id = d1) = 1, 'u1 has one unread');
  PERFORM pg_temp.ok((SELECT unread_count FROM chat_unread_summary(a, u2) WHERE conversation_id = d1) = 0, 'u2 has no unread');

  PERFORM pg_temp.expect_error(format('SELECT * FROM chat_post_message(%L, %L, %L, %L, %L, %L)',
    a, d1, 'd0000000-0000-0000-0000-000000000001', u2, 'x', 'x'), '23505');   -- id reused by another author
  PERFORM pg_temp.expect_error(format('SELECT * FROM chat_post_message(%L, %L, %L, %L, %L, %L)',
    a, d1, gen_random_uuid(), u3, 'x', 'x'), '42501');                          -- not a DM member
  PERFORM pg_temp.expect_error(format('SELECT * FROM chat_post_message(%L, %L, %L, %L, %L, %L)',
    b, d1, gen_random_uuid(), u9, 'x', 'x'), 'P0002');                          -- other tenant
  PERFORM pg_temp.expect_error(format('SELECT * FROM chat_post_message(%L, %L, NULL, %L, %L, %L)',
    a, d1, u1, 'x', 'x'), '22023');                                             -- id required
  PERFORM pg_temp.expect_error(format('SELECT * FROM chat_post_message(%L, %L, %L, %L, %L, %L)',
    a, d1, gen_random_uuid(), u1, 'x', repeat('y', 10001)), '23514');           -- body too long
  PERFORM pg_temp.expect_error(format('SELECT * FROM chat_post_message(%L, %L, %L, %L, %L, %L, NULL, NULL, %L)',
    a, d1, gen_random_uuid(), u1, 'x', 'x', '[{"type":"spaceship","id":"c0000000-0000-0000-0000-000000000001"}]'), '22023');
END $$;

-- ---------------------------------------------------------------- mentions, read position (CHAT-06/14)
DO $$
DECLARE
  a uuid := 'c0000000-0000-0000-0000-00000000000a';
  u1 uuid := 'c0000000-0000-0000-0000-000000000001';
  u2 uuid := 'c0000000-0000-0000-0000-000000000002';
  d1 uuid := chat_get_or_create_dm(a, u1, u2);
  s record;
BEGIN
  PERFORM chat_post_message(a, d1, 'd0000000-0000-0000-0000-000000000003', u1, '<p>@U2 look</p>', '@U2 look',
    NULL, NULL, jsonb_build_array(jsonb_build_object('type', 'user', 'id', u2), jsonb_build_object('type', 'task', 'id', gen_random_uuid())));
  SELECT * INTO s FROM chat_unread_summary(a, u2) WHERE conversation_id = d1;
  PERFORM pg_temp.ok(s.unread_count = 1 AND s.mention_count = 1, 'u2 has one unread mention');

  PERFORM pg_temp.ok(chat_set_read_position(a, d1, u2, 999) = 3, 'read position is capped at last_seq');
  SELECT * INTO s FROM chat_unread_summary(a, u2) WHERE conversation_id = d1;
  PERFORM pg_temp.ok(s.unread_count = 0 AND s.mention_count = 0, 'reading clears unread and mentions');

  PERFORM pg_temp.ok(chat_set_read_position(a, d1, u2, 1) = 3, 'read position never moves back by default');
  PERFORM pg_temp.ok(chat_set_read_position(a, d1, u2, 1, true) = 1, 'mark as unread moves back');
  SELECT * INTO s FROM chat_unread_summary(a, u2) WHERE conversation_id = d1;
  PERFORM pg_temp.ok(s.unread_count = 2 AND s.mention_count = 1, 'mark as unread restores counts');

  UPDATE chat_members SET muted_until = now() + interval '1 hour' WHERE conversation_id = d1 AND user_id = u2;
  PERFORM pg_temp.ok((SELECT muted FROM chat_unread_summary(a, u2) WHERE conversation_id = d1), 'mute is reported');
  PERFORM pg_temp.expect_error(format('SELECT chat_set_read_position(%L, %L, %L, 1)',
    a, d1, 'c0000000-0000-0000-0000-000000000003'), '42501');                   -- not a member
END $$;

-- ---------------------------------------------------------------- threads and quotes (CHAT-11, CHAT-09 BR-6)
DO $$
DECLARE
  a uuid := 'c0000000-0000-0000-0000-00000000000a';
  u1 uuid := 'c0000000-0000-0000-0000-000000000001';
  u2 uuid := 'c0000000-0000-0000-0000-000000000002';
  d1 uuid := chat_get_or_create_dm(a, u1, u2);
  other uuid := chat_get_or_create_dm(a, u1, 'c0000000-0000-0000-0000-000000000003');
BEGIN
  PERFORM chat_post_message(a, d1, 'd0000000-0000-0000-0000-000000000011', u2, 'reply', 'reply', 'd0000000-0000-0000-0000-000000000001');
  PERFORM pg_temp.ok((SELECT reply_count FROM chat_messages WHERE id = 'd0000000-0000-0000-0000-000000000001') = 1, 'reply counted on root');
  PERFORM pg_temp.expect_error(format('SELECT * FROM chat_post_message(%L, %L, %L, %L, %L, %L, %L)',
    a, d1, gen_random_uuid(), u1, 'x', 'x', 'd0000000-0000-0000-0000-000000000011'), '22023');  -- reply to a reply
  PERFORM pg_temp.expect_error(format('SELECT * FROM chat_post_message(%L, %L, %L, %L, %L, %L, %L)',
    a, other, gen_random_uuid(), u1, 'x', 'x', 'd0000000-0000-0000-0000-000000000001'), '22023'); -- root in another conversation

  PERFORM chat_post_message(a, d1, 'd0000000-0000-0000-0000-000000000012', u1, 'quoting', 'quoting', NULL, 'd0000000-0000-0000-0000-000000000002');
  PERFORM pg_temp.ok((SELECT quote_snapshot->>'body_text' FROM chat_messages WHERE id = 'd0000000-0000-0000-0000-000000000012') = 'second', 'quote snapshot taken');
END $$;

-- ---------------------------------------------------------------- edit history (CHAT-09)
DO $$
DECLARE
  a uuid := 'c0000000-0000-0000-0000-00000000000a';
  u1 uuid := 'c0000000-0000-0000-0000-000000000001';
  u2 uuid := 'c0000000-0000-0000-0000-000000000002';
  u3 uuid := 'c0000000-0000-0000-0000-000000000003';
  u4 uuid := 'c0000000-0000-0000-0000-000000000004';
  m uuid := 'd0000000-0000-0000-0000-000000000002';  -- authored by u2
  added uuid[];
  i int;
BEGIN
  FOR i IN 1..5 LOOP
    PERFORM chat_edit_message(a, m, u2, 'v' || i, 'v' || i);
  END LOOP;
  PERFORM pg_temp.ok((SELECT edit_count FROM chat_messages WHERE id = m) = 5, '5 edits counted');
  PERFORM pg_temp.ok((SELECT count(*) FROM chat_message_versions WHERE message_id = m) = 5, '5 previous versions + current = 6 versions');
  PERFORM pg_temp.ok((SELECT body_text FROM chat_message_versions WHERE message_id = m AND version = 1) = 'second', 'version 1 is the original');
  PERFORM pg_temp.ok((SELECT quote_snapshot->>'body_text' FROM chat_messages WHERE id = 'd0000000-0000-0000-0000-000000000012') = 'second', 'quote unchanged after edits');

  PERFORM pg_temp.ok(cardinality(chat_edit_message(a, m, u2, 'v5', 'v5')) = 0
    AND (SELECT edit_count FROM chat_messages WHERE id = m) = 5, 'unchanged edit is a no-op');

  added := chat_edit_message(a, m, u2, 'hi @U3', 'hi @U3', jsonb_build_array(jsonb_build_object('type', 'user', 'id', u3)));
  PERFORM pg_temp.ok(added = ARRAY[u3], 'new mention returned');
  added := chat_edit_message(a, m, u2, 'hi @U3 @U4 @U2', 'hi @U3 @U4 @U2', jsonb_build_array(
    jsonb_build_object('type', 'user', 'id', u3), jsonb_build_object('type', 'user', 'id', u4), jsonb_build_object('type', 'user', 'id', u2)));
  PERFORM pg_temp.ok(added = ARRAY[u4], 'only newly added mentions returned, never the editor');

  PERFORM pg_temp.expect_error(format('SELECT chat_edit_message(%L, %L, %L, %L, %L)', a, m, u1, 'x', 'x'), '42501'); -- not the author
END $$;

-- ---------------------------------------------------------------- delete (CHAT-10)
DO $$
DECLARE
  a uuid := 'c0000000-0000-0000-0000-00000000000a';
  u1 uuid := 'c0000000-0000-0000-0000-000000000001';  -- org owner
  u2 uuid := 'c0000000-0000-0000-0000-000000000002';
BEGIN
  PERFORM chat_post_message(a, chat_get_or_create_dm(a, u1, u2), 'd0000000-0000-0000-0000-000000000021', u1, 'pin me', 'pin me');
  UPDATE chat_messages SET pinned_at = now(), pinned_by = u1 WHERE id = 'd0000000-0000-0000-0000-000000000021';
  PERFORM pg_temp.expect_error(format('SELECT chat_delete_message(%L, %L, %L)', a, 'd0000000-0000-0000-0000-000000000021', u2), '42501');
  PERFORM pg_temp.ok(chat_delete_message(a, 'd0000000-0000-0000-0000-000000000002', u1), 'org owner deletes any message');
  PERFORM pg_temp.ok(NOT chat_delete_message(a, 'd0000000-0000-0000-0000-000000000002', u1), 'second delete is a no-op');
  PERFORM pg_temp.ok(chat_delete_message(a, 'd0000000-0000-0000-0000-000000000021', u1), 'author deletes own');
  PERFORM pg_temp.ok((SELECT pinned_at IS NULL AND body_text = 'pin me' FROM chat_messages WHERE id = 'd0000000-0000-0000-0000-000000000021'),
    'tombstone unpins and retains content');
  PERFORM pg_temp.expect_error(format('SELECT chat_edit_message(%L, %L, %L, %L, %L)', a, 'd0000000-0000-0000-0000-000000000021', u1, 'x', 'x'), '42501');
  PERFORM pg_temp.ok((SELECT last_message_deleted AND last_message_preview IS NULL
    FROM chat_unread_summary(a, u2) WHERE conversation_id = chat_get_or_create_dm(a, u1, u2)),
    'inbox never previews a deleted last message');
  -- u2's own thread reply (seq 4) moved their read position past the seq-3 mention, and the
  -- seq-2 message that mentions u2 is deleted (and self-authored): nothing may count.
  PERFORM pg_temp.ok((SELECT mention_count FROM chat_unread_summary(a, u2) WHERE conversation_id = chat_get_or_create_dm(a, u1, u2)) = 0,
    'own post marks earlier mentions read; deleted mentions never count');
END $$;

-- ---------------------------------------------------------------- delete any message (ADM-08)
-- p_can_delete_any: NULL = owner/admin rule as before, true/false = the backend's permission answer.
DO $$
DECLARE
  a uuid := 'c0000000-0000-0000-0000-00000000000a';
  u1 uuid := 'c0000000-0000-0000-0000-000000000001';  -- org owner
  u2 uuid := 'c0000000-0000-0000-0000-000000000002';  -- author
  u4 uuid := 'c0000000-0000-0000-0000-000000000004';  -- plain member
  u5 uuid := 'c0000000-0000-0000-0000-000000000005';  -- org admin
  g uuid;
  i int;
BEGIN
  INSERT INTO users (id, email, first_name) VALUES (u5, 'chat-it-u5@example.invalid', 'U5');
  INSERT INTO organization_members (organization_id, user_id, role) VALUES (a, u5, 'admin');
  g := chat_create_group(a, u2, 'Delete any', ARRAY[u4]);
  FOR i IN 1..7 LOOP
    PERFORM chat_post_message(a, g, ('d0000000-0000-0000-0000-0000000000a' || i)::uuid, u2, 'del', 'del');
  END LOOP;

  PERFORM pg_temp.ok(to_regprocedure('public.chat_delete_message(uuid,uuid,uuid)') IS NULL, 'three-argument chat_delete_message is gone (no PostgREST overload)');
  -- The backend calls by argument name.
  PERFORM pg_temp.ok(pg_get_function_arguments('public.chat_delete_message(uuid,uuid,uuid,boolean)'::regprocedure)
    = 'p_organization_id uuid, p_message_id uuid, p_actor_id uuid, p_can_delete_any boolean DEFAULT NULL::boolean', 'chat_delete_message keeps its argument names');
  PERFORM pg_temp.ok(has_function_privilege('service_role', 'public.chat_delete_message(uuid,uuid,uuid,boolean)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.chat_delete_message(uuid,uuid,uuid,boolean)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.chat_delete_message(uuid,uuid,uuid,boolean)', 'EXECUTE'),
    'chat_delete_message is executable by service_role only');

  -- The author may always delete, whatever the flag says.
  PERFORM pg_temp.ok(chat_delete_message(a, 'd0000000-0000-0000-0000-0000000000a1', u2, NULL), 'author deletes own, flag NULL');
  PERFORM pg_temp.ok(chat_delete_message(a, 'd0000000-0000-0000-0000-0000000000a2', u2, true), 'author deletes own, flag true');
  PERFORM pg_temp.ok(chat_delete_message(a, 'd0000000-0000-0000-0000-0000000000a3', u2, false), 'author deletes own, flag false');

  -- A plain member needs the permission.
  PERFORM pg_temp.expect_error(format('SELECT chat_delete_message(%L, %L, %L, NULL)', a, 'd0000000-0000-0000-0000-0000000000a4', u4), '42501');
  PERFORM pg_temp.expect_error(format('SELECT chat_delete_message(%L, %L, %L, false)', a, 'd0000000-0000-0000-0000-0000000000a4', u4), '42501');
  PERFORM pg_temp.ok(chat_delete_message(a, 'd0000000-0000-0000-0000-0000000000a4', u4, true), 'plain member with the permission deletes any');

  -- An admin deletes by role only while the flag is NULL; false takes it away.
  PERFORM pg_temp.ok(chat_delete_message(a, 'd0000000-0000-0000-0000-0000000000a5', u5, NULL), 'admin deletes any, flag NULL (old rule)');
  PERFORM pg_temp.expect_error(format('SELECT chat_delete_message(%L, %L, %L, false)', a, 'd0000000-0000-0000-0000-0000000000a6', u5), '42501');
  PERFORM pg_temp.ok(chat_delete_message(a, 'd0000000-0000-0000-0000-0000000000a6', u5, true), 'admin deletes any, flag true');
  PERFORM pg_temp.expect_error(format('SELECT chat_delete_message(%L, %L, %L, false)', a, 'd0000000-0000-0000-0000-0000000000a7', u1), '42501'); -- owner without the permission

  -- The flag never lets in someone from outside the organization.
  PERFORM pg_temp.expect_error(format('SELECT chat_delete_message(%L, %L, %L, true)', a, 'd0000000-0000-0000-0000-0000000000a7', 'c0000000-0000-0000-0000-000000000009'), '42501');
  -- Nor does it reach a message of another organization, or a system message.
  PERFORM pg_temp.expect_error(format('SELECT chat_delete_message(%L, %L, %L, true)', 'c0000000-0000-0000-0000-00000000000b', 'd0000000-0000-0000-0000-0000000000a7', 'c0000000-0000-0000-0000-000000000009'), 'P0002');
  PERFORM pg_temp.expect_error(format('SELECT chat_delete_message(%L, %L, %L, true)', a, (SELECT id FROM chat_messages WHERE conversation_id = g AND kind = 'system' LIMIT 1), u4), '42501');
  PERFORM pg_temp.ok((SELECT deleted_at IS NULL FROM chat_messages WHERE id = 'd0000000-0000-0000-0000-0000000000a7'), 'refused deletes change nothing');
END $$;

-- ---------------------------------------------------------------- notification rules (CHAT-16)
DO $$
DECLARE
  a uuid := 'c0000000-0000-0000-0000-00000000000a';
  b uuid := 'c0000000-0000-0000-0000-00000000000b';
  u1 uuid := 'c0000000-0000-0000-0000-000000000001';
  u2 uuid := 'c0000000-0000-0000-0000-000000000002';
  u4 uuid := 'c0000000-0000-0000-0000-000000000004';
  u9 uuid := 'c0000000-0000-0000-0000-000000000009';
  dq uuid := chat_get_or_create_dm(a, u2, u4);
  m uuid := 'd0000000-0000-0000-0000-0000000000b1';
  q chat_notification_queue;
  ins text := 'INSERT INTO chat_notification_queue (organization_id, user_id, conversation_id, message_id, seq, reason, stage, due_at) VALUES (%L, %L, %L, %L, 1, %L, %L, %s)';
BEGIN
  -- Settings: email fallback delay and "mute mentions too".
  INSERT INTO chat_user_settings (organization_id, user_id) VALUES (a, u2);
  PERFORM pg_temp.ok((SELECT email_fallback AND email_fallback_minutes = 30 FROM chat_user_settings WHERE organization_id = a AND user_id = u2),
    'email fallback defaults to on, after 30 minutes');
  UPDATE chat_user_settings SET email_fallback_minutes = 15 WHERE organization_id = a AND user_id = u2;
  UPDATE chat_user_settings SET email_fallback_minutes = 60 WHERE organization_id = a AND user_id = u2;
  PERFORM pg_temp.expect_error(format('UPDATE chat_user_settings SET email_fallback_minutes = 45 WHERE organization_id = %L AND user_id = %L', a, u2), '23514');
  PERFORM pg_temp.expect_error(format('UPDATE chat_user_settings SET email_fallback_minutes = 0 WHERE organization_id = %L AND user_id = %L', a, u2), '23514');
  PERFORM pg_temp.expect_error(format('UPDATE chat_user_settings SET email_fallback_minutes = NULL WHERE organization_id = %L AND user_id = %L', a, u2), '23502');

  PERFORM pg_temp.ok((SELECT NOT bool_or(mute_mentions) FROM chat_members WHERE organization_id = a), 'mute_mentions defaults to false');
  PERFORM pg_temp.expect_error(format('UPDATE chat_members SET mute_mentions = NULL WHERE conversation_id = %L', dq), '23502');

  -- Queue: wiring.
  PERFORM pg_temp.ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.chat_notification_queue'::regclass)
    AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_notification_queue'),
    'queue has RLS enabled and no policies');
  PERFORM pg_temp.ok(NOT has_table_privilege('anon', 'public.chat_notification_queue', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.chat_notification_queue', 'SELECT')
    AND has_table_privilege('service_role', 'public.chat_notification_queue', 'INSERT')
    AND has_table_privilege('service_role', 'public.chat_notification_queue', 'DELETE'), 'queue reachable by service_role only');
  PERFORM pg_temp.ok((SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'
    AND indexname IN ('chat_notification_queue_due_idx', 'chat_notification_queue_message_idx')) = 2, 'queue indexes exist');
  PERFORM pg_temp.ok(pg_get_indexdef('public.chat_message_refs_user_conv_idx'::regclass)
    LIKE '%(ref_id, conversation_id) WHERE (ref_type = ''user''::text)', 'mention lookup index is partial on user refs');

  -- Queue: defaults and constraints.
  PERFORM chat_post_message(a, dq, m, u2, 'queue me', 'queue me');
  INSERT INTO chat_notification_queue (organization_id, user_id, conversation_id, message_id, seq, reason, stage, due_at)
  VALUES (a, u4, dq, m, 1, 'dm', 'held', now()) RETURNING * INTO q;
  PERFORM pg_temp.ok(q.id IS NOT NULL AND q.attempts = 0 AND q.claimed_at IS NULL AND q.actor_id IS NULL AND q.created_at IS NOT NULL, 'queue defaults');

  PERFORM pg_temp.expect_error(format(ins, a, u4, dq, m, 'mention', 'email', 'now()'), '23505');        -- one row per user and message
  PERFORM pg_temp.expect_error(format(ins, a, u1, dq, m, 'plain', 'held', 'now()'), '23514');           -- unknown reason
  PERFORM pg_temp.expect_error(format(ins, a, u1, dq, m, 'dm', 'sent', 'now()'), '23514');              -- unknown stage
  PERFORM pg_temp.expect_error(format(ins, a, u1, dq, m, 'dm', 'held', 'NULL'), '23502');               -- due_at required
  PERFORM pg_temp.expect_error(format(ins, a, u9, dq, m, 'dm', 'held', 'now()'), '23503');              -- user of another organization
  PERFORM pg_temp.expect_error(format(ins, b, u9, dq, m, 'dm', 'held', 'now()'), '23503');              -- message of another organization
  PERFORM pg_temp.expect_error(format(ins, a, u1, dq, gen_random_uuid(), 'dm', 'held', 'now()'), '23503'); -- no such message

  -- The same message for another user, with the other reasons and stage.
  EXECUTE format(ins, a, u1, dq, m, 'mention', 'email', 'now()');
  EXECUTE format(ins, a, u2, dq, m, 'thread_reply', 'held', 'now()');
  PERFORM pg_temp.ok((SELECT count(*) FROM chat_notification_queue WHERE message_id = m) = 3, 'one queue row per user for the same message');

  -- A tombstone keeps the rows (the sweep drops them); a hard delete takes them along.
  PERFORM chat_delete_message(a, m, u2);
  PERFORM pg_temp.ok((SELECT count(*) FROM chat_notification_queue WHERE message_id = m) = 3, 'a tombstone keeps queue rows');
  DELETE FROM chat_messages WHERE id = m;
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_notification_queue WHERE message_id = m), 'hard-deleting a message removes its queue rows');
END $$;

-- ---------------------------------------------------------------- search (CHAT-17)
-- Named arguments with defaults, so each check only names what it sets.
CREATE FUNCTION pg_temp.search(
  p_org uuid, p_user uuid, p_q text DEFAULT NULL, p_not text DEFAULT NULL, p_space_ids uuid[] DEFAULT NULL,
  p_conversation_id uuid DEFAULT NULL, p_author_id uuid DEFAULT NULL, p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL, p_has_attachment boolean DEFAULT NULL, p_has_object boolean DEFAULT NULL,
  p_object_type text DEFAULT NULL, p_pinned boolean DEFAULT NULL, p_mentions_me boolean DEFAULT NULL,
  p_before_created_at timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL, p_limit int DEFAULT 50
) RETURNS TABLE (message_id uuid, conversation_id uuid, created_at timestamptz, matched_on text, snippet text, object_refs jsonb)
LANGUAGE sql AS $$
  SELECT * FROM public.chat_search_messages(p_org, p_user, p_space_ids, p_q, p_not, p_conversation_id, p_author_id,
    p_from, p_to, p_has_attachment, p_has_object, p_object_type, p_pinned, p_mentions_me,
    p_before_created_at, p_before_id, p_limit);
$$;

DO $$
DECLARE
  a uuid := 'c0000000-0000-0000-0000-00000000000a';
  b uuid := 'c0000000-0000-0000-0000-00000000000b';
  u1 uuid := 'c0000000-0000-0000-0000-000000000001';
  u2 uuid := 'c0000000-0000-0000-0000-000000000002';
  u3 uuid := 'c0000000-0000-0000-0000-000000000003';
  u4 uuid := 'c0000000-0000-0000-0000-000000000004';
  u9 uuid := 'c0000000-0000-0000-0000-000000000009';
  s1 uuid := 'c0000000-0000-0000-0000-0000000000e1';
  s3 uuid := 'c0000000-0000-0000-0000-0000000000e3';
  task uuid := 'c0000000-0000-0000-0000-0000000000f7';
  page uuid := 'c0000000-0000-0000-0000-0000000000f8';
  s01 uuid := 'd1000000-0000-0000-0000-000000000001';  s02 uuid := 'd1000000-0000-0000-0000-000000000002';
  s03 uuid := 'd1000000-0000-0000-0000-000000000003';  s04 uuid := 'd1000000-0000-0000-0000-000000000004';
  s05 uuid := 'd1000000-0000-0000-0000-000000000005';  s06 uuid := 'd1000000-0000-0000-0000-000000000006';
  s07 uuid := 'd1000000-0000-0000-0000-000000000007';  s08 uuid := 'd1000000-0000-0000-0000-000000000008';
  s09 uuid := 'd1000000-0000-0000-0000-000000000009';  s10 uuid := 'd1000000-0000-0000-0000-000000000010';
  s11 uuid := 'd1000000-0000-0000-0000-000000000011';  s12 uuid := 'd1000000-0000-0000-0000-000000000012';
  s13 uuid := 'd1000000-0000-0000-0000-000000000013';
  l01 uuid := 'd1000000-0000-0000-0000-000000000021';  -- in a group u2 left
  c01 uuid := 'd1000000-0000-0000-0000-000000000031';  -- in the channel of space s3
  b01 uuid := 'd1000000-0000-0000-0000-000000000041';  b02 uuid := 'd1000000-0000-0000-0000-000000000042';  -- organization B
  b03 uuid := 'd1000000-0000-0000-0000-000000000043';  -- in the channel of organization B's space sb
  sb uuid := 'c0000000-0000-0000-0000-0000000000e9';
  a7 uuid := 'd0000000-0000-0000-0000-0000000000a7';   -- "del", in the group of u2 and u4 (block above)
  fa uuid := 'c0000000-0000-0000-0000-0000000000a1';
  fv uuid := 'c0000000-0000-0000-0000-0000000000a2';
  gs uuid; g2 uuid; ch3 uuid; chb uuid; db uuid;
  q text;
  r record;
  kept uuid[] := '{}';
  pages int := 0;
  cur_at timestamptz; cur_id uuid;
BEGIN
  -- ---- fixtures: group gs (u1, u2; u4 joins "from now on" after s04)
  gs := chat_create_group(a, u1, 'Search', ARRAY[u2]);
  PERFORM chat_post_message(a, gs, s01, u1, 'x', 'Die Rechnungen sind bezahlt');
  PERFORM chat_post_message(a, gs, s02, u2, 'x', 'Please send the invoices today');
  PERFORM chat_post_message(a, gs, s03, u1, 'x', 'Rechnung vom Lieferanten erhalten');
  PERFORM chat_post_message(a, gs, s04, u2, 'x', 'Rechnung ohne weitere Angaben');
  PERFORM chat_add_members(a, gs, u1, ARRAY[u4], false, true);
  PERFORM chat_post_message(a, gs, s05, u1, 'x', 'Rechnung nach dem Beitritt');
  PERFORM chat_post_message(a, gs, s06, u1, 'x', 'Rechnung wird gleich entfernt');
  PERFORM chat_delete_message(a, s06, u1);

  INSERT INTO spaces (id, organization_id, name, key) VALUES (s3, a, 'Chat IT Search', 'CHATIT3');
  INSERT INTO tasks (id, organization_id, space_id, task_type_id, summary, key) VALUES (task, a, s3, 'task', 'Firewall Regeln prüfen', 'CHATIT3-T77');
  INSERT INTO wiki_pages (id, organization_id, space_id, title, slug) VALUES (page, a, s3, 'Onboarding Handbuch', 'chat-it-handbuch');

  PERFORM chat_post_message(a, gs, s07, u2, 'x', 'siehe Anhang');
  PERFORM chat_post_message(a, gs, s08, u2, 'x', 'bitte ansehen', NULL, NULL, jsonb_build_array(jsonb_build_object('type', 'task', 'id', task)));
  PERFORM chat_post_message(a, gs, s09, u1, 'x', '@U2 kurze Frage', NULL, NULL, jsonb_build_array(jsonb_build_object('type', 'user', 'id', u2)));
  PERFORM chat_post_message(a, gs, s10, u1, 'x', 'wichtig angepinnt');
  UPDATE chat_messages SET pinned_at = now(), pinned_by = u1 WHERE id = s10;
  PERFORM chat_post_message(a, gs, s11, u2, 'x', 'steht im Wiki', NULL, NULL, jsonb_build_array(jsonb_build_object('type', 'wiki_page', 'id', page)));
  PERFORM chat_post_message(a, gs, s12, u2, 'x', 'Upload noch offen');
  PERFORM chat_post_message(a, gs, s13, u1, 'x', 'Firewall Thema', NULL, NULL, jsonb_build_array(jsonb_build_object('type', 'task', 'id', task)));

  -- s07 has a finished upload, s12 one that never got a version (not shown, so not searchable),
  -- s03 a finished upload from before u4's cut-off.
  INSERT INTO file_attachments (id, organization_id, entity_type, entity_id, file_name) VALUES
    (fa, a, 'chat_message', s07, 'Quartalsbericht-2026.pdf'),
    ('c0000000-0000-0000-0000-0000000000a7', a, 'chat_message', s03, 'Lieferanten-Altvertrag.pdf');
  INSERT INTO file_versions (id, attachment_id, version_number, file_path, file_size, mime_type) VALUES
    (fv, fa, 1, 'chat-it/q.pdf', 1, 'application/pdf'),
    ('c0000000-0000-0000-0000-0000000000a8', 'c0000000-0000-0000-0000-0000000000a7', 1, 'chat-it/a.pdf', 1, 'application/pdf');
  UPDATE file_attachments SET current_version_id = fv WHERE id = fa;
  UPDATE file_attachments SET current_version_id = 'c0000000-0000-0000-0000-0000000000a8' WHERE id = 'c0000000-0000-0000-0000-0000000000a7';
  INSERT INTO file_attachments (organization_id, entity_type, entity_id, file_name) VALUES (a, 'chat_message', s12, 'Quartalsbericht-Entwurf.pdf');

  -- two messages get their own dates (everything else shares this transaction's timestamp).
  UPDATE chat_messages SET created_at = '2026-01-10 12:00:00+00' WHERE id = s01;
  UPDATE chat_messages SET created_at = '2026-02-10 12:00:00+00' WHERE id = s02;

  g2 := chat_create_group(a, u1, 'Left', ARRAY[u2]);
  PERFORM chat_post_message(a, g2, l01, u1, 'x', 'Rechnung in verlassener Gruppe');
  PERFORM chat_leave(a, g2, u2);

  ch3 := chat_get_or_create_space_channel(a, s3);
  PERFORM chat_post_message(a, ch3, c01, u2, 'x', 'Rechnung im Kanal');

  -- organization B: same words, same file name, and cards pointing at organization A's task and page.
  db := chat_get_or_create_dm(b, u9, u9);
  PERFORM chat_post_message(b, db, b01, u9, 'x', 'Rechnung aus Organisation B');
  PERFORM chat_post_message(b, db, b02, u9, 'x', 'fremde Karten', NULL, NULL, jsonb_build_array(
    jsonb_build_object('type', 'task', 'id', task), jsonb_build_object('type', 'wiki_page', 'id', page)));
  INSERT INTO file_attachments (id, organization_id, entity_type, entity_id, file_name) VALUES ('c0000000-0000-0000-0000-0000000000a3', b, 'chat_message', b01, 'Quartalsbericht-2026.pdf');
  INSERT INTO file_versions (id, attachment_id, version_number, file_path, file_size, mime_type) VALUES ('c0000000-0000-0000-0000-0000000000a4', 'c0000000-0000-0000-0000-0000000000a3', 1, 'chat-it/b.pdf', 1, 'application/pdf');
  UPDATE file_attachments SET current_version_id = 'c0000000-0000-0000-0000-0000000000a4' WHERE id = 'c0000000-0000-0000-0000-0000000000a3';
  -- file_attachments has no FK to the message: a row of organization B can name a message of A.
  INSERT INTO file_attachments (id, organization_id, entity_type, entity_id, file_name) VALUES ('c0000000-0000-0000-0000-0000000000a5', b, 'chat_message', s10, 'Geheimbericht.pdf');
  INSERT INTO file_versions (id, attachment_id, version_number, file_path, file_size, mime_type) VALUES ('c0000000-0000-0000-0000-0000000000a6', 'c0000000-0000-0000-0000-0000000000a5', 1, 'chat-it/g.pdf', 1, 'application/pdf');
  UPDATE file_attachments SET current_version_id = 'c0000000-0000-0000-0000-0000000000a6' WHERE id = 'c0000000-0000-0000-0000-0000000000a5';
  -- and a space channel of its own: a caller who may read every space of A must not reach it.
  INSERT INTO spaces (id, organization_id, name, key) VALUES (sb, b, 'Chat IT B Space', 'CHATIT9');
  chb := chat_get_or_create_space_channel(b, sb);
  PERFORM chat_post_message(b, chb, b03, u9, 'x', 'Mahnung im Kanal von B');

  -- ---- wiring
  PERFORM pg_temp.ok((SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute t ON t.attrelid = d.adrelid AND t.attnum = d.adnum
    WHERE t.attrelid = 'public.chat_messages'::regclass AND t.attname = 'search_vector')
    = '((to_tsvector(''german''::regconfig, body_text) || to_tsvector(''english''::regconfig, body_text)) || to_tsvector(''simple''::regconfig, body_text))',
    'search_vector is german || english || simple');
  PERFORM pg_temp.ok(pg_get_indexdef('public.chat_messages_search_idx'::regclass) LIKE '%USING gin (search_vector)', 'search index kept its name');
  PERFORM pg_temp.ok(pg_get_indexdef('public.file_attachments_chat_name_trgm_idx'::regclass)
    LIKE '%USING gin (file_name %gin_trgm_ops) WHERE (entity_type = ''chat_message''::text)', 'trigram index on chat file names');
  PERFORM pg_temp.ok(has_function_privilege('service_role', 'public.chat_search_messages(uuid,uuid,uuid[],text,text,uuid,uuid,timestamptz,timestamptz,boolean,boolean,text,boolean,boolean,timestamptz,uuid,integer)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.chat_search_messages(uuid,uuid,uuid[],text,text,uuid,uuid,timestamptz,timestamptz,boolean,boolean,text,boolean,boolean,timestamptz,uuid,integer)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.chat_search_messages(uuid,uuid,uuid[],text,text,uuid,uuid,timestamptz,timestamptz,boolean,boolean,text,boolean,boolean,timestamptz,uuid,integer)', 'EXECUTE'),
    'chat_search_messages is executable by service_role only');
  -- The backend calls by argument name and reads the result by column name.
  PERFORM pg_temp.ok((SELECT p.provolatile = 's' AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
      AND pg_get_function_arguments(p.oid) = 'p_organization_id uuid, p_user_id uuid, p_space_ids uuid[], p_q text, p_not text, p_conversation_id uuid, p_author_id uuid, '
        || 'p_from timestamp with time zone, p_to timestamp with time zone, p_has_attachment boolean, p_has_object boolean, p_object_type text, p_pinned boolean, '
        || 'p_mentions_me boolean, p_before_created_at timestamp with time zone, p_before_id uuid, p_limit integer'
      AND pg_get_function_result(p.oid) = 'TABLE(message_id uuid, conversation_id uuid, created_at timestamp with time zone, matched_on text, snippet text, object_refs jsonb)'
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'chat_search_messages'),
    'chat_search_messages: one function, STABLE, caller''s rights, fixed search_path, agreed argument and column names');
  -- Its filters are "(unset OR condition)": a cached generic plan could not drop the unset ones.
  PERFORM pg_temp.ok((SELECT p.proconfig @> ARRAY['plan_cache_mode=force_custom_plan'] FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'chat_search_messages'),
    'chat_search_messages is planned for the actual values on every call');

  -- ---- words (BR-6): German and English stemming, snippet markers
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'Rechnung', p_conversation_id => gs) ORDER BY 1) = ARRAY[s01, s03, s04, s05],
    '"Rechnung" finds "Rechnungen"; the deleted message never matches');
  SELECT * INTO r FROM pg_temp.search(a, u1, 'Rechnung', p_conversation_id => gs) WHERE message_id = s01;
  PERFORM pg_temp.ok(r.matched_on = 'text' AND r.snippet = chr(2) || 'Rechnungen' || chr(3) || ' sind bezahlt' AND r.object_refs = '[]'::jsonb
    AND r.conversation_id = gs AND r.created_at = '2026-01-10 12:00:00+00', format('text hit carries a marked snippet, got %L', r.snippet));
  SELECT * INTO r FROM pg_temp.search(a, u1, 'invoice');
  PERFORM pg_temp.ok(r.message_id = s02 AND r.snippet LIKE '%' || chr(2) || 'invoices' || chr(3) || '%', '"invoice" finds "invoices"');
  -- The query is stemmed per language as well: only German turns "Rechnungen" into "Rechnung", only English "sending" into "send".
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'Rechnungen', p_conversation_id => gs) ORDER BY 1) = ARRAY[s01, s03, s04, s05], '"Rechnungen" finds "Rechnung"');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'sending')) = ARRAY[s02], '"sending" finds "send"');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, '"ohne weitere"')) = ARRAY[s04], 'quoted phrase');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'entfernt')), 'deleted message is not searchable');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, '...')), 'a query without any word finds nothing');
  -- "in" is a stop word in German and in English; only the plain form keeps it.
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'in') WHERE matched_on = 'text') = ARRAY[l01], 'a word both languages drop is still found in plain form');

  -- ---- negation. The three language forms OR-ed together would MATCH the supplier message
  -- (English stems "lieferant" to "liefer", which "Lieferanten" does not contain), hence p_not.
  PERFORM pg_temp.ok((SELECT search_vector @@ (websearch_to_tsquery('german', 'rechnung -lieferant')
    || websearch_to_tsquery('english', 'rechnung -lieferant') || websearch_to_tsquery('simple', 'rechnung -lieferant'))
    FROM chat_messages WHERE id = s03), 'premise: OR-ed negation wrongly matches the message with both words');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'rechnung', 'lieferant', p_conversation_id => gs) ORDER BY 1) = ARRAY[s01, s04, s05],
    '"rechnung -lieferant" excludes the message containing both words');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'rechnung', '  lieferant   beitritt ', p_conversation_id => gs) ORDER BY 1) = ARRAY[s01, s04],
    'any excluded word excludes');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, NULL, 'rechnungen sending', p_conversation_id => gs) ORDER BY 1) = ARRAY[s07, s08, s09, s10, s11, s12, s13]
    AND ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'Rechnung', 'in') ORDER BY 1) = ARRAY[s01, s03, s04, s05, c01],
    'exclusion is stemmed in German and English and also works on the plain form');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, NULL, 'rechnung', p_conversation_id => gs) ORDER BY 1) = ARRAY[s02, s07, s08, s09, s10, s11, s12, s13],
    'exclusion alone works with a filter');

  -- ---- filters only: no text condition, matched_on = filter
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, p_conversation_id => gs, p_author_id => u2) ORDER BY 1) = ARRAY[s02, s04, s07, s08, s11, s12],
    'author filter without text');
  PERFORM pg_temp.ok((SELECT bool_and(matched_on = 'filter' AND snippet IS NULL AND object_refs = '[]'::jsonb)
    FROM pg_temp.search(a, u1, '   ', p_conversation_id => gs, p_author_id => u2)), 'empty text means matched_on = filter, no snippet');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'Rechnung', p_author_id => u2, p_space_ids => '{}')) = ARRAY[s04], 'text and author together (AC-1)');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, p_conversation_id => gs, p_from => '2026-02-01+00', p_to => '2026-02-28+00')) = ARRAY[s02], 'date range');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, p_conversation_id => gs, p_from => '2026-01-10 12:00:00+00', p_to => '2026-02-10 12:00:00+00') ORDER BY 1) = ARRAY[s01, s02],
    'date bounds are inclusive');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, p_conversation_id => gs, p_pinned => true)) = ARRAY[s10], 'pinned filter');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u2, p_conversation_id => gs, p_mentions_me => true)) = ARRAY[s09], 'mentions me');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, p_conversation_id => gs, p_mentions_me => true)), 'mentions of someone else are not mine');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, p_conversation_id => gs, p_has_attachment => true) ORDER BY 1) = ARRAY[s03, s07],
    'has attachment ignores unfinished uploads and file rows of another organization');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, p_conversation_id => gs, p_has_object => true) ORDER BY 1) = ARRAY[s08, s11, s13], 'has object (mentions are not objects)');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, p_conversation_id => gs, p_has_object => true, p_object_type => 'task') ORDER BY 1) = ARRAY[s08, s13], 'object type task');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, p_conversation_id => gs, p_object_type => 'wiki_page')) = ARRAY[s11], 'object type alone implies has object');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, p_conversation_id => gs, p_object_type => 'user')), 'object type user finds nothing');
  PERFORM pg_temp.ok((SELECT count(*) FROM pg_temp.search(a, u1, p_conversation_id => gs, p_pinned => false, p_has_attachment => false, p_has_object => false, p_mentions_me => false)) = 12,
    'false does not narrow (same as NULL)');

  -- ---- file names and object titles (BR-1)
  SELECT * INTO r FROM pg_temp.search(a, u1, 'quartalsbericht');
  PERFORM pg_temp.ok(r.message_id = s07 AND r.matched_on = 'file' AND r.snippet IS NULL AND r.object_refs = '[]'::jsonb
    AND (SELECT count(*) FROM pg_temp.search(a, u1, 'quartalsbericht')) = 1, 'file name match, only for a finished upload');
  SELECT * INTO r FROM pg_temp.search(a, u1, 'lieferanten');
  PERFORM pg_temp.ok(r.message_id = s03 AND r.matched_on = 'text' AND r.snippet LIKE '%' || chr(2) || 'Lieferanten' || chr(3) || '%',
    'text wins over file when both match, and keeps its snippet');
  PERFORM pg_temp.ok(ARRAY(SELECT matched_on || ':' || message_id FROM pg_temp.search(a, u1, 'firewall') ORDER BY message_id) = ARRAY['object:' || s08, 'text:' || s13],
    'task title match; text wins over object when both match');
  PERFORM pg_temp.ok((SELECT bool_and(object_refs = jsonb_build_array(jsonb_build_object('type', 'task', 'id', task))) FROM pg_temp.search(a, u1, 'firewall')),
    'object_refs lists the task whose title matched');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'chatit3-t77') ORDER BY 1) = ARRAY[s08, s13], 'task key match');
  SELECT * INTO r FROM pg_temp.search(a, u1, 'handbuch');
  PERFORM pg_temp.ok(r.message_id = s11 AND r.matched_on = 'object' AND r.snippet IS NULL AND r.object_refs = jsonb_build_array(jsonb_build_object('type', 'wiki_page', 'id', page)), 'wiki page title match');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, '%')) AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, '_')), 'LIKE wildcards in the query are literal');

  -- ---- object titles only from spaces the caller may view. The task and the page live in s3;
  -- the group gs stays readable whatever p_space_ids says, and s13 also matches by its own text.
  PERFORM pg_temp.ok(ARRAY(SELECT matched_on || ':' || message_id || ':' || object_refs::text FROM pg_temp.search(a, u1, 'firewall', p_space_ids => ARRAY[s1])) = ARRAY['text:' || s13 || ':[]'],
    'a task in a space outside p_space_ids: no object hit, and no object_refs entry on the text hit either');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'chatit3-t77', p_space_ids => ARRAY[s1]))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'handbuch', p_space_ids => ARRAY[s1]))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'handbuch', p_space_ids => '{}'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'firewall', p_space_ids => '{}') WHERE matched_on = 'object' OR object_refs <> '[]'::jsonb),
    'task key and wiki page title in a space outside p_space_ids never match');
  PERFORM pg_temp.ok(ARRAY(SELECT matched_on || ':' || message_id FROM pg_temp.search(a, u1, 'firewall', p_space_ids => ARRAY[s1, s3]) ORDER BY message_id) = ARRAY['object:' || s08, 'text:' || s13]
    AND (SELECT bool_and(object_refs = jsonb_build_array(jsonb_build_object('type', 'task', 'id', task))) FROM pg_temp.search(a, u1, 'firewall', p_space_ids => ARRAY[s1, s3]))
    AND ARRAY(SELECT matched_on || ':' || message_id FROM pg_temp.search(a, u1, 'handbuch', p_space_ids => ARRAY[s3])) = ARRAY['object:' || s11],
    'a task or page in a listed space matches as it does with NULL');

  -- ---- who may read (BR-3): history cut-off, left group, space channels
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u4, 'Rechnung', p_space_ids => '{}')) = ARRAY[s05], 'nothing from before the history cut-off');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u4, p_conversation_id => gs) ORDER BY 1) = ARRAY[s05, s07, s08, s09, s10, s11, s12, s13],
    'cut-off also applies to filter-only searches');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'altvertrag')) = ARRAY[s03]
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u4, 'altvertrag'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u4, p_conversation_id => gs, p_has_attachment => true, p_before_created_at => now(), p_before_id => s07)),
    'cut-off holds for file matches and on later pages');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'verlassener')) = ARRAY[l01]
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u2, 'verlassener'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u2, p_conversation_id => g2)), 'a group the caller left gives no results (AC-2)');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u3, 'Rechnung', p_space_ids => '{}')), 'not a member of any conversation: nothing');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'Kanal')) = ARRAY[c01]
    AND ARRAY(SELECT message_id FROM pg_temp.search(a, u3, 'Kanal', p_space_ids => ARRAY[s3])) = ARRAY[c01], 'space channel: all spaces (NULL) or a listed space');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Kanal', p_space_ids => '{}'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Kanal', p_space_ids => ARRAY[s1]))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u3, p_conversation_id => ch3, p_space_ids => ARRAY[s1])), 'space channel: not listed means not readable');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u4, 'del')) = ARRAY[a7]
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'del')), 'the organization owner reads no group they are not a member of');

  -- ---- tenant isolation (NFR-24)
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u9, 'Rechnung'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u9, p_conversation_id => gs))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u9, p_space_ids => ARRAY[s3])), 'a user of another organization gets nothing');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(b, u1, 'Rechnung')), 'a member of A gets nothing from B');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(b, u9, 'Rechnung')) = ARRAY[b01]
    AND ARRAY(SELECT message_id FROM pg_temp.search(b, u9, 'Rechnung', p_space_ids => ARRAY[s3])) = ARRAY[b01]
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(b, u9, p_conversation_id => gs))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(b, u9, p_conversation_id => ch3, p_space_ids => ARRAY[s3])), 'B only sees B, whatever ids are passed');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(b, u9, 'quartalsbericht')) = ARRAY[b01]
    AND ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'quartalsbericht')) = ARRAY[s07], 'file names are matched per organization');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'geheimbericht')) AND NOT EXISTS (SELECT 1 FROM pg_temp.search(b, u9, 'geheimbericht')),
    'a file row of another organization never makes a message match');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(b, u9, 'firewall')) AND NOT EXISTS (SELECT 1 FROM pg_temp.search(b, u9, 'handbuch')),
    'a card pointing at another organization''s task or page never matches by its title');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(NULL, u1, 'Rechnung')) AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, NULL, 'Rechnung')), 'NULL organization or user: nothing');
  -- u1 may read every space channel of A (p_space_ids NULL). That never includes a channel of B,
  -- not by word, not by a filter alone, not by naming B's space or channel.
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(b, u9, 'Mahnung')) = ARRAY[b03]
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Mahnung'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, p_author_id => u9))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Mahnung', p_space_ids => ARRAY[sb]))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, p_conversation_id => chb))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u3, p_space_ids => ARRAY[NULL::uuid])), 'a space channel of another organization is never readable');

  -- ---- hostile text: never run as SQL, never a syntax error, never a way to read more.
  -- u3 reads no conversation, u9 is not in A, u2 left g2, and B holds exactly three messages.
  PERFORM set_config('client_min_messages', 'warning', true);  -- every wordless query raises a notice
  FOREACH q IN ARRAY ARRAY[$h$'; DROP TABLE chat_messages; --$h$, $h$%' OR '1'='1$h$, '\', 'a\', '%_%', '"', '-"', '((', 'a & b | !c',
    '!rechnung', 'rechnung:*', '-rechnung', '<->', chr(2) || chr(3), repeat('%', 300), repeat('x ', 300)]
    -- The last bare word also becomes "begins with" (search as you type), so most of these end
    -- in one. Each string is tried as p_q and as p_not; none may raise.
    -- quotes, doubled quotes
    || ARRAY[$h$'$h$, $h$''$h$, $h$'''$h$, $h$'abc$h$, $h$abc'$h$, $h$'abc'$h$, $h$''abc''$h$, $h$it's abc$h$, '""', '"""', '"abc', 'abc"',
      '"abc" def', '"abc"def', '""abc', '"a"b"c"def', '" abc', $h$'"abc$h$, $h$abc'); DROP TABLE chat_messages; --abc$h$, $h$abc' OR 'x'='xyz$h$]
    -- backslashes
    || ARRAY['\\', '\abc', 'abc\', $h$\'abc$h$, '\"abc', 'a\\bcd', '\\\abc', repeat('\', 200) || 'abc']
    -- text search syntax
    || ARRAY[':*', 'abc:*', 'abc:*def', ':*abc', 'abc:A', 'abc:*A def', $h$'abc':*$h$, $h$'a b':*$h$, '& | ! ( ) < >', '&abc', '|abc', '!abc',
      '(abc', ')abc', '<abc', '>abc', 'abc & def', 'abc | def', 'abc <-> def', 'abc <2> def', '!(abc & def)', 'abc & ', '& abc', ':', '*',
      'abc*', '*abc', repeat('abc:* ', 50), repeat('(', 200) || 'abc', 'or', 'OR', 'abc or', 'or abc', 'abc or def']
    -- control and invisible characters
    || ARRAY[chr(1) || 'abc', 'abc' || chr(1), 'abc' || chr(9) || 'def', 'abc' || chr(10) || 'def', chr(10), 'abc' || chr(13) || chr(10),
      chr(27) || '[31mabc', chr(127) || 'abc', chr(2) || 'abc' || chr(3), 'abc' || chr(11) || chr(12) || 'def', chr(8203) || 'abc',
      chr(8238) || 'abc', chr(65279) || 'abc', chr(160) || 'abc']
    -- long words (5,000 letters; 1,000 letters whose lower case takes more bytes) and long lists
    || ARRAY[repeat('a', 200), repeat('ä', 200), repeat('a', 5000), repeat('Ⱥ', 1000), repeat('a ', 2000) || 'abc', repeat('"', 201)]
    -- emoji and letters outside ASCII
    || ARRAY['🙂', '🙂🙂🙂', 'abc🙂', '🙂abc', '👨‍👩‍👧 abc', 'Lös', 'ß', 'İstanbul', '日本語', 'e' || chr(769) || 'abc', 'ǅabc']
    -- only punctuation, only a minus
    || ARRAY['.', '?!.,;', '„“', '@#€&', '-', '--', '- ', ' - abc', '-abc', '--abc', '-"abc', '-"abc def"', 'abc-', 'abc -', repeat('-', 200),
      '$1', '${abc}', '[abc]', '%abc%', '_abc_']
  LOOP
    PERFORM pg_temp.ok(
      NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u3, q, p_space_ids => '{}'))
      AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u3, 'Rechnung', q, p_space_ids => '{}'))
      AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u9, q))
      AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u9, NULL, q))
      AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u2, q, p_conversation_id => g2))
      AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, p_object_type => q))
      AND NOT EXISTS (SELECT 1 FROM pg_temp.search(b, u9, q) h WHERE h.message_id <> ALL (ARRAY[b01, b02, b03]))
      AND NOT EXISTS (SELECT 1 FROM pg_temp.search(b, u9, NULL, q) h WHERE h.message_id <> ALL (ARRAY[b01, b02, b03])),
      format('hostile text %L never widens what the caller may read', left(q, 40)));
  END LOOP;
  PERFORM set_config('client_min_messages', 'notice', true);

  -- ---- keyset cursor: pages of 5 over the 12 readable messages of gs, newest first
  PERFORM pg_temp.ok((SELECT count(*) FROM pg_temp.search(a, u1, p_conversation_id => gs, p_limit => 5)) = 6, 'returns limit + 1 rows when more exist');
  LOOP
    pages := pages + 1;
    PERFORM pg_temp.ok(pages <= 5, 'paging terminates');
    FOR r IN
      SELECT * FROM (
        SELECT s.*, row_number() OVER () AS rn
        FROM pg_temp.search(a, u1, p_conversation_id => gs, p_before_created_at => cur_at, p_before_id => cur_id, p_limit => 5) s
      ) x
    LOOP
      EXIT WHEN r.rn > 5;                       -- the extra row only announces the next page
      kept := kept || r.message_id;
      cur_at := r.created_at; cur_id := r.message_id;
    END LOOP;
    EXIT WHEN r.rn IS NULL OR r.rn <= 5;
  END LOOP;
  PERFORM pg_temp.ok(pages = 3 AND kept = ARRAY[s13, s12, s11, s10, s09, s08, s07, s05, s04, s03, s02, s01],
    format('3 pages, every message once, ordered by (created_at, id) descending; got %s pages: %s', pages, kept));
  PERFORM pg_temp.ok(kept = ARRAY(SELECT message_id FROM pg_temp.search(a, u1, p_conversation_id => gs)), 'pages together equal one large page');

  PERFORM pg_temp.ok((SELECT count(*) FROM pg_temp.search(a, u1, p_conversation_id => gs, p_limit => NULL)) = 12, 'limit defaults when NULL');
  PERFORM pg_temp.expect_error(format('SELECT * FROM pg_temp.search(%L, %L, p_limit => 0)', a, u1), '22023');
  PERFORM pg_temp.expect_error(format('SELECT * FROM pg_temp.search(%L, %L, p_limit => 101)', a, u1), '22023');

  -- The cursor only moves the window: one built from a message the caller cannot read (the group
  -- u2 left, organization B) shows nothing more. Half a cursor is refused.
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u2, p_before_created_at => now() + interval '1 hour', p_before_id => l01))
      = ARRAY(SELECT message_id FROM pg_temp.search(a, u2))
    AND ARRAY(SELECT message_id FROM pg_temp.search(a, u2, 'Rechnung', p_before_created_at => now() + interval '1 hour', p_before_id => b01))
      = ARRAY(SELECT message_id FROM pg_temp.search(a, u2, 'Rechnung'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u2, p_conversation_id => g2, p_before_created_at => now() + interval '1 hour', p_before_id => l01)),
    'a cursor taken from an unreadable message shows nothing more');
  PERFORM pg_temp.expect_error(format('SELECT * FROM pg_temp.search(%L, %L, p_before_created_at => now())', a, u1), '22023');
  PERFORM pg_temp.expect_error(format('SELECT * FROM pg_temp.search(%L, %L, p_before_id => %L)', a, u1, s05), '22023');

  -- Only the current text is searchable (BR-4): after an edit the old words are gone.
  PERFORM chat_edit_message(a, s12, u2, 'x', 'Upload erledigt');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'erledigt')) = ARRAY[s12]
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'offen')), 'an edited message is found by its new text only');
END $$;

-- ---------------------------------------------------------------- search as you type, task without a space
-- The last bare word of the query (3 letters or digits and more) also matches as the beginning
-- of a word. Uses the group "Search" of the block above and a group of its own.
DO $$
DECLARE
  a uuid := 'c0000000-0000-0000-0000-00000000000a';
  u1 uuid := 'c0000000-0000-0000-0000-000000000001';
  u2 uuid := 'c0000000-0000-0000-0000-000000000002';
  s1 uuid := 'c0000000-0000-0000-0000-0000000000e1';
  s3 uuid := 'c0000000-0000-0000-0000-0000000000e3';
  s01 uuid := 'd1000000-0000-0000-0000-000000000001';  -- Die Rechnungen sind bezahlt
  s02 uuid := 'd1000000-0000-0000-0000-000000000002';  -- Please send the invoices today
  s03 uuid := 'd1000000-0000-0000-0000-000000000003';  -- Rechnung vom Lieferanten erhalten
  s04 uuid := 'd1000000-0000-0000-0000-000000000004';  -- Rechnung ohne weitere Angaben
  s05 uuid := 'd1000000-0000-0000-0000-000000000005';  -- Rechnung nach dem Beitritt
  t01 uuid := 'd1000000-0000-0000-0000-000000000051';
  t02 uuid := 'd1000000-0000-0000-0000-000000000052';
  t03 uuid := 'd1000000-0000-0000-0000-000000000053';
  t04 uuid := 'd1000000-0000-0000-0000-000000000054';
  t05 uuid := 'd1000000-0000-0000-0000-000000000055';
  t06 uuid := 'd1000000-0000-0000-0000-000000000056';
  t07 uuid := 'd1000000-0000-0000-0000-000000000057';
  t08 uuid := 'd1000000-0000-0000-0000-000000000058';
  loose uuid := 'c0000000-0000-0000-0000-0000000000f9';  -- a task without a space
  seen uuid := 'c0000000-0000-0000-0000-0000000000fa';   -- a task in space s1
  hidden uuid := 'c0000000-0000-0000-0000-0000000000fb'; -- a task in space s3
  gs uuid := (SELECT id FROM chat_conversations WHERE organization_id = 'c0000000-0000-0000-0000-00000000000a' AND kind = 'group' AND title = 'Search');
  gt uuid;
  q text;
  r record;
  i int;
BEGIN
  gt := chat_create_group(a, u1, 'Typing', ARRAY[u2]);
  PERFORM chat_post_message(a, gt, t01, u1, 'x', 'Die Lösung steht im Protokoll');
  PERFORM chat_post_message(a, gt, t02, u2, 'x', 'Beleg und Belegung im Verlauf');

  -- ---- the beginning of a word
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'Rechn', p_conversation_id => gs) ORDER BY 1) = ARRAY[s01, s03, s04, s05],
    '"Rechn" finds "Rechnung" and "Rechnungen"');
  SELECT * INTO r FROM pg_temp.search(a, u1, 'Rechn', p_conversation_id => gs) WHERE message_id = s01;
  PERFORM pg_temp.ok(r.matched_on = 'text' AND r.snippet = chr(2) || 'Rechnungen' || chr(3) || ' sind bezahlt' AND r.object_refs = '[]'::jsonb,
    format('a hit by the beginning of a word is a text hit and its snippet marks the word, got %L', r.snippet));
  -- Letters outside ASCII count as letters (needs a database locale other than C), in any case.
  SELECT * INTO r FROM pg_temp.search(a, u1, 'Lös');
  PERFORM pg_temp.ok(r.message_id = t01 AND r.matched_on = 'text' AND r.snippet LIKE '%' || chr(2) || 'Lösung' || chr(3) || '%'
    AND (SELECT count(*) FROM pg_temp.search(a, u1, 'Lös')) = 1, format('"Lös" finds "Lösung" and marks it, got %L', r.snippet));
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'lös')) = ARRAY[t01] AND ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'LÖS')) = ARRAY[t01],
    'the beginning matches whatever the case');

  -- ---- the words before the last one match as before (by stem) and are all required
  SELECT * INTO r FROM pg_temp.search(a, u1, 'Rechnungen Lief');
  PERFORM pg_temp.ok(r.message_id = s03 AND r.snippet LIKE '%' || chr(2) || 'Rechnung' || chr(3) || '%' AND r.snippet LIKE '%' || chr(2) || 'Lieferanten' || chr(3) || '%'
    AND (SELECT count(*) FROM pg_temp.search(a, u1, 'Rechnungen Lief')) = 1, format('"Rechnungen Lief" finds "Rechnung vom Lieferanten" and marks both, got %L', r.snippet));
  -- The snippet is cut in the language that matched: "Rechnungen" is marked for "Rechnung" as well.
  SELECT * INTO r FROM pg_temp.search(a, u1, 'Rechnung bez');
  PERFORM pg_temp.ok(r.message_id = s01 AND r.snippet = chr(2) || 'Rechnungen' || chr(3) || ' sind ' || chr(2) || 'bezahlt' || chr(3)
    AND (SELECT count(*) FROM pg_temp.search(a, u1, 'Rechnung bez')) = 1, format('"Rechnung bez" marks the stemmed word and the beginning, got %L', r.snippet));
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'invoice tod')) = ARRAY[s02]
    AND ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'Protokoll Lös')) = ARRAY[t01]
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Lieferanten bez'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Verlauf Lös')), 'every word before the beginning is still required');
  -- Only English turns "sending" into "send": the words before the beginning match in each language, not in German alone.
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'sending tod')) = ARRAY[s02], 'the words before a beginning are stemmed in English as well');
  -- "die" and "sind" are stop words in German: as with whole words ("die Rechnung"), German then
  -- ignores them, so only s01 holds "die" and still all four match.
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'die Rechn', p_conversation_id => gs) ORDER BY 1) = ARRAY[s01, s03, s04, s05]
    AND ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'die Rechnung', p_conversation_id => gs) ORDER BY 1) = ARRAY[s01, s03, s04, s05]
    AND ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'sind bezahl')) = ARRAY[s01], 'a stop word before the beginning is ignored as it is before a whole word');

  -- ---- where it does not apply
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Lö')) AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Protokoll Lö'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Re', p_conversation_id => gs) WHERE matched_on = 'text'),  -- "Regeln" in a task title still matches
    'a last word of two letters is not a beginning');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, '"Rechn"'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, '"sind bezahl"'))      -- ends in a closed phrase
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, '"sind bezahl'))       -- inside an open phrase
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'sind "bezahl'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, '"sind"bezahl')),      -- glued to a phrase
    'a word inside or directly after a quoted phrase is not a beginning');
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, '"Rechnungen sind" bezahl')) = ARRAY[s01], 'a bare word after a closed phrase and a blank is a beginning');
  -- t02 holds "Beleg" and "Belegung": as a beginning "-Beleg" would let it through.
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'Verlauf Bele')) = ARRAY[t02]
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Verlauf -Beleg'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Verlauf - Beleg'))    -- Postgres reads "- word" as "not word" too
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Verlauf-Bele')), 'a word after a minus is not a beginning');
  -- Postgres skips punctuation and blanks after the minus: "-(word" and "-.word" are "not word" as well.
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Verlauf -(Beleg'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Verlauf -.Beleg'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Verlauf - (Beleg')), 'a word after a minus and punctuation is not a beginning');

  -- ---- an excluded word wins over a beginning
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'Rechn', 'lieferant', p_conversation_id => gs) ORDER BY 1) = ARRAY[s01, s04, s05]
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Rechn', 'rechnungen', p_conversation_id => gs))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Lös', 'lösung'))
    AND NOT EXISTS (SELECT 1 FROM pg_temp.search(a, u1, 'Protokoll Lös', 'steht')), 'an excluded word removes the message whatever matched');
  -- The excluded word itself stays a whole word: no message holds "Rech", as a beginning it would remove all four.
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'Rechn', 'Rech', p_conversation_id => gs) ORDER BY 1) = ARRAY[s01, s03, s04, s05],
    'an excluded word never excludes as a beginning');

  -- ---- hostile text in front of a beginning: still no error, still the same hits, still marked
  PERFORM set_config('client_min_messages', 'warning', true);
  FOREACH q IN ARRAY ARRAY[$h$'Rechn$h$, $h$''Rechn$h$, '\Rechn', '(Rechn', '!Rechn', ':*Rechn', '& | ! ( ) < >Rechn', '🙂 Rechn', chr(1) || 'Rechn', $h$'; Rechn$h$, $h$%' \ ;Rechn$h$]
  LOOP
    PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, q, p_conversation_id => gs) WHERE snippet LIKE '%' || chr(2) || 'Rechnung%' ORDER BY 1) = ARRAY[s01, s03, s04, s05]
      AND (SELECT count(*) FROM pg_temp.search(a, u1, q, p_conversation_id => gs)) = 4, format('hostile text %L in front of a beginning', q));
  END LOOP;
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, $h$'; "Rechnungen sind" \ (bezahl$h$)) = ARRAY[s01], 'hostile text between the words before a beginning');
  -- Postgres drops a word that is too long to index. As the last word it is no beginning either,
  -- and the words before it find what they found without it.
  PERFORM pg_temp.ok(ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'Rechnung ' || repeat('b', 3000), p_conversation_id => gs) ORDER BY 1) = ARRAY[s01, s03, s04, s05],
    'a last word too long to index leaves the rest of the search as it was');
  PERFORM set_config('client_min_messages', 'notice', true);

  -- ---- a task without a space counts only for a caller who may see every space (p_space_ids NULL).
  -- t03 matches by the title alone, t04 also by its own text.
  INSERT INTO tasks (id, organization_id, space_id, task_type_id, summary) VALUES (loose, a, NULL, 'task', 'Raumlose Aufgabe');
  PERFORM chat_post_message(a, gt, t03, u2, 'x', 'siehe Karte', NULL, NULL, jsonb_build_array(jsonb_build_object('type', 'task', 'id', loose)));
  PERFORM chat_post_message(a, gt, t04, u2, 'x', 'Raumlose Notiz', NULL, NULL, jsonb_build_array(jsonb_build_object('type', 'task', 'id', loose)));
  PERFORM pg_temp.ok(ARRAY(SELECT matched_on || ':' || message_id FROM pg_temp.search(a, u1, 'raumlose') ORDER BY message_id) = ARRAY['object:' || t03, 'text:' || t04]
    AND (SELECT bool_and(object_refs = jsonb_build_array(jsonb_build_object('type', 'task', 'id', loose))) FROM pg_temp.search(a, u1, 'raumlose')),
    'a task without a space matches by title when every space is allowed');
  PERFORM pg_temp.ok(ARRAY(SELECT matched_on || ':' || message_id || ':' || object_refs::text FROM pg_temp.search(a, u1, 'raumlose', p_space_ids => ARRAY[s1, s3])) = ARRAY['text:' || t04 || ':[]']
    AND ARRAY(SELECT matched_on || ':' || message_id || ':' || object_refs::text FROM pg_temp.search(a, u1, 'raumlose', p_space_ids => '{}')) = ARRAY['text:' || t04 || ':[]'],
    'a task without a space never matches, and is never listed, for a caller limited to spaces');
  DELETE FROM tasks WHERE id = loose;

  -- ---- the default page size: 20 hits and the one row that announces the next page
  FOR i IN 1..22 LOOP
    PERFORM chat_post_message(a, gt, ('d1000000-0000-0000-0000-0000000001' || lpad(i::text, 2, '0'))::uuid, u1, 'x', 'Zeile ' || i);
  END LOOP;
  PERFORM pg_temp.ok((SELECT count(*) FROM pg_temp.search(a, u1, p_conversation_id => gt, p_limit => NULL)) = 21
    AND (SELECT count(*) FROM pg_temp.search(a, u1, 'Zeile', p_limit => NULL)) = 21
    AND (SELECT count(*) FROM pg_temp.search(a, u1, p_conversation_id => gt, p_limit => 100)) = 26, 'p_limit NULL returns at most 20 hits plus one');

  -- ---- digits are a word as well
  PERFORM chat_post_message(a, gs, t07, u2, 'x', 'Vorgang 20261011 gebucht');
  SELECT * INTO r FROM pg_temp.search(a, u1, 'Vorgang 2026');
  PERFORM pg_temp.ok(r.message_id = t07 AND r.snippet LIKE '%' || chr(2) || '20261011' || chr(3) || '%'
    AND ARRAY(SELECT message_id FROM pg_temp.search(a, u1, '202610')) = ARRAY[t07], format('the beginning of a number finds the number and marks it, got %L', r.snippet));

  -- ---- one message (t05), two cards whose titles match: one task in a listed space, one outside.
  -- Only the listed one is named. The two newer messages that hold the hidden one alone neither
  -- show, nor push t05 off the page, nor announce a next page. With every space allowed they do.
  INSERT INTO tasks (id, organization_id, space_id, task_type_id, summary) VALUES
    (seen, a, s1, 'task', 'Doppelkarte sichtbar'), (hidden, a, s3, 'task', 'Doppelkarte versteckt');
  PERFORM chat_post_message(a, gs, t06, u2, 'x', 'eine Karte', NULL, NULL, jsonb_build_array(jsonb_build_object('type', 'task', 'id', hidden)));
  PERFORM chat_post_message(a, gs, t08, u2, 'x', 'noch eine Karte', NULL, NULL, jsonb_build_array(jsonb_build_object('type', 'task', 'id', hidden)));
  PERFORM chat_post_message(a, gs, t05, u2, 'x', 'zwei Karten', NULL, NULL, jsonb_build_array(
    jsonb_build_object('type', 'task', 'id', hidden), jsonb_build_object('type', 'task', 'id', seen)));
  PERFORM pg_temp.ok((SELECT count(*) = 1 AND bool_and(message_id = t05 AND matched_on = 'object' AND object_refs = jsonb_build_array(jsonb_build_object('type', 'task', 'id', seen)))
      FROM pg_temp.search(a, u1, 'doppelkarte', p_space_ids => ARRAY[s1], p_limit => 1))
    AND ARRAY(SELECT message_id FROM pg_temp.search(a, u1, 'doppelkarte', p_limit => 1)) = ARRAY[t08, t06]
    AND (SELECT object_refs FROM pg_temp.search(a, u1, 'doppelkarte') WHERE message_id = t05)
      = jsonb_build_array(jsonb_build_object('type', 'task', 'id', seen), jsonb_build_object('type', 'task', 'id', hidden)),
    'of two matching cards on one message only the one in a listed space counts; a hidden one alone gives no row, takes no place on the page and announces no next page');
  DELETE FROM tasks WHERE id IN (seen, hidden);
END $$;

-- The search runs with the caller's rights: service_role must be able to read every table it joins.
SET LOCAL ROLE service_role;
SELECT count(*) AS n_as_service_role, count(*) FILTER (WHERE matched_on = 'object') AS n_object
FROM chat_search_messages('c0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000001',
  NULL, 'firewall', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 20) \gset
RESET ROLE;
SELECT pg_temp.ok(:n_as_service_role = 2 AND :n_object = 1, 'service_role can run the search, object titles included');

-- A card whose task is gone no longer matches by title; the text match stays.
-- (Also needed further down: pre-existing and not chat, delete_organization fails while a space
-- still holds a task, because sla_capture_scope appends to sla_task_streams after the
-- organization row is gone.)
DELETE FROM tasks WHERE id = 'c0000000-0000-0000-0000-0000000000f7';
SELECT pg_temp.ok((SELECT string_agg(matched_on, ',') FROM pg_temp.search('c0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000001', 'firewall')) = 'text',
  'a deleted task no longer matches by title');

-- ---------------------------------------------------------------- groups (CHAT-03)
DO $$
DECLARE
  a uuid := 'c0000000-0000-0000-0000-00000000000a';
  u1 uuid := 'c0000000-0000-0000-0000-000000000001';
  u2 uuid := 'c0000000-0000-0000-0000-000000000002';
  u3 uuid := 'c0000000-0000-0000-0000-000000000003';
  u4 uuid := 'c0000000-0000-0000-0000-000000000004';
  g uuid;
  owners int;
BEGIN
  g := chat_create_group(a, u1, 'Team', ARRAY[u2, u3, u2, NULL]);
  PERFORM pg_temp.ok((SELECT count(*) FROM chat_members WHERE conversation_id = g) = 3, 'group has 3 distinct members');
  PERFORM pg_temp.ok((SELECT role FROM chat_members WHERE conversation_id = g AND user_id = u1) = 'owner', 'creator is owner');
  PERFORM pg_temp.ok((SELECT metadata->>'event' FROM chat_messages WHERE conversation_id = g AND seq = 1) = 'group_created', 'created system message');
  PERFORM pg_temp.ok((SELECT unread_count FROM chat_unread_summary(a, u1) WHERE conversation_id = g) = 0, 'creator has read the creation message');

  PERFORM pg_temp.expect_error(format('SELECT chat_create_group(%L, %L, %L, ARRAY[%L]::uuid[])', a, u1, 'x', 'c0000000-0000-0000-0000-000000000009'), '42501');
  PERFORM pg_temp.expect_error(format('SELECT chat_add_members(%L, %L, %L, ARRAY[%L]::uuid[], true, false)', a, g, u2, u4), '42501');

  PERFORM pg_temp.ok(chat_add_members(a, g, u2, ARRAY[u4, u3], false, true) = 1, 'member adds one new person (u3 already in)');
  PERFORM pg_temp.ok((SELECT history_from_seq FROM chat_members WHERE conversation_id = g AND user_id = u4)
    = (SELECT last_seq - 1 FROM chat_conversations WHERE id = g), '"from now on" sets the history cut-off');

  PERFORM pg_temp.expect_error(format('SELECT chat_remove_member(%L, %L, %L, %L)', a, g, u2, u4), '42501');  -- not owner
  PERFORM chat_remove_member(a, g, u1, u4);
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_members WHERE conversation_id = g AND user_id = u4), 'owner removed u4');

  PERFORM pg_temp.expect_error(format('SELECT chat_set_member_role(%L, %L, %L, %L, %L)', a, g, u1, u1, 'member'), '42501'); -- last owner
  PERFORM chat_leave(a, g, u1);
  SELECT count(*) INTO owners FROM chat_members WHERE conversation_id = g AND role = 'owner';
  PERFORM pg_temp.ok(owners = 1, 'ownership passed on when the last owner left');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM chat_messages WHERE conversation_id = g AND metadata->>'event' = 'ownership_transferred'), 'ownership system message');

  PERFORM pg_temp.expect_error(format('SELECT chat_leave(%L, %L, %L)', a, chat_get_or_create_dm(a, u1, u2), u1), '42501'); -- DMs cannot be left

  PERFORM chat_leave(a, g, u2);
  PERFORM chat_leave(a, g, u3);
  PERFORM pg_temp.ok((SELECT archived_at IS NOT NULL FROM chat_conversations WHERE id = g), 'group archived when the last member leaves');
  PERFORM pg_temp.expect_error(format('SELECT * FROM chat_post_message(%L, %L, %L, %L, %L, %L)', a, g, gen_random_uuid(), u2, 'x', 'x'), '42501');
END $$;

-- ---------------------------------------------------------------- space channels (CHAT-04)
DO $$
DECLARE
  a uuid := 'c0000000-0000-0000-0000-00000000000a';
  b uuid := 'c0000000-0000-0000-0000-00000000000b';
  u2 uuid := 'c0000000-0000-0000-0000-000000000002';
  u3 uuid := 'c0000000-0000-0000-0000-000000000003';
  s1 uuid := 'c0000000-0000-0000-0000-0000000000e1';
  s2 uuid := 'c0000000-0000-0000-0000-0000000000e2';
  ch uuid;
BEGIN
  ch := chat_get_or_create_space_channel(a, s1);
  PERFORM pg_temp.ok(ch = chat_get_or_create_space_channel(a, s1), 'one channel per space');
  PERFORM pg_temp.expect_error(format('SELECT chat_get_or_create_space_channel(%L, %L)', b, s1), 'P0002');  -- other tenant
  PERFORM pg_temp.expect_error(format('SELECT chat_get_or_create_space_channel(%L, %L)', a, s2), '42501');  -- archived, no channel yet

  PERFORM chat_sync_space_channel_members(a, u3, ARRAY[s1]);
  PERFORM pg_temp.ok((SELECT notify_level FROM chat_members WHERE conversation_id = ch AND user_id = u3) = 'mentions', 'channel default is mentions only');
  PERFORM chat_sync_space_channel_members(a, u3, ARRAY[]::uuid[]);
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_members WHERE conversation_id = ch AND user_id = u3), 'lost space access removes channel state');

  -- Threaded channel traffic with a reaction and an edit, then archive the space.
  PERFORM chat_post_message(a, ch, 'd0000000-0000-0000-0000-000000000031', u2, 'root', 'root');
  PERFORM chat_post_message(a, ch, 'd0000000-0000-0000-0000-000000000032', u3, 'r1', 'r1', 'd0000000-0000-0000-0000-000000000031');
  PERFORM chat_post_message(a, ch, 'd0000000-0000-0000-0000-000000000033', u3, 'r2', 'r2', 'd0000000-0000-0000-0000-000000000031');
  PERFORM chat_post_message(a, ch, 'd0000000-0000-0000-0000-000000000034', u2, 'plain', 'plain');
  PERFORM chat_edit_message(a, 'd0000000-0000-0000-0000-000000000034', u2, 'plain!', 'plain!');
  INSERT INTO chat_reactions (message_id, organization_id, user_id, emoji) VALUES ('d0000000-0000-0000-0000-000000000031', a, u3, '👍');
  PERFORM pg_temp.ok((SELECT count(*) FROM chat_members WHERE conversation_id = ch) = 2, 'posting creates channel state rows');

  UPDATE spaces SET is_archived = true WHERE id = s1;
  PERFORM pg_temp.expect_error(format('SELECT * FROM chat_post_message(%L, %L, %L, %L, %L, %L)', a, ch, gen_random_uuid(), u2, 'x', 'x'), '42501');
  PERFORM pg_temp.expect_error(format('SELECT chat_edit_message(%L, %L, %L, %L, %L)', a, 'd0000000-0000-0000-0000-000000000034', u2, 'y', 'y'), '42501');
  PERFORM pg_temp.ok(chat_get_or_create_space_channel(a, s1) = ch, 'archived space still returns its existing channel');
END $$;

-- ---------------------------------------------------------------- space deletion drains chat in batches
DO $$
DECLARE
  a uuid := 'c0000000-0000-0000-0000-00000000000a';
  s1 uuid := 'c0000000-0000-0000-0000-0000000000e1';
  batches int := 0;
  n int;
BEGIN
  -- Regression guard for the pre-existing steps: a parent/child task pair and a page tree
  -- must still drain leaf-first alongside the chat step.
  INSERT INTO tasks (id, organization_id, space_id, task_type_id, summary) VALUES
    ('c0000000-0000-0000-0000-0000000000f1', a, s1, 'task', 'parent');
  INSERT INTO tasks (id, organization_id, space_id, task_type_id, summary, parent_task_id) VALUES
    ('c0000000-0000-0000-0000-0000000000f2', a, s1, 'task', 'child', 'c0000000-0000-0000-0000-0000000000f1');
  INSERT INTO wiki_pages (id, organization_id, space_id, title, slug) VALUES
    ('c0000000-0000-0000-0000-0000000000f3', a, s1, 'Root', 'chat-it-root');
  INSERT INTO wiki_pages (id, organization_id, space_id, title, slug, parent_id) VALUES
    ('c0000000-0000-0000-0000-0000000000f4', a, s1, 'Leaf', 'chat-it-leaf', 'c0000000-0000-0000-0000-0000000000f3');

  -- Postponed notifications on channel messages (a root and a reply) must go with their
  -- message inside its batch and never hold the drain up.
  INSERT INTO chat_notification_queue (organization_id, user_id, conversation_id, message_id, seq, reason, stage, due_at)
  SELECT a, 'c0000000-0000-0000-0000-000000000002', m.conversation_id, m.id, m.seq, 'thread_reply', 'held', now()
  FROM chat_messages m
  WHERE m.id IN ('d0000000-0000-0000-0000-000000000031', 'd0000000-0000-0000-0000-000000000032');
  PERFORM pg_temp.ok((SELECT count(*) FROM chat_notification_queue q JOIN chat_conversations c ON c.id = q.conversation_id WHERE c.space_id = s1) = 2,
    'two queue rows on the channel before the drain');

  PERFORM delete_space_cascade(a, s1, 'c0000000-0000-0000-0000-000000000001');
  LOOP
    n := delete_space_rows_batch(s1, 1);   -- one row per batch: exercises leaf-first ordering
    EXIT WHEN n = 0;
    batches := batches + 1;
    PERFORM pg_temp.ok(batches < 100, 'drain terminates');
  END LOOP;
  PERFORM pg_temp.ok(NOT EXISTS (
    SELECT 1 FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id WHERE c.space_id = s1
  ), 'all channel messages drained before finalize');
  PERFORM pg_temp.ok(NOT EXISTS (
    SELECT 1 FROM chat_notification_queue q JOIN chat_conversations c ON c.id = q.conversation_id WHERE c.space_id = s1
  ), 'queued notifications drained with their messages');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM tasks WHERE space_id = s1)
    AND NOT EXISTS (SELECT 1 FROM wiki_pages WHERE space_id = s1), 'tasks and wiki pages still drained');
  PERFORM pg_temp.ok(batches = 8, format('one row per batch: 2 tasks + 2 pages + 2 replies + 2 roots = 8, got %s', batches));
  PERFORM pg_temp.ok(finalize_space_deletion(s1), 'space finalized');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_conversations WHERE space_id = s1), 'channel removed with the space');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_reactions WHERE message_id = 'd0000000-0000-0000-0000-000000000031'), 'reactions gone');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_message_versions WHERE message_id = 'd0000000-0000-0000-0000-000000000034'), 'versions gone');
END $$;

-- ---------------------------------------------------------------- org membership and user deletion
DO $$
DECLARE
  a uuid := 'c0000000-0000-0000-0000-00000000000a';
  u1 uuid := 'c0000000-0000-0000-0000-000000000001';
  u3 uuid := 'c0000000-0000-0000-0000-000000000003';
  d13 uuid := chat_get_or_create_dm(a, u1, u3);
BEGIN
  PERFORM chat_post_message(a, d13, 'd0000000-0000-0000-0000-000000000041', u3, 'bye', 'bye');
  INSERT INTO chat_user_settings (organization_id, user_id, dnd_until) VALUES (a, u3, now());
  PERFORM chat_post_message(a, d13, 'd0000000-0000-0000-0000-000000000042', u1, 'for u3', 'for u3');
  INSERT INTO chat_notification_queue (organization_id, user_id, conversation_id, message_id, seq, reason, actor_id, stage, due_at)
  VALUES (a, u3, d13, 'd0000000-0000-0000-0000-000000000042', 2, 'dm', u1, 'email', now() + interval '30 minutes');

  DELETE FROM organization_members WHERE organization_id = a AND user_id = u3;
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_members WHERE user_id = u3), 'leaving the org revokes chat membership');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_user_settings WHERE user_id = u3), 'leaving the org drops chat settings');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_notification_queue WHERE user_id = u3)
    AND EXISTS (SELECT 1 FROM chat_messages WHERE id = 'd0000000-0000-0000-0000-000000000042'), 'leaving the org drops their queued notifications, not the message');
  PERFORM pg_temp.ok((SELECT author_id FROM chat_messages WHERE id = 'd0000000-0000-0000-0000-000000000041') = u3, 'their messages stay');
  PERFORM pg_temp.expect_error(format('SELECT * FROM chat_post_message(%L, %L, %L, %L, %L, %L)', a, d13, gen_random_uuid(), u3, 'x', 'x'), '42501');

  -- Pre-existing, not chat: space_members.added_by has no ON DELETE action, so a user the
  -- membership-sync trigger recorded as "added_by" cannot be hard-deleted. Clear it here.
  UPDATE space_members SET added_by = NULL WHERE added_by = u3;
  DELETE FROM users WHERE id = u3;
  PERFORM pg_temp.ok((SELECT author_id FROM chat_messages WHERE id = 'd0000000-0000-0000-0000-000000000041') IS NULL, 'deleting the user keeps the message, author NULL');
END $$;

-- ---------------------------------------------------------------- organization deletion cascades
DO $$
BEGIN
  -- Queue rows reach the organization twice (through the member and through the message); both
  -- cascades must get along in the one DELETE.
  INSERT INTO chat_notification_queue (organization_id, user_id, conversation_id, message_id, seq, reason, stage, due_at)
  SELECT m.organization_id, 'c0000000-0000-0000-0000-000000000002', m.conversation_id, m.id, m.seq, 'dm', 'email', now()
  FROM chat_messages m WHERE m.id = 'd0000000-0000-0000-0000-000000000001';
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM chat_notification_queue WHERE organization_id = 'c0000000-0000-0000-0000-00000000000a'), 'queue rows present before the organization is deleted');

  PERFORM delete_organization('c0000000-0000-0000-0000-00000000000a');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_notification_queue WHERE organization_id = 'c0000000-0000-0000-0000-00000000000a'), 'org deletion removes queued notifications');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_conversations WHERE organization_id = 'c0000000-0000-0000-0000-00000000000a'), 'org deletion removes conversations');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM chat_messages WHERE organization_id = 'c0000000-0000-0000-0000-00000000000a'), 'org deletion removes messages');
END $$;

\echo chat-core integration: all checks passed
ROLLBACK;
