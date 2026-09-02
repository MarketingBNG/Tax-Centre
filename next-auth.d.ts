import type { Role } from '@/lib/types';

// NextAuth's Session carries only name/email/image by default. The id and role
// come from our own users table via the jwt/session callbacks, so they have to
// be declared here to be visible to TypeScript.
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: Role;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    appUserId?: string;
    appRole?: Role;
  }
}
