/**
 * Branding, importable from client components.
 *
 * Deliberately not in lib/config.ts: that module is `server-only` and reads
 * the filesystem, so importing it from a client component fails the build.
 */
export const APP_NAME = 'Assistant';
export const APP_TAGLINE = 'Ask anything, attach anything.';
