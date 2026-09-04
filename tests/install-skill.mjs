/**
 * Installs a skill folder from disk through the real upload route.
 *
 *   node tests/install-skill.mjs "Skills/Tax-Review-Skills/tax-return-review" [firm|personal]
 *
 * The browser sends the folder with a matching array of relative paths, because
 * a File in a form does not keep the path it came from. This does the same, so
 * it exercises the route the UI uses rather than a shortcut around it.
 */
import { encode } from 'next-auth/jwt';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const COOKIE_NAME = 'authjs.session-token';

// Capital S: the folder is Skills/. Windows did not care, but a case-sensitive
// filesystem — every Linux CI box and deploy target — would fail here.
const folder = process.argv[2] ?? 'Skills/Tax-Review-Skills/tax-return-review';
const scope = process.argv[3] === 'personal' ? 'personal' : 'firm';

function env(key) {
  if (process.env[key]) return process.env[key];
  const text = readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  const line = text.split('\n').find((l) => l.trim().startsWith(key + '='));
  return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : '';
}

/** Every file under the folder, with its path relative to the folder itself. */
function walk(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ rel, full });
  }
  return out;
}

const email = env('ADMIN_EMAILS').split(/[,;\s]+/).filter(Boolean)[0].toLowerCase();
const cookie = await encode({
  token: { email, name: email, sub: email },
  secret: env('AUTH_SECRET'),
  salt: COOKIE_NAME,
  maxAge: 3600,
});

const files = walk(folder);
if (!files.length) {
  console.error(`No files under ${folder}`);
  process.exit(1);
}

const form = new FormData();
form.append('scope', scope);
// The picker prefixes the folder's own name, and the route strips it back off;
// mirror that here so the paths land exactly as they would from a browser.
const stem = path.basename(folder);
form.append('paths', JSON.stringify(files.map((f) => `${stem}/${f.rel}`)));
for (const f of files) {
  form.append('files', new Blob([readFileSync(f.full)]), path.basename(f.rel));
}

const res = await fetch(`${BASE}/api/skills`, {
  method: 'POST',
  headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
  body: form,
});

const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`HTTP ${res.status}:`, data.error ?? data);
  process.exit(1);
}

console.log(`installed "${data.name}" as a ${data.scope} skill`);
console.log(`  files   : ${data.files}`);
console.log(`  skipped : ${data.skipped?.length ? data.skipped.join(', ') : 'none'}`);
console.log(`  trigger : ${String(data.description).slice(0, 160)}…`);
