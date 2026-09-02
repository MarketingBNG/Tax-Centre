import 'server-only';
import crypto from 'node:crypto';
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { one, run, audit } from './db';
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  ALLOWED_EMAIL_DOMAIN,
  BOOTSTRAP_ADMIN_EMAIL,
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

const userCount = () => one<{ c: number }>(`SELECT COUNT(*) AS c FROM users`)?.c ?? 0;

/**
 * Who is allowed in.
 *
 * Google will happily authenticate any Google account on earth, so identity
 * alone is not authorisation. The users table is the allowlist: an admin adds
 * someone by email first, and only then can they sign in. The one exception is
 * the very first sign-in, which bootstraps the initial admin — and even that is
 * pinned to BOOTSTRAP_ADMIN_EMAIL when it is set.
 */
function resolveAccess(email: string, name: string): UserRow | null {
  const normalised = email.trim().toLowerCase();

  if (ALLOWED_EMAIL_DOMAIN && !normalised.endsWith(`@${ALLOWED_EMAIL_DOMAIN.toLowerCase()}`)) {
    audit(null, 'login.rejected_domain', 'user', null, { email: normalised });
    return null;
  }

  const existing = getUserByEmail(normalised);
  if (existing) {
    if (!existing.is_active) {
      audit(existing.id, 'login.rejected_inactive', 'user', existing.id, null);
      return null;
    }
    return existing;
  }

  // First-run bootstrap. Self-closing: once one account exists this never fires.
  if (userCount() === 0) {
    if (BOOTSTRAP_ADMIN_EMAIL && normalised !== BOOTSTRAP_ADMIN_EMAIL.toLowerCase()) {
      audit(null, 'login.rejected_bootstrap', 'user', null, { email: normalised });
      return null;
    }
    const created = createUser({ email: normalised, role: 'admin', displayName: name || normalised });
    audit(created.id, 'setup.first_admin', 'user', created.id, { email: normalised });
    return created;
  }

  audit(null, 'login.rejected_not_invited', 'user', null, { email: normalised });
  return null;
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
