/**
 * What the upload path refuses, and why.
 *
 * The case that prompted this: an encrypted PDF loaded fine, reported a correct
 * page count, stored cleanly, and then failed at send time with the model
 * saying "badly formatted or corrupted" and naming no file. With several
 * documents attached, one locked file failed the whole message and the
 * unlocked ones took the blame.
 *
 * A PDF's page tree is not encrypted even when its content streams are, which
 * is exactly why the old check passed it. So the fixture here is a real
 * encrypted PDF whose page count reads correctly — anything weaker would not
 * reproduce the bug.
 *
 * No database, no blob store, no network: the stubs record what would have been
 * written, so a refusal can be distinguished from a silent acceptance.
 *
 *   node tests/upload-guards.mjs
 */
import ts from 'typescript';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const ROOT = process.cwd();

let pass = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`ok    ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

/** Compiles the real ingest.ts; only its edges are stubbed. */
function build() {
  // Inside the project, not the system temp dir: ingest.ts imports mammoth,
  // exceljs and pdf-lib, and Node resolves those by walking up from the
  // importing file. From /tmp there is no node_modules to find. Removed in the
  // finally block below.
  const dir = mkdtempSync(path.join(ROOT, '.tmp-upload-'));

  // Marks the compiled output as ESM. Without it Node parses ingest.js as
  // CommonJS first, fails, and re-parses with a warning.
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');

  // Records rather than refuses, so a test can tell "was rejected" apart from
  // "was accepted and stored".
  writeFileSync(
    path.join(dir, 'db-stub.js'),
    [
      `export const written = [];`,
      `export async function run(q, ...p) { written.push(p); }`,
      `// The dedupe lookup must miss, or ingestFile hands back the existing row`,
      `// and never reaches the PDF checks at all. Only the read-back after the`,
      `// insert returns a row.`,
      `export async function one(q) {`,
      `  if (/sha256/.test(q)) return null;`,
      `  return { id: 'file-1', filename: 'x', kind: 'pdf', page_count: 1 };`,
      `}`,
      `export const reset = () => { written.length = 0; };`,
    ].join('\n'),
  );

  writeFileSync(
    path.join(dir, 'storage-stub.js'),
    [
      `export const stored = [];`,
      `export async function putBlob(key, body) { stored.push({ key, size: body.length }); `
        + `return { pathname: key, size: body.length }; }`,
      `export async function getBlob() { return null; }`,
      `export const reset = () => { stored.length = 0; };`,
    ].join('\n'),
  );

  writeFileSync(
    path.join(dir, 'config-stub.js'),
    [`export const MAX_PDF_PAGES = 600;`, `export const PII_MODE = 'off';`].join('\n'),
  );

  writeFileSync(
    path.join(dir, 'pii-stub.js'),
    [`export async function tokenizeText(text) { return { text, counts: {} }; }`].join('\n'),
  );

  const { outputText } = ts.transpileModule(readFileSync(path.join(ROOT, 'lib/ingest.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'lib/ingest.ts',
  });
  writeFileSync(
    path.join(dir, 'ingest.js'),
    outputText
      .replace(/^import ['"]server-only['"];?$/m, '')
      .replace(/from ['"]\.\/db['"]/g, "from './db-stub.js'")
      .replace(/from ['"]\.\/config['"]/g, "from './config-stub.js'")
      .replace(/from ['"]\.\/storage['"]/g, "from './storage-stub.js'")
      .replace(/from ['"]\.\/pii['"]/g, "from './pii-stub.js'"),
  );
  return dir;
}

const dir = build();
const ingest = await import(pathToFileURL(path.join(dir, 'ingest.js')).href);
const store = await import(pathToFileURL(path.join(dir, 'storage-stub.js')).href);

const upload = (filename, buffer) =>
  ingest.ingestFile({ userId: 'u1', conversationId: 'c1', filename, buffer });

/** Reproduces the real failure: encrypted content, readable page tree. */
function encryptedPdf() {
  return readFileSync(path.join(ROOT, 'tests/fixtures/encrypted-minimal.pdf'));
}

async function cleanPdf(pages = 2) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return Buffer.from(await doc.save());
}

try {
  /* ------------------------------------------- the fixture is the real shape */

  const enc = encryptedPdf();
  const loaded = await PDFDocument.load(enc, { ignoreEncryption: true });
  check(
    'the fixture is encrypted but still reports its page count',
    loaded.isEncrypted && loaded.getPageCount() === 1,
    'this is why the old check passed it',
  );

  /* --------------------------------------------------- an encrypted PDF ... */

  store.reset();
  let refused = null;
  try {
    await upload('2025 Client Copy.pdf', enc);
  } catch (err) {
    refused = err.message;
  }

  check('an encrypted PDF is refused at upload', refused !== null);
  check(
    'the refusal names the file, so a batch upload says which one',
    /2025 Client Copy\.pdf/.test(refused ?? ''),
    (refused ?? '').slice(0, 60) + '…',
  );
  check(
    'and says it is encrypted rather than blaming the format',
    /encrypt/i.test(refused ?? '') && !/truncated/i.test(refused ?? ''),
  );
  check(
    'and warns that it may open with no password prompt',
    /password/i.test(refused ?? ''),
    'the permissions-lock case is the confusing one',
  );
  check(
    'nothing was stored, so it cannot fail again later at send time',
    store.stored.length === 0,
  );

  /* --------------------------------------------------------- a clean PDF ... */

  store.reset();
  let accepted = true;
  try {
    await upload('clean.pdf', await cleanPdf(3));
  } catch {
    accepted = false;
  }
  check('an unencrypted PDF is still accepted', accepted);
  check('and its bytes are stored', store.stored.length === 1);

  /* ----------------------------------------------- a genuinely broken PDF ... */

  store.reset();
  let broken = null;
  try {
    await upload('truncated.pdf', Buffer.from('%PDF-1.4\nthis is not a pdf body'));
  } catch (err) {
    broken = err.message;
  }
  check('a malformed PDF is refused too', broken !== null);
  check(
    'but with the format message, not the encryption one',
    /truncated|not really a PDF/i.test(broken ?? '') && !/encrypt/i.test(broken ?? ''),
    'two problems, two remedies',
  );
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.error('\n' + (err.stack ?? err.message));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
