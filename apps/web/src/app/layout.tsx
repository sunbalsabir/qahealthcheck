import type { Metadata, Viewport } from 'next';
import { BRAND } from '@qualovix/shared';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: `${BRAND.productName} — Free QA Health Check`,
    template: `%s | ${BRAND.productName}`,
  },
  description:
    "Enter your website URL and we'll automatically analyze common quality, usability, accessibility, performance, and technical issues — reviewed by Qualovix QA engineers.",
  applicationName: BRAND.productName,
  robots: { index: true, follow: true },
  openGraph: {
    title: `${BRAND.productName} — Free QA Health Check`,
    description: BRAND.positioning,
    type: 'website',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0284c7',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-white antialiased">
        {/* A skip link is the first thing our own accessibility scanner
            would look for, so the product had better have one. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-white"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
