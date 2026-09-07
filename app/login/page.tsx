import { redirect } from 'next/navigation';
import { currentUser, isAuthConfigured } from '@/lib/auth';
import { one } from '@/lib/db';
import { ALLOWED_EMAIL_DOMAIN, ADMIN_EMAILS, DISABLE_AUTH } from '@/lib/config';
import { googleSignIn } from '../actions';
import { Mark } from '@/components/Mark';
import { APP_NAME } from '@/lib/app';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  AccessDenied:
    'That Google account is not on the access list for this app. Ask an admin to add your work email first.',
  Configuration:
    'Google sign-in is not configured. AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET must be set in .env.',
  OAuthSignin: 'Could not reach Google. Check the server has internet access and try again.',
  OAuthCallback: 'Google rejected the sign-in. Check the redirect URI matches exactly.',
  Verification: 'That sign-in link has expired. Try again.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (DISABLE_AUTH) redirect('/');
  if (await currentUser()) redirect('/');

  const { error } = await searchParams;
  const configured = isAuthConfigured();

  // The very first deploy often has no database yet. Say so plainly instead
  // of returning a 500 from the one page a new visitor can reach.
  let isFirstRun = false;
  let databaseReachable = true;
  try {
    isFirstRun = Number((await one<{ c: number }>(`SELECT COUNT(*) AS c FROM users`))?.c ?? 0) === 0;
  } catch {
    databaseReachable = false;
  }

  return (
    <div className="grid h-screen place-items-center p-5">
      <div className="w-full max-w-[400px] rounded-2xl border border-line bg-panel p-6">
        <h1 className="mb-1 flex items-center gap-2.5 text-[21px] font-medium">
          <Mark size={20} />
          {APP_NAME}
        </h1>
        <p className="mb-5 text-[13.5px] text-ink-dim">
          Sign in with your work Google account to start.
        </p>

        {!databaseReachable ? (
          <div role="alert" className="rounded-lg border border-sev-blocking/35 bg-sev-blocking/10 px-3 py-2 text-[13px] text-[#e8b0b0]">
            Cannot reach the database. Set <code>DATABASE_URL</code> to a pooled Postgres
            connection string (Vercel → Storage → Postgres, or neon.tech) and redeploy.
          </div>
        ) : !configured ? (
          <div role="alert" className="rounded-lg border border-sev-blocking/35 bg-sev-blocking/10 px-3 py-2 text-[13px] text-[#f0a9a9]">
            Google sign-in is not set up yet. Add <code>AUTH_GOOGLE_ID</code>,{' '}
            <code>AUTH_GOOGLE_SECRET</code> and <code>AUTH_SECRET</code> to <code>.env</code>,
            then restart. The steps are in that file.
          </div>
        ) : (
          <form action={googleSignIn}>
            <button
              type="submit"
              className="flex w-full items-center justify-center gap-3 rounded-[9px] border border-line bg-raised px-4 py-2.5 font-medium hover:bg-raised-hover"
            >
              {/* Google's mark, inline so the page needs no external asset. */}
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
                <path
                  fill="#EA4335"
                  d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.1 0 24 0 14.6 0 6.4 5.4 2.5 13.3l7.8 6c1.9-5.6 7.2-9.8 13.7-9.8z"
                />
                <path
                  fill="#4285F4"
                  d="M46.1 24.6c0-1.6-.1-2.8-.4-4.1H24v8.4h12.5c-.3 2.1-1.6 5.2-4.6 7.3l7.6 5.9c4.5-4.2 6.6-10.2 6.6-17.5z"
                />
                <path
                  fill="#FBBC05"
                  d="M10.3 28.7A14.7 14.7 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.8-6A23.9 23.9 0 0 0 0 24c0 3.9.9 7.5 2.5 10.7l7.8-6z"
                />
                <path
                  fill="#34A853"
                  d="M24 48c6.5 0 11.9-2.1 15.5-5.8l-7.6-5.9c-2 1.4-4.7 2.4-7.9 2.4-6.5 0-11.8-4.2-13.7-9.8l-7.8 6C6.4 42.6 14.6 48 24 48z"
                />
              </svg>
              Continue with Google
            </button>
          </form>
        )}

        {error ? (
          <div className="mt-3 text-[13px] text-[#f0a9a9]">
            {ERRORS[error] ?? `Sign-in failed (${error}).`}
          </div>
        ) : null}

{configured && isFirstRun && ADMIN_EMAILS.length === 0 ? (
          <div className="mt-4 rounded-lg border border-sev-math/35 bg-sev-math/10 px-3 py-2 text-[12.5px] text-[#dcc79a]">
            No admins are configured yet, so nobody can sign in. Add your team&apos;s
            addresses to <code>ADMIN_EMAILS</code> in <code>.env</code> and restart.
          </div>
        ) : null}

        {configured && ADMIN_EMAILS.length > 0 ? (
          <p className="mt-4 text-[12.5px] text-ink-faint">
            Access is by invitation
            {ALLOWED_EMAIL_DOMAIN ? `, and limited to @${ALLOWED_EMAIL_DOMAIN} addresses` : ''}.
            Admins can sign in directly; everyone else needs to be added by one first.
          </p>
        ) : null}
      </div>
    </div>
  );
}
