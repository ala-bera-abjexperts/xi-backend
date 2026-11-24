#!/usr/bin/env node
// Generate staged files only. Installation and rollback are in the support runbook.
const fs = require('node:fs');
const path = require('node:path');

function originPattern(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('CORS entries must be HTTP(S) origins without credentials or paths');
  }
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const subdomains = url.hostname.startsWith('[') ? '' : '(?:[a-z0-9-]+\\.)*';
  return `~*^${url.protocol}//${subdomains}${escape(url.host)}$`;
}

function generate(source, origins) {
  const patterns = [...new Set(origins.split(',').map(value => value.trim()).filter(Boolean).map(originPattern))];
  if (!patterns.length) throw new Error('Set ALLOWED_ORIGINS or FRONTEND_URL to the effective backend allowlist');
  // Fail closed on an unexpected virtual host or a previously changed configuration.
  const hosts = [...source.matchAll(/^\s*server_name\s+([^;]+);/gm)].map(match => match[1].trim());
  if (hosts.length !== 2 || hosts.some(host => host !== 'api.xisuite.cloud')) {
    throw new Error('Expected only the two api.xisuite.cloud server blocks');
  }
  const limits = /limit_req zone=api_limit burst=20 nodelay;\s*limit_conn api_conn 20;/g;
  if ([...source.matchAll(limits)].length !== 2 || source.includes('xisuite_api_')) {
    throw new Error('Unexpected limiter configuration; review the active file before applying');
  }
  const api = source.replace(limits, `limit_req zone=xisuite_api_req burst=80 delay=20;
        limit_conn xisuite_api_conn 80;
        limit_req_status 429;
        limit_conn_status 429;
        error_page 429 = @xisuite_api_throttled;
        proxy_intercept_errors off;`)
    .replace(/(server_name\s+api\.xisuite\.cloud;)/g,
      '$1\n    include /etc/nginx/snippets/xisuite-api-throttled.conf;');
  const http = `# HTTP context; the shared MCP zones remain unchanged.
limit_req_zone $binary_remote_addr zone=xisuite_api_req:10m rate=10r/s;
limit_conn_zone $binary_remote_addr zone=xisuite_api_conn:10m;
map $http_origin $xisuite_api_cors_origin {
    default "";
${patterns.map(pattern => `    "${pattern}" $http_origin;`).join('\n')}
}
map $xisuite_api_cors_origin $xisuite_api_cors_credentials {
    "" "";
    default "true";
}
map $https $xisuite_api_hsts {
    default "";
    on "max-age=31536000";
}
`;
  const handler = `# Server context; only local limiter errors enter this handler.
location @xisuite_api_throttled {
    internal;
    default_type application/json;
    add_header Retry-After "5" always;
    add_header Cache-Control "no-store" always;
    add_header Vary "Origin" always;
    add_header Access-Control-Allow-Origin $xisuite_api_cors_origin always;
    add_header Access-Control-Allow-Credentials $xisuite_api_cors_credentials always;
    add_header Access-Control-Expose-Headers "Retry-After" always;
    # add_header replaces parent inheritance: retain the API's security headers.
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
    add_header Strict-Transport-Security $xisuite_api_hsts always;
    return 429 '{"statusCode":429,"message":"Too many requests. Please retry in 5 seconds."}';
}
`;
  return { api, http, handler };
}

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/nginx-api-limits.cjs ACTIVE_API_FILE OUTPUT_DIRECTORY');
  const result = generate(fs.readFileSync(input, 'utf8'), process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '');
  fs.mkdirSync(output, { recursive: true });
  for (const [name, content] of Object.entries(result)) {
    fs.writeFileSync(path.join(output, `${name}.conf`), content, { flag: 'wx', mode: 0o600 });
  }
  console.log(`Staged api.conf, http.conf and handler.conf in ${output}; nothing installed.`);
}

module.exports = { generate, originPattern };
