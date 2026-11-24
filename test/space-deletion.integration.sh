#!/usr/bin/env bash
# Space deletion under concurrency — run ONLY against a disposable database with migration
# 20260922140000_space_deletion_serialize_and_fk_indexes applied (e.g. the xisuite-infra harness):
#
#   PSQL="docker exec -i xi-verify-x psql -U postgres -d postgres" ORG=<organizations.id> \
#     test/space-deletion.integration.sh
#
# Seeds one archived space with a 5,461-page nested wiki tree and a 1,111-task tree, then:
#   1. while one session holds a batch open, a second batch and finalize return immediately (0 / f);
#   2. six parallel drainers (lock_timeout 8s, like PostgREST) empty it with zero deadlocks;
#   3. finalize removes the space.
# Exits non-zero on any failure. The seeded space is deleted by the test itself.
set -euo pipefail
: "${PSQL:?set PSQL to a psql command for a DISPOSABLE database}"
: "${ORG:?set ORG to an existing organizations.id}"
SPACE=00000000-0000-0000-0000-0000000000ee
q() { $PSQL -tA -v ON_ERROR_STOP=1 -c "$1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

USER_ID=$(q "select id from public.users limit 1")
[ -n "$USER_ID" ] || fail "no users row to own the seeded pages"

$PSQL -q -v ON_ERROR_STOP=1 <<SQL
insert into public.spaces (id, organization_id, name, key) values ('$SPACE', '$ORG', 'Deletion race', 'DELRACE');
do \$\$ declare lvl int; begin
  for lvl in 0..6 loop  -- 7 levels, fanout 4
    insert into public.wiki_pages (id, space_id, organization_id, title, slug, content, created_by, parent_id)
    select md5('$SPACE'||'w'||i)::uuid, '$SPACE', '$ORG', 'P'||i, 'p-'||i, '', '$USER_ID',
           case when i=0 then null else md5('$SPACE'||'w'||((i-1)/4))::uuid end
    from generate_series(0, 5460) i
    where (case when i=0 then 0 else floor(log(4, 3*i+1))::int end) = lvl;
  end loop;
  for lvl in 0..3 loop  -- 4 levels, fanout 10
    insert into public.tasks (id, space_id, organization_id, summary, task_type_id, parent_task_id)
    select md5('$SPACE'||'t'||i)::uuid, '$SPACE', '$ORG', 'T'||i, 'task',
           case when i=0 then null else md5('$SPACE'||'t'||((i-1)/10))::uuid end
    from generate_series(0, 1110) i
    where (case when i=0 then 0 when i<=10 then 1 when i<=110 then 2 else 3 end) = lvl;
  end loop;
end \$\$;
update public.spaces set is_archived = true, deleting_at = now() where id = '$SPACE';
SQL

# 1. A second caller never waits behind a running batch.
( $PSQL -tA -c "begin; select public.delete_space_rows_batch('$SPACE', 500); select pg_sleep(4); commit;" >/dev/null ) &
sleep 1.5
[ "$(q "set lock_timeout='1s'; select public.delete_space_rows_batch('$SPACE', 500)" | tail -1)" = "0" ] \
  || fail "second batch did not step aside while another held the space"
[ "$(q "set lock_timeout='1s'; select public.finalize_space_deletion('$SPACE')" | tail -1)" = "f" ] \
  || fail "finalize ran while a batch held the space"
wait

# 2. Six drainers at once: no deadlock, no lock timeout.
errors=$(mktemp)
drainer() {
  local zeros=0
  while [ "$zeros" -lt 3 ]; do
    local res
    res=$($PSQL -tA -c "set lock_timeout='8s'; select public.delete_space_rows_batch('$SPACE', 500)" 2>&1 | grep -m1 -E "ERROR|^[0-9]+$" || true)
    case "$res" in
      0) zeros=$((zeros+1)) ;;
      ''|*ERROR*) echo "$res" >> "$errors"; zeros=0 ;;
      *) zeros=0 ;;
    esac
  done
}
for _ in 1 2 3 4 5 6; do drainer & done
wait
[ ! -s "$errors" ] || { sort "$errors" | uniq -c >&2; fail "drainers hit errors (above)"; }

left=$(q "select (select count(*) from public.tasks where space_id='$SPACE') + (select count(*) from public.wiki_pages where space_id='$SPACE')")
[ "$left" = "0" ] || fail "$left rows left after the drain"

# 3. Finalize removes the space.
[ "$(q "select public.finalize_space_deletion('$SPACE')")" = "t" ] || fail "finalize did not complete"
[ "$(q "select count(*) from public.spaces where id='$SPACE'")" = "0" ] || fail "space row still present"
echo "space deletion concurrency: all checks passed"
