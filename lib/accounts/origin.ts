import 'server-only';

/**
 * The base URL an OAuth provider must redirect back to.
 *
 * It has to match what is registered with the provider byte for byte, so
 * AUTH_URL wins where it is set: behind a proxy the request URL is the internal
 * one, and a redirect_uri built from it would be rejected.
 */
export function originFor(req: Request): string {
  const configured = (process.env.AUTH_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');

  const forwardedHost = req.headers.get('x-forwarded-host');
  const forwardedProto = req.headers.get('x-forwarded-proto') ?? 'https';
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`;

  return new URL(req.url).origin;
}

export const redirectUriFor = (req: Request, providerId: string): string =>
  `${originFor(req)}/api/accounts/${providerId}/callback`;
