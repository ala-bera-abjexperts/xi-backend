/**
 * Dev/QA + client-showcase tool: render every email template (MJML + Handlebars
 * + i18n) to HTML and build a gallery `index.html` with EN/DE and XISUITE/branded
 * toggles. Also a smoke test that exits non-zero if any template fails to compile.
 *
 * Usage:  node scripts/preview-emails.mjs [outputDir]
 *   (default outputDir: scripts/email-preview)
 *
 * Then serve it:
 *   npx http-server scripts/email-preview -p 8848 -a 127.0.0.1
 *   # or:  cd scripts/email-preview && python3 -m http.server 8848 --bind 127.0.0.1
 *   # open http://127.0.0.1:8848/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import HandlebarsPkg from 'handlebars';
import mjmlPkg from 'mjml';

const Handlebars = HandlebarsPkg.create ? HandlebarsPkg.create() : HandlebarsPkg;
const mjml2html = typeof mjmlPkg === 'function' ? mjmlPkg : mjmlPkg.default;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mailDir = path.join(__dirname, '..', 'src', 'mail');
const templatesDir = path.join(mailDir, 'templates');
const partialsDir = path.join(templatesDir, 'partials');
const i18nDir = path.join(mailDir, 'i18n');
const outDir = process.argv[2] || path.join(__dirname, 'email-preview');
const EXT = '.mjml.hbs';

// ── i18n ──
const catalogs = {};
for (const f of fs.readdirSync(i18nDir)) {
  if (f.endsWith('.json'))
    catalogs[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(i18nDir, f), 'utf8'));
}

// ── helpers (mirror EmailTemplateService) ──
const toStr = v =>
  v == null ? '' : typeof v === 'string' ? v : ['number', 'boolean'].includes(typeof v) ? String(v) : '';
Handlebars.registerHelper('t', (key, options) => {
  const root = options?.data?.root ?? {};
  const tmpl = (root._catalog ?? {})[key] ?? (root._fallback ?? {})[key] ?? key;
  const vars = options?.hash ?? {};

  return tmpl.replace(/\{(\w+)\}/g, (_m, k) => toStr(vars[k]));
});
Handlebars.registerHelper('nl2br', s =>
  s == null
    ? ''
    : new Handlebars.SafeString(Handlebars.Utils.escapeExpression(toStr(s)).replace(/\r?\n/g, '<br>')),
);
Handlebars.registerHelper('eq', (a, b) => a === b);
Handlebars.registerHelper('ne', (a, b) => a !== b);
Handlebars.registerHelper('or', (...a) => a.slice(0, -1).some(Boolean));
Handlebars.registerHelper('upper', s => toStr(s).toUpperCase());
Handlebars.registerHelper('fallback', (v, d) => (v == null || v === '' ? d : v));

// ── partials ──
Handlebars.registerPartial('layout', fs.readFileSync(path.join(templatesDir, `layout${EXT}`), 'utf8'));
for (const f of fs.readdirSync(partialsDir)) {
  if (f.endsWith(EXT))
    Handlebars.registerPartial(f.slice(0, -EXT.length), fs.readFileSync(path.join(partialsDir, f), 'utf8'));
}

const brand = (over = {}) => ({
  appName: 'XISUITE',
  orgName: 'XISUITE',
  fromName: 'XISUITE',
  logoUrl: 'https://app.xisuite.cloud/images/logo/xisuite_logo_wide.png',
  primaryColor: '#f79e08',
  primaryDark: '#f18217',
  appUrl: 'https://app.xisuite.cloud',
  ...over,
});
const tenant = brand({ orgName: 'Brightwave GmbH', primaryColor: '#2563EB', primaryDark: '#1E4FBF' });

// Template catalog: friendly metadata + sample data for the showcase.
const TEMPLATES = [
  {
    name: 'auth-otp',
    title: 'Signup verification (OTP)',
    desc: 'Six-digit code to verify a new account email.',
    data: { titleKey: 'auth.otp.signup.title', introKey: 'auth.otp.signup.intro', otp: '482913', preheader: 'Your XISUITE verification code' },
  },
  {
    name: 'auth-password-reset',
    title: 'Password reset',
    desc: 'Secure link to choose a new password.',
    data: { name: 'Aisha', ctaUrl: 'https://app.xisuite.cloud/auth/update-password?token=abc123', preheader: 'Reset your password' },
  },
  {
    name: 'auth-welcome',
    title: 'Welcome',
    desc: 'Sent after a new account is verified.',
    data: { name: 'Aisha', ctaUrl: 'https://app.xisuite.cloud', preheader: 'Welcome to XISUITE' },
  },
  {
    name: 'invite-organization',
    title: 'Organization invitation',
    desc: 'Invite a new member to an organization.',
    data: { name: 'Aisha', org: 'Brightwave GmbH', role: 'admin', ctaUrl: 'https://app.xisuite.cloud/invite?token=xyz', preheader: 'You’re invited' },
  },
  {
    name: 'invite-space',
    title: 'Space invitation',
    desc: 'Invite a member to a specific space.',
    data: { name: 'Aisha', inviter: 'Lukas Weber', space: 'Risk Register 2026', org: 'Brightwave GmbH', role: 'editor', date: 'July 7, 2026', ctaUrl: 'https://app.xisuite.cloud/invite?token=xyz', preheader: 'Space invitation' },
  },
  {
    name: 'notification',
    title: 'Notification',
    desc: 'One flexible template for every notification type (mentions, reminders, workflow, and more).',
    data: { eyebrow: 'Task mention', title: 'You were mentioned by Lukas Weber', body: 'Lukas mentioned you in “Q3 risk review”:\n“Can you confirm the mitigation owner before Friday?”', recipientName: 'Aisha', ctaUrl: 'https://app.xisuite.cloud/tasks/RISK-204', preferencesUrl: 'https://app.xisuite.cloud/user-profile/notifications', preheader: 'You were mentioned' },
  },
];

const LOCALES = ['en', 'de'];
const VARIANTS = [
  ['default', brand()],
  ['branded', tenant],
];

fs.mkdirSync(outDir, { recursive: true });
let failures = 0;

for (const locale of LOCALES) {
  for (const tpl of TEMPLATES) {
    for (const [variant, b] of VARIANTS) {
      try {
        const fn = Handlebars.compile(fs.readFileSync(path.join(templatesDir, `${tpl.name}${EXT}`), 'utf8'));
        const mjmlSrc = fn({ data: tpl.data, brand: b, locale, _catalog: catalogs[locale] ?? {}, _fallback: catalogs.en ?? {} });
        const { html, errors } = mjml2html(mjmlSrc, { validationLevel: 'soft', minify: false });
        if (errors?.length) {
          console.warn(`! ${tpl.name}.${locale}.${variant}: ${errors.map(e => e.formattedMessage || e.message).join('; ')}`);
        }
        fs.writeFileSync(path.join(outDir, `${tpl.name}.${locale}.${variant}.html`), html);
      } catch (err) {
        failures++;
        console.error(`✗ ${tpl.name}.${locale}.${variant}: ${err.message}`);
      }
    }
  }
}

// ── gallery index.html ──
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cards = TEMPLATES.map(
  t => `      <article class="card">
        <header class="card__head">
          <h2>${esc(t.title)}</h2>
          <p>${esc(t.desc)}</p>
          <a class="card__open" data-name="${t.name}" target="_blank" rel="noopener">Open full ↗</a>
        </header>
        <div class="card__frame">
          <iframe loading="lazy" data-name="${t.name}" src="${t.name}.en.default.html" title="${esc(t.title)}"></iframe>
        </div>
      </article>`,
).join('\n');

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>XISUITE Email Templates</title>
<style>
  :root { --brand:#f79e08; --ink:#22303E; --muted:#697586; --bg:#F5F5F9; --line:#E7EAEE; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:'Public Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:var(--ink); background:var(--bg); }
  header.top { background:#fff; border-bottom:1px solid var(--line); padding:22px 28px; position:sticky; top:0; z-index:10; }
  header.top h1 { margin:0; font-size:20px; font-weight:700; letter-spacing:-0.2px; }
  header.top h1 span { color:var(--brand); }
  header.top p { margin:4px 0 0; color:var(--muted); font-size:13px; }
  .controls { display:flex; gap:24px; flex-wrap:wrap; margin-top:16px; }
  .group { display:flex; align-items:center; gap:8px; }
  .group > span { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:0.6px; font-weight:700; }
  .seg { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#fff; }
  .seg button { border:0; background:#fff; padding:8px 14px; font:inherit; font-size:13px; font-weight:600; color:var(--muted); cursor:pointer; }
  .seg button.active { background:var(--brand); color:#fff; }
  main { padding:28px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:24px; max-width:1400px; margin:0 auto; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; overflow:hidden; display:flex; flex-direction:column; box-shadow:0 1px 3px rgba(34,48,62,0.06); }
  .card__head { padding:16px 18px 12px; border-bottom:1px solid var(--line); }
  .card__head h2 { margin:0; font-size:15px; font-weight:700; }
  .card__head p { margin:5px 0 0; font-size:12.5px; color:var(--muted); line-height:1.5; }
  .card__open { display:inline-block; margin-top:10px; font-size:12.5px; font-weight:600; color:var(--brand); text-decoration:none; }
  .card__frame { background:var(--bg); height:560px; overflow:auto; }
  .card__frame iframe { width:100%; height:760px; border:0; display:block; }
  footer.foot { text-align:center; color:var(--muted); font-size:12px; padding:24px; }
</style>
</head>
<body>
  <header class="top">
    <h1><span>XI</span>SUITE Email Templates</h1>
    <p>Branded transactional &amp; notification emails. Toggle language and tenant branding below.</p>
    <div class="controls">
      <div class="group"><span>Language</span>
        <div class="seg" id="seg-locale">
          <button data-locale="en" class="active">English</button>
          <button data-locale="de">Deutsch</button>
        </div>
      </div>
      <div class="group"><span>Branding</span>
        <div class="seg" id="seg-variant">
          <button data-variant="default" class="active">XISUITE</button>
          <button data-variant="branded">Brightwave GmbH (sample tenant)</button>
        </div>
      </div>
    </div>
  </header>
  <main>
    <div class="grid">
${cards}
    </div>
  </main>
  <footer class="foot">Generated by scripts/preview-emails.mjs · ${TEMPLATES.length} templates × EN/DE × XISUITE/branded</footer>
<script>
  var state = { locale: 'en', variant: 'default' };
  function refresh() {
    document.querySelectorAll('iframe[data-name]').forEach(function (f) {
      f.src = f.dataset.name + '.' + state.locale + '.' + state.variant + '.html';
    });
    document.querySelectorAll('a[data-name]').forEach(function (a) {
      a.href = a.dataset.name + '.' + state.locale + '.' + state.variant + '.html';
    });
  }
  function wire(id, key) {
    var seg = document.getElementById(id);
    seg.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      state[key] = btn.dataset[key];
      seg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === btn); });
      refresh();
    });
  }
  wire('seg-locale', 'locale');
  wire('seg-variant', 'variant');
  refresh();
</script>
</body>
</html>`;

fs.writeFileSync(path.join(outDir, 'index.html'), indexHtml);

console.log(`\nRendered ${TEMPLATES.length} templates (× ${LOCALES.length} locales × ${VARIANTS.length} variants) + index.html`);
console.log(`Output -> ${outDir}`);
if (failures > 0) {
  console.error(`\n${failures} template(s) failed to render.`);
  process.exit(1);
}
console.log('All templates rendered successfully. Open index.html to browse.');
