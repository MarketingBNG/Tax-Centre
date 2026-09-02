import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tax Review Center',
  description: 'Internal AI tax review workbench',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans text-[14px] leading-[1.55] antialiased">{children}</body>
    </html>
  );
}
