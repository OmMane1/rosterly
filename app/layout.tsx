import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

// Self-hosted (OFL, app/fonts/Inter-OFL.txt), so `next build` never needs the network.
const inter = localFont({ src: './fonts/InterVariable-latin.woff2', variable: '--font-inter', weight: '100 900', display: 'swap' });

export const metadata: Metadata = {
  title: 'Rosterly',
  description: 'Find candidates by describing who you want in plain English.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#fafaf9',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="bg-canvas text-ink min-h-dvh font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
