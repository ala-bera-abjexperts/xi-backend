const assert = require('node:assert/strict');
const { test } = require('node:test');
const { generate, originPattern } = require('./nginx-api-limits.cjs');

const server = port => `server {
    listen ${port};
    server_name api.xisuite.cloud;
    location /docs { auth_basic "Docs"; auth_basic_user_file /tmp/passwords; }
    location = /health { return 200 "healthy"; }
    location / {
        limit_req zone=api_limit burst=20 nodelay;
        limit_conn api_conn 20;
        proxy_pass http://127.0.0.1:8082;
    }
}
`;
const source = server(8080) + server(8081);

test('scopes changes to the two API limiters and preserves all other routes', () => {
  const result = generate(source, 'https://xisuite.cloud');
  assert.equal((result.api.match(/burst=80 delay=20/g) || []).length, 2);
  assert.equal((result.api.match(/limit_conn xisuite_api_conn 80/g) || []).length, 2);
  assert.ok(result.api.includes('location /docs { auth_basic "Docs"; auth_basic_user_file /tmp/passwords; }'));
  assert.ok(result.api.includes('location = /health { return 200 "healthy"; }'));
  assert.ok(result.api.includes('proxy_intercept_errors off;'));
  assert.throws(() => generate(source.replace('api.xisuite.cloud', 'mcp.xisuite.cloud'), 'https://xisuite.cloud'));
  assert.throws(() => generate(result.api, 'https://xisuite.cloud'));
  assert.throws(() => generate(source, ''));
});

test('CORS patterns match configured protocols, ports and subdomain boundaries', () => {
  const pattern = new RegExp(originPattern('https://xisuite.cloud').slice(2), 'i');
  for (const origin of ['https://xisuite.cloud', 'https://ambertech-solutions.xisuite.cloud']) assert.ok(pattern.test(origin));
  for (const origin of ['http://xisuite.cloud', 'https://evilxisuite.cloud', 'https://xisuite.cloud.evil.test', 'null', 'https://xisuite.cloud:444']) assert.ok(!pattern.test(origin));
  assert.ok(new RegExp(originPattern('http://lvh.me:3000').slice(2)).test('http://abj-experts.lvh.me:3000'));
  for (const origin of ['https://user:pass@xisuite.cloud', 'https://xisuite.cloud/path', 'file:///tmp/a', 'https://xisuite.cloud/?q=1']) assert.throws(() => originPattern(origin));
});

test('real nginx queues normal bursts and returns readable local 429 errors only', { skip: !process.env.TEST_NGINX }, async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xisuite-nginx-test-'));
  const name = `xisuite-nginx-test-${process.pid}`;
  const result = generate(source, 'https://xisuite.cloud');
  const config = `events { worker_connections 1024; }
http {
 limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
 limit_conn_zone $binary_remote_addr zone=api_conn:10m;
 ${result.http}
 ${result.api.replaceAll('include /etc/nginx/snippets/xisuite-api-throttled.conf;', result.handler)}
 server { listen 8082;
   location / { add_header Access-Control-Allow-Origin "https://ambertech-solutions.xisuite.cloud" always; return 200 "ok"; }
   location = /upstream429 { add_header Retry-After "9" always; return 429 "backend rejection"; }
 }
}`;
  fs.writeFileSync(path.join(root, 'nginx.conf'), config);
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    docker('run', '-d', '--name', name, '-p', '127.0.0.1::8080', '-v', `${root}/nginx.conf:/etc/nginx/nginx.conf:ro`, 'nginx:1.26-alpine');
    docker('exec', name, 'nginx', '-t');
    const port = docker('port', name, '8080/tcp').trim().split(':').at(-1);
    const base = `http://127.0.0.1:${port}`;
    const request = async (origin, route = '/') => {
      const response = await fetch(base + route, { headers: { Origin: origin } });
      return { status: response.status, headers: response.headers, body: await response.text() };
    };
    const allowed = 'https://ambertech-solutions.xisuite.cloud';
    const normal = await Promise.all(Array.from({ length: 30 }, () => request(allowed)));
    assert.ok(normal.every(response => response.status === 200));
    assert.ok(normal.every(response => response.headers.get('access-control-allow-origin') === allowed));
    for (const origin of [allowed, 'https://xisuite.cloud.attacker.test']) {
      const responses = await Promise.all(Array.from({ length: 110 }, () => request(origin)));
      const rejected = responses.filter(response => response.status === 429);
      assert.ok(rejected.length > 0);
      assert.ok(responses.every(response => [200, 429].includes(response.status)));
      for (const response of rejected) {
        assert.equal(response.headers.get('retry-after'), '5');
        assert.equal(JSON.parse(response.body).statusCode, 429);
        assert.equal(response.headers.get('access-control-allow-origin'), origin === allowed ? allowed : null);
        assert.equal(response.headers.get('access-control-allow-credentials'), origin === allowed ? 'true' : null);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      }
      assert.equal((await request(origin, '/health')).status, 200);
    }
    await new Promise(resolve => setTimeout(resolve, 8000));
    const upstream = await request(allowed, '/upstream429');
    assert.equal(upstream.status, 429);
    assert.equal(upstream.headers.get('retry-after'), '9');
    assert.equal(upstream.body, 'backend rejection');
  } finally {
    try { docker('rm', '-f', name); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
