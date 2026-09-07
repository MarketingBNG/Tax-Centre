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

export async function createUser(input: {
  email: string;
  role: Role;
  displayName: string;
}): Promise<UserRow> {
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO users (id, email, role, display_name, is_active, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
    id,
    input.email.trim().toLowerCase(),
    input.role,
    input.displayName,
    Date.now(),
  );
  return (await getUserById(id))!;
}

const domainAllows = (email: string) =>
  !ALLOWED_EMAIL_DOMAIN || email.endsWith(`@${ALLOWED_EMAIL_DOMAIN.toLowerCase()}`);

/**
 * Creates or promotes an address listed in ADMIN_EMAILS.
 *
 * Takes the already-loaded row so the caller does not pay for a second read.
 * Idempotent, and only writes to the audit log when it actually changes
 * something.
 */
async function syncConfiguredAdmin(
  email: string,
  existing: UserRow | null,
): Promise<UserRow | null> {
  const normalised = email.trim().toLowerCase();
  if (!ADMIN_EMAILS.includes(normalised) || !domainAllows(normalised)) return null;

  if (!existing) {
    const created = await createUser({
      email: normalised,
      role: 'admin',
      displayName: normalised,
    });
    await audit(created.id, 'user.admin_from_config', 'user', created.id, { email: normalised });
    return created;
  }

  // A configured admin who was deactivated by hand stays deactivated: the list
  // grants a role, it does not override an explicit removal.
  if (!existing.is_active) return null;

  if (existing.role !== 'admin') {
    await run(`UPDATE users SET role = 'admin' WHERE id = ?`, existing.id);
    await audit(existing.id, 'user.promoted_by_config', 'user', existing.id, { email: normalised });
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
async function resolveAccess(email: string, name: string): Promise<UserRow | null> {
  const normalised = email.trim().toLowerCase();

  if (!domainAllows(normalised)) {
    await audit(null, 'login.rejected_domain', 'user', null, { email: normalised });
    return null;
  }

  const existing = await getUserByEmail(normalised);
  const fromConfig = await syncConfiguredAdmin(normalised, existing);

  if (fromConfig) {
    if (name && fromConfig.display_name === normalised) {
      await run(`UPDATE users SET display_name = ? WHERE id = ?`, name, fromConfig.id);
    }
    return fromConfig;
  }

  if (!existing) {
    await audit(null, 'login.rejected_not_invited', 'user', null, { email: normalised });
    return null;
  }
  if (!existing.is_active) {
    await audit(existing.id, 'login.rejected_inactive', 'user', existing.id, null);
    return null;
  }
  return existing;
}

/* ------------------------------------------------------------- NextAuth */

export const { handlers, signIn, signOut, auth } = NextAuth({
  // Auth.js will not infer the callback URL from the Host header in production
  // unless the deployment is declared trusted. Set AUTH_URL as well once this
  // is behind a real domain, so the header is not load-bearing at all.
  trustHost: true,

  providers: [
    Google({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      // Pre-filters to the firm's Workspace domain where one is configured.
      // A convenience, not a control — resolveAccess is what enforces it.
      authorization: ALLOWED_EMAIL_DOMAIN
        ? { params: { hd: ALLOWED_EMAIL_DOMAIN, prompt: 'select_account' } }
        : { params: { prompt: 'select_account' } },
    }),
  ],

  session: { strategy: 'jwt', maxAge: 12 * 60 * 60 },

  pages: { signIn: '/login', error: '/login' },

  callbacks: {
    async signIn({ profile }) {
      const email = profile?.email;
      if (!email) return false;
      // Google's own verification flag; an unverified address must not pass.
      if (profile?.email_verified === false) return false;
      return Boolean(await resolveAccess(email, String(profile?.name ?? '')));
    },

    async jwt({ token }) {
      if (!token.email) return token;

      // Re-read on every request rather than trusting the token: a role change
      // or a deactivation then takes effect immediately instead of waiting for
      // the JWT to expire. One read, and a write only when something changed.
      const existing = await getUserByEmail(String(token.email));
      const row = (await syncConfiguredAdmin(String(token.email), existing)) ?? existing;

      token.appUserId = row?.is_active ? row.id : undefined;
      token.appRole = row?.is_active ? row.role : undefined;
      return token;
    },

    session({ session, token }) {
      session.user.id = (token.appUserId as string) ?? '';
      session.user.role = (token.appRole as Role) ?? 'member';
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
          '  DISABLE_AUTH=true — sign-in is bypassed and every visitor is an admin.',
          '  Set it to false before this is reachable by anyone else.',
          '',
        ].join('\n'),
      );
    }
    return (
      (await getUserByEmail(PREVIEW_EMAIL)) ??
      (await createUser({
        email: PREVIEW_EMAIL,
        role: 'admin',
        displayName: 'Preview (auth disabled)',
      }))
    );
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
// The default is what the 22 admin-only routes already say. A caller with a
// better sentence — "you have no Box access to this client, ask whoever owns
// it to add you" — passes its own, because a 403 that misdescribes why sends
// somebody to a developer instead of to the person who can actually fix it.
export const forbidden = (message = 'Admins only') =>
  Response.json({ error: message }, { status: 403 });
export const notFound = () => Response.json({ error: 'Not found' }, { status: 404 });
export const badRequest = (message: string) => Response.json({ error: message }, { status: 400 });

export { audit };
