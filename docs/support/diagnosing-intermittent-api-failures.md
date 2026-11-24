# Diagnosing intermittent API failures ("content sometimes loads")

Runbook for the failure mode where a user sees some panels load and others fail,
often with a CORS-looking error in the console, on the same page across reloads.

Four independent causes produce that symptom. This tells them apart from **one**
failing request. Read the decision table first — it is the whole runbook.

## Decision table

| Signal | Cause | Where |
|---|---|---|
| `orgSrc=oldest-membership` while on a tenant subdomain | Wrong tenant resolved (multi-org only) | backend log |
| `dupCookies=access_token` | Two cookies, different `Domain` scopes. Node reads the FIRST, Next's Edge parser the LAST — the tiers disagree about the session | backend log |
| `cookieBytes` near 8000+ | Approaching nginx's default `large_client_header_buffers 4 8k`. Beyond it the **proxy** returns 400/431 with no CORS headers and the request never reaches the app | backend log |
| `[cors] rejected origin=…` | Genuine CORS denial — origin missing from `ALLOWED_ORIGINS` | backend log |
| `[pre-router] … -> 413` | Oversized payload. Was previously returned as HTML with no CORS headers, so it *looked* like a CORS error | backend log |
| `[auth][refresh-circuit] opened failures=N/3` | Token refresh failing. **`N` must advance by 1 per failure** — a jump equal to the number of in-flight queries means the per-waiter counting bug regressed | browser console |
| Nothing in any backend log at all | The request never reached the app → reverse proxy or network. Check the **nginx/ingress access log**, not the app log | proxy |
| nginx logs `limiting requests` for `task-statuses` / `available-transitions` | Normal task navigation exceeded the proxy burst; the status menu must show an error and retry, not an empty workflow | proxy + frontend |

That last row matters: the proxy config lives in neither repo, so a proxy-level
rejection is invisible from the application side. Absence of a log line **is** a
signal.

## Backend log greps

```bash
# Everything for one user (uuid from `select id from users where email = '…'`)
grep 'user=<uuid>' backend.log

# Wrong-tenant resolution
grep 'orgSrc=oldest-membership' backend.log

# Cookie problems
grep -E 'dupCookies=|cookieBytes=[0-9]{4,}' backend.log

# Real CORS denials and masked payload errors
grep -E '\[cors\] rejected|\[pre-router\]' backend.log

# Boot-time config (run once per deploy; compare across replicas)
grep -E '\[jwt-secret\]|\[cookies\]' backend.log
```

`[jwt-secret] sha256=…` must match the frontend's `[middleware][jwt-secret] sha256=…`.
A mismatch silently 401s every request. If more than one backend replica runs, all
must print the same value — and all must have `COOKIE_SIGNING_SECRET` set, or an
`active_org_id` signed by one replica fails verification on another.

## Snippet to send the affected user

Ask them to open the failing page, press F12 → Console, paste this, reproduce the
failure, then send back the output. It captures only request metadata — no cookie
values, no tokens, no response bodies.

```js
(() => {
  const out = [];
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    const t0 = performance.now();
    try {
      const r = await origFetch(...args);
      if (!r.ok) out.push({ url, status: r.status, ms: Math.round(performance.now() - t0) });
      return r;
    } catch (e) {
      // A CORS block or a cross-origin redirect surfaces here as a TypeError
      // with no status — that distinction is the point of capturing it.
      out.push({ url, status: 'BLOCKED/NETWORK', error: String(e) });
      throw e;
    }
  };
  window.addEventListener('session-expired', () => out.push({ event: 'session-expired' }));
  window.__dumpDiag = () => {
    console.log('=== SEND THIS ===');
    console.log(JSON.stringify({ href: location.href, ua: navigator.userAgent, failures: out }, null, 2));
  };
  console.log('Diagnostics armed. Reproduce the problem, then run: __dumpDiag()');
})();
```

Also ask for: **DevTools → Application → Cookies** — specifically whether
`access_token` or `active_org_id` appears **twice** with different `Domain`
values, and the total cookie size.

Reading the result:

- `status: 'BLOCKED/NETWORK'` → a true CORS block or cross-origin redirect; correlate with `[cors] rejected` or the proxy log.
- `status: 401` in bursts followed by `session-expired` → the refresh cluster.
- `status: 403/404` on some panels only → wrong-tenant resolution; check `orgSrc`.
- `status: 413` → oversized payload (now returned readably rather than as a CORS error).

## If it is none of these

Check the reverse proxy directly, since it is outside both repos:
`large_client_header_buffers` (default `4 8k`), `client_max_body_size` (default
`1m`, versus the app's 10 MB limit), and `proxy_read_timeout`. Any of these
rejects the request **before** it reaches the app, with no CORS headers, and
leaves no trace in the application log.

## API navigation burst fix (api.xisuite.cloud)

The September 2026 configuration used the same 10r/s, burst-20 request zone and
20-connection zone for API and MCP. Keep those shared zones unchanged. The scoped
generator adds API-only zones (10r/s, burst 80, delay 20, 80 connections) and a
local 429 handler with `Retry-After: 5`. Upstream errors keep their existing
responses. Docs authentication, health routes, redirects, TLS and MCP are preserved.

Run the regression check locally (Docker required for actual nginx traffic tests):

```bash
TEST_NGINX=1 node --test scripts/nginx-api-limits.test.cjs
```

Copy `scripts/nginx-api-limits.cjs` to the server if these uncommitted changes have
not been deployed. Run the following as a **single bash script**, from the backend
directory. It validates the known API layout, stages files, backs up the original,
tests before reload, verifies health, and restores the original on failure.
The allowlist below was confirmed from this server's environment; if it changes,
regenerate using its effective `ALLOWED_ORIGINS` (or `FRONTEND_URL`). The map covers
configured origins and their subdomains, matching the backend's general API policy;
it does not grant arbitrary/custom-domain origins access to task endpoints.

```bash
#!/usr/bin/env bash
set -euo pipefail
sudo -v
exec 9>/home/deploy/nginx-api-limits.lock
flock -n 9 || { echo 'Another API nginx update is running'; exit 1; }
API_FILE=$(readlink -f /etc/nginx/sites-enabled/api)
HTTP_FILE=/etc/nginx/conf.d/xisuite-api-limits.conf
HANDLER_FILE=/etc/nginx/snippets/xisuite-api-throttled.conf
BACKUP=$(mktemp -d /home/deploy/nginx-api-backup.XXXXXX)
STAGE=$(mktemp -d /home/deploy/nginx-api-stage.XXXXXX)
CHANGED=0

cleanup() {
    local result=$?
    trap - EXIT
    if [ "$result" -ne 0 ] && [ "$CHANGED" -eq 1 ]; then
        echo "Restoring nginx from $BACKUP"
        sudo cp -a "$BACKUP/api.conf" "$API_FILE"
        sudo rm -f "$HTTP_FILE" "$HANDLER_FILE"
        if sudo nginx -t && sudo systemctl reload nginx; then
            echo 'Original nginx configuration restored and reloaded'
        else
            echo "ROLLBACK FAILED: inspect nginx; original saved in $BACKUP" >&2
        fi
    fi
    rm -rf "$STAGE"
    exit "$result"
}
trap cleanup EXIT

# Refuse to overwrite another installation or start from a broken configuration.
[ ! -e "$HTTP_FILE" ] && [ ! -L "$HTTP_FILE" ]
[ ! -e "$HANDLER_FILE" ] && [ ! -L "$HANDLER_FILE" ]
sudo nginx -t
curl -fsS --max-time 10 http://127.0.0.1:3001/api/v1/health >/dev/null
sudo cp -a "$API_FILE" "$BACKUP/api.conf"
sudo cat "$API_FILE" > "$STAGE/original.conf"
ALLOWED_ORIGINS='https://xisuite.cloud,https://app.xisuite.cloud,https://auth.xisuite.cloud' \
    node scripts/nginx-api-limits.cjs "$STAGE/original.conf" "$STAGE/generated"
diff -u "$STAGE/original.conf" "$STAGE/generated/api.conf" || [ "$?" -eq 1 ]

CHANGED=1
sudo install -d -m 755 /etc/nginx/snippets
sudo install -m 644 "$STAGE/generated/http.conf" "$HTTP_FILE"
sudo install -m 644 "$STAGE/generated/handler.conf" "$HANDLER_FILE"
sudo cp "$STAGE/generated/api.conf" "$API_FILE"
sudo nginx -t
sudo systemctl reload nginx
curl -fsS --retry 3 --retry-delay 2 --max-time 10 \
    --resolve api.xisuite.cloud:443:127.0.0.1 \
    https://api.xisuite.cloud/api/v1/health >/dev/null
echo "API nginx update verified. Original configuration: $BACKUP/api.conf"
```

After reload, open status menus on ten production tasks, including XE-T565,
without selecting a status. Check the network panel for `task-statuses` and
`available-transitions` responses and capture screenshots. Run deliberate excess
traffic tests only against the local nginx fixture, not production. If browser
validation fails, restore the saved `api.conf`, remove only the two added
`xisuite-api-*` files above, run `sudo nginx -t`, and reload nginx.

The frontend change needs its normal deployment separately. Both detail views
now wait for status configuration and transitions, show localized errors and a
keyboard-operable retry, and refetch only failed queries. A 429 retry waits for
the advertised cooldown; no automatic task mutation retries are added.
