#!/usr/bin/env bash
# Install as /home/deploy/deploy.sh; GitLab's forced SSH command uses that path.
set -euo pipefail

readonly APP_DIR="${APP_DIR:-/home/deploy/xisuite-backend}"
readonly BRANCH=main
readonly SERVICE=xisuite-backend
readonly HEALTH_URL=http://127.0.0.1:3001/api/v1/health
readonly LOG_FILE="${LOG_FILE:-/home/deploy/deploy.log}"
WORK=''
SWITCHING=0
PREV_COMMIT=''

log() {
    local msg="[$(date -Is)] $*"
    printf '%s\n' "$msg"
    printf '%s\n' "$msg" >> "$LOG_FILE"
}

healthy() {
    systemctl is-active --quiet "$SERVICE" &&
        curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1
}

wait_healthy() {
    local attempt
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
        if healthy; then return 0; fi
        sleep 2
    done
    return 1
}

rollback() {
    log "!! ROLLBACK: restoring saved release $PREV_COMMIT (no rebuild)"
    systemctl stop "$SERVICE" >> "$LOG_FILE" 2>&1 || return 1
    git reset --hard "$PREV_COMMIT" >> "$LOG_FILE" 2>&1 || return 1
    local dir
    for dir in dist node_modules; do
        if [ -d "$WORK/previous/$dir" ]; then
            if [ -e "$APP_DIR/$dir" ]; then
                mv "$APP_DIR/$dir" "$WORK/failed-$dir" || return 1
            fi
            mv "$WORK/previous/$dir" "$APP_DIR/$dir" || return 1
        fi
    done
    systemctl restart "$SERVICE" >> "$LOG_FILE" 2>&1 || return 1
    wait_healthy || return 1
    log "!! ROLLBACK VERIFIED ($PREV_COMMIT)"
}

finish() {
    local rc=$?
    trap - EXIT INT TERM HUP
    if [ "$rc" -ne 0 ] && [ "$SWITCHING" -eq 1 ]; then
        if ! rollback; then
            log "!! ROLLBACK FAILED: manual recovery required; files retained at $WORK"
            exit 1
        fi
    elif [ "$rc" -ne 0 ]; then
        log "FAIL: deployment stopped before activation; live release was not changed"
    fi
    if [ -n "$WORK" ]; then rm -rf -- "$WORK"; fi
    exit "$rc"
}

# Hold the lock in the parent shell, including builds and rollback.
exec 9>"${APP_DIR}.deploy.lock"
flock -n 9 || { log 'FAIL: another deployment is running'; exit 1; }
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE")" -gt 10485760 ]; then
    mv "$LOG_FILE" "${LOG_FILE}.old"
fi
log '========== DEPLOY START =========='
cd "$APP_DIR"
git diff --quiet && git diff --cached --quiet || {
    log 'FAIL: tracked local changes must be resolved before deployment'; exit 1;
}
PREV_COMMIT=$(git rev-parse HEAD)
git fetch origin "$BRANCH" >> "$LOG_FILE" 2>&1
NEW_COMMIT=$(git rev-parse "refs/remotes/origin/$BRANCH^{commit}")
if [ "$PREV_COMMIT" = "$NEW_COMMIT" ] && [ -f dist/main.js ] && [ -d node_modules ] && healthy; then
    log "Already at $NEW_COMMIT and healthy; nothing to deploy."
    exit 0
fi
[ -f dist/main.js ] && [ -d node_modules ] || {
    log 'FAIL: previous dist/main.js or node_modules missing; restore a working release before automatic deployment'; exit 1;
}

# Build outside the live checkout. Nest may delete its output directory safely here.
# Keep staging on the same filesystem so artifact switches use directory renames.
WORK=$(mktemp -d "${APP_DIR}.deploy.XXXXXX")
mkdir "$WORK/source" "$WORK/previous"
git archive "$NEW_COMMIT" | tar -x -C "$WORK/source"
log "Preparing $PREV_COMMIT -> $NEW_COMMIT in $WORK/source"
(
    cd "$WORK/source"
    pnpm install --frozen-lockfile
    NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=3072" pnpm build
    test -s dist/main.js
    test -d node_modules
) >> "$LOG_FILE" 2>&1

# Refuse to overwrite manual changes made while the separate build was running.
[ "$(git rev-parse HEAD)" = "$PREV_COMMIT" ] && git diff --quiet && git diff --cached --quiet || {
    log 'FAIL: live checkout changed during build'; exit 1;
}
SWITCHING=1
log 'Build passed; activating the new release.'
systemctl stop "$SERVICE" >> "$LOG_FILE" 2>&1
mv dist "$WORK/previous/dist"
mv node_modules "$WORK/previous/node_modules"
git reset --hard "$NEW_COMMIT" >> "$LOG_FILE" 2>&1
mv "$WORK/source/dist" dist
mv "$WORK/source/node_modules" node_modules
systemctl restart "$SERVICE" >> "$LOG_FILE" 2>&1
wait_healthy || { log 'FAIL: new release did not become healthy'; exit 1; }
SWITCHING=0
log "========== DEPLOY SUCCESS ($NEW_COMMIT) =========="
