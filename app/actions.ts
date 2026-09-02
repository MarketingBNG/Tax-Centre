'use server';

import { signIn, signOut } from '@/lib/auth';

export async function googleSignIn() {
  await signIn('google', { redirectTo: '/' });
}

export async function doSignOut() {
  await signOut({ redirectTo: '/login' });
}
