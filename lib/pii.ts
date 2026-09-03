import 'server-only';
import crypto from 'node:crypto';
import { getSetting, setSetting } from './db';

/**
 * Identifier tokenisation for text WE generate (Office conversions, CSV, TXT).
 *
 * Two deliberate design choices:
 *
 * 1. Tokenise, do not mask. Blanking an EIN to XX-XXXXXXX destroys the reader's
 *    ability to match a 1099 to its payer. A stable pseudonym keeps every
 *    relationship the answer depends on — same payer across two forms, same
 *    account across two statements — while the identifier itself stays local.
 *
 * 2. Tokens are derived by HMAC of the value, so the same EIN maps to the same
 *    token across every document and every conversation with no mapping table to leak.
 *
 * Hard limitation, stated plainly: this cannot touch native PDFs or images. We
 * send those as bytes and pixels, and the model reads the number off the scan
 * directly. Redacting those would mean rasterise -> OCR -> locate -> black-box,
 * which throws away the native-PDF fidelity that makes this pipeline good and
 * risks covering the wrong figure. This reduces exposure; it does not remove PII.
 */

export type PiiCounts = Record<string, number>;

async function tokenKey(): Promise<string> {
  let key = await getSetting('pii_token_key', '');
  if (!key) {
    key = crypto.randomBytes(32).toString('hex');
    await setSetting('pii_token_key', key);
  }
  return key;
}

/** Binds the HMAC key once so the per-value tagger stays synchronous. */
function makeTagger(key: string) {
  return (kind: string, value: string): string => {
  const digest = crypto
    .createHmac('sha256', key)
    .update(`${kind}:${value.replace(/\D/g, '')}`)
    .digest('hex');
  return `[${kind}-${digest.slice(0, 4)}]`;
  };
}

/** ABA routing numbers carry a checksum, which nearly eliminates false hits. */
function isValidAba(digits: string): boolean {
  if (digits.length !== 9) return false;
  const d = [...digits].map(Number);
  const sum =
    3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + 1 * (d[2] + d[5] + d[8]);
  return sum % 10 === 0 && sum > 0;
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Conservative by design. A false positive silently corrupts a number the
 * answer depends on, which is worse than a miss — so every rule either has a
 * checksum, a punctuation shape, or an adjacent label.
 */
export async function tokenizeText(
  input: string,
): Promise<{ text: string; counts: PiiCounts }> {
  const counts: PiiCounts = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const tag = makeTagger(await tokenKey());
  let text = input;

  // SSN / ITIN in dashed form — unambiguous.
  text = text.replace(/\b(\d{3}-\d{2}-\d{4})\b/g, (m) => {
    bump('SSN');
    return tag('SSN', m);
  });

  // EIN in dashed form — unambiguous.
  text = text.replace(/\b(\d{2}-\d{7})\b/g, (m) => {
    bump('EIN');
    return tag('EIN', m);
  });

  // Bare 9-digit runs only when a label says what they are.
  text = text.replace(
    /\b(ssn|social\s*security(?:\s*(?:no|number|#))?|itin|tin)\b([^\dA-Za-z]{0,12})(\d{9})\b/gi,
    (_m, label: string, gap: string, digits: string) => {
      bump('SSN');
      return `${label}${gap}${tag('SSN', digits)}`;
    },
  );

  // Labelled account numbers. Never bare digit runs — those are usually amounts.
  text = text.replace(
    /\b(account|acct|a\/c)\b([^\dA-Za-z]{0,12})(\d{6,17})\b/gi,
    (_m, label: string, gap: string, digits: string) => {
      bump('ACCT');
      return `${label}${gap}${tag('ACCT', digits)}`;
    },
  );

  // Routing numbers — checksum-gated. The lookbehind also excludes anything
  // preceded by a currency symbol, a digit, a comma or a decimal point, so a
  // money figure like $123456789 or 1,123456789 or 123456789.00 is left alone.
  // Roughly 10% of random 9-digit runs pass the ABA checksum, so the
  // surrounding-context guard is doing as much work as the checksum here.
  text = text.replace(/(?<![$£€\d.,])(\d{9})(?![.,\d])/g, (m, digits: string) =>
    isValidAba(digits) ? (bump('ABA'), tag('ABA', digits)) : m,
  );

  // Card numbers — Luhn-gated, and the shape must be either a contiguous run or
  // conventional 4-4-4-4 grouping. A permissive `(?:\d[ -]?){15,16}` would
  // happily span several unrelated space-separated numbers in a table row and
  // replace them all with one token.
  text = text.replace(
    /(?<![$£€\d.,])(\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{3,4}|\d{15,16})(?![.,\d])/g,
    (m) => {
      const digits = m.replace(/\D/g, '');
      if (digits.length < 15 || digits.length > 16 || !passesLuhn(digits)) return m;
      bump('CARD');
      return tag('CARD', digits);
    },
  );

  return { text, counts };
}

export const describeCounts = (counts: PiiCounts): string =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
