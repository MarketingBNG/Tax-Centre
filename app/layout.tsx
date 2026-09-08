import type { Metadata } from 'next';
import './globals.css';
import { APP_NAME, APP_TAGLINE } from '@/lib/app';
import { THEME_SCRIPT } from '@/components/theme';

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_TAGLINE,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sets the theme before first paint, so a dark-mode user never sees a
            white flash while React hydrates. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="font-sans text-[14px] leading-[1.55] antialiased">{children}</body>
    </html>
  );
}
