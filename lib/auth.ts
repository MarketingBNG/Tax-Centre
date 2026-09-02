import 'server-only';
import crypto from 'node:crypto';
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { one, run, audit } from './db';
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  ALLOWED_EMAIL_DOMAIN,
  ADMIN_EMAILS,
  DISABLE_AUTH,
} from './config';
import type { UserRow, Role } from './types';

/* ---------------------------------------------------------------- users */

export const getUserById = (id: string) =>
  one<UserRow>(`SELECT * FROM users WHERE id = ? AND is_active = 1`, id);

export const getUserByEmail = (email: string) =>
  one<UserRow>(`SELECT * FROM users WHERE email = ?`, String(email).trim().toLowerCase());

export function createUser(input: { email: string; role: Role; displayName: string }): UserRow {
  const id = crypto.randomUUID();
  run(
    `INSERT INTO users (id, email, role, display_name, is_active, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
    id,
    input.email.trim().toLowerCase(),
    input.role,
    input.displayName,
    Date.now(),
  );
  return getUserById(id)!;
}

const domainAllows = (email: string) =>
  !ALLOWED_EMAIL_DOMAIN || email.endsWith(`@${ALLOWED_EMAIL_DOMAIN.toLowerCase()}`);

/**
 * Creates or promotes an address listed in ADMIN_EMAILS.
 *
 * Called on every request rather than only at sign-in, so adding someone to
 * the list takes effect on their next request instead of forcing them to sign
 * out and back in. Idempotent, and only writes to the audit log when it
 * actually changes something.
 */
function syncConfiguredAdmin(email: string): UserRow | null {
  const normalised = email.trim().toLowerCase();
  if (!ADMIN_EMAILS.includes(normalised) || !domainAllows(normalised)) return null;

  const existing = getUserByEmail(normalised);

  if (!existing) {
    const created = createUser({ email: normalised, role: 'admin', displayName: normalised });
    audit(created.id, 'user.admin_from_config', 'user', created.id, { email: normalised });
    return created;
  }

  // A configured admin who was deactivated by hand stays deactivated; the list
  // grants a role, it does not override an explicit removal.
  if (!existing.is_active) return null;

  if (existing.role !== 'admin') {
    run(`UPDATE users SET role = 'admin' WHERE id = ?`, existing.id);
    audit(existing.id, 'user.promoted_by_config', 'user', existing.id, { email: normalised });
    return getUserById(existing.id);
  }
  return existing;
}

/**
 * Who is allowed in.
 *
 * Google will happily authenticate any Google account on earth, so identity
 * alone is not authorisation. Two things grant access:
 *
 *   1. Being listed in ADMIN_EMAILS — always an admin, no invitation needed.
 *   2. Being added by an admin under Admin -> People.
 *
 * Anyone else is refused, even with a perfectly valid Google session.
 */
function resolveAccess(email: string, name: string): UserRow | null {
  const normalised = email.trim().toLowerCase();

  if (!domainAllows(normalised)) {
    audit(null, 'login.rejected_domain', 'user', null, { email: normalised });
    return null;
  }

  const fromConfig = syncConfiguredAdmin(normalised);
  if (fromConfig) {
    if (name && fromConfig.display_name === normalised) {
      run(`UPDATE users SET display_name = ? WHERE id = ?`, name, fromConfig.id);
    }
    return fromConfig;
  }

  const existing = getUserByEmail(normalised);
  if (!existing) {
    audit(null, 'login.rejected_not_invited', 'user', null, { email: normalised });
    return null;
  }
  if (!existing.is_active) {
    audit(existing.id, 'login.rejected_inactive', 'user', existing.id, null);
    return null;
  }
  return existing;
}

/* ------------------------------------------------------------- NextAuth */

export const { handlers, signIn, signOut, auth } = NextAuth({
  // `next start` runs in production mode, where Auth.js refuses to infer the
  // callback URL from the Host header unless told the deployment is trusted.
  // That is correct for a self-hosted app we control; set AUTH_URL in .env once
  // this is behind a real domain so the header is not load-bearing at all.
  trustHost: true,

  providers: [
    Google({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      // Ask Google to pre-filter to the firm's Workspace domain where one is
      // configured. This is a convenience, not a control — resolveAccess is
      // what actually enforces it.
      authorization: ALLOWED_EMAIL_DOMAIN
        ? { params: { hd: ALLOWED_EMAIL_DOMAIN, prompt: 'select_account' } }
        : { params: { prompt: 'select_account' } },
    }),
  ],

  session: { strategy: 'jwt', maxAge: 12 * 60 * 60 },

  pages: { signIn: '/login', error: '/login' },

  callbacks: {
    signIn({ profile }) {
      const email = profile?.email;
      if (!email) return false;
      // Google's own verification flag; an unverified address must not pass.
      if (profile?.email_verified === false) return false;
      return Boolean(resolveAccess(email, String(profile?.name ?? '')));
    },

    jwt({ token }) {
      // Re-read the row on every request rather than trusting the token: a
      // role change or a deactivation then takes effect immediately instead of
      // waiting for the JWT to expire.
      if (token.email) syncConfiguredAdmin(String(token.email));
      const row = token.email ? getUserByEmail(String(token.email)) : null;
      token.appUserId = row?.is_active ? row.id : undefined;
      token.appRole = row?.is_active ? row.role : undefined;
      return token;
    },

    session({ session, token }) {
      session.user.id = (token.appUserId as string) ?? '';
      session.user.role = (token.appRole as Role) ?? 'reviewer';
      return session;
    },
  },
});

/* ------------------------------------------------------------- helpers */

const PREVIEW_EMAIL = 'preview@localhost';
let warnedAboutDisabledAuth = false;

/**
 * The signed-in user as a database row, or null.
 *
 * Every page and route funnels through here, so DISABLE_AUTH only has to be
 * honoured in this one place to bypass sign-in everywhere consistently.
 */
export async function currentUser(): Promise<UserRow | null> {
  if (DISABLE_AUTH) {
    if (!warnedAboutDisabledAuth) {
      warnedAboutDisabledAuth = true;
      console.warn(
        [
          '',
          '  ⚠  DISABLE_AUTH=true — sign-in is bypassed and every visitor is an admin.',
          '     Set it to false in .env before this is reachable by anyone else.',
          '',
        ].join('\n'),
      );
    }
    return getUserByEmail(PREVIEW_EMAIL) ?? createUser({
      email: PREVIEW_EMAIL,
      role: 'admin',
      displayName: 'Preview (auth disabled)',
    });
  }

  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  return getUserById(id);
}

export const isAuthConfigured = (): boolean =>
  Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

/* --------------------------------------------------- route-handler guards */

export const unauthorized = () => Response.json({ error: 'Not signed in' }, { status: 401 });
export const forbidden = () => Response.json({ error: 'Admins only' }, { status: 403 });
export const notFound = () => Response.json({ error: 'Not found' }, { status: 404 });
export const badRequest = (message: string) => Response.json({ error: message }, { status: 400 });

export { audit };
