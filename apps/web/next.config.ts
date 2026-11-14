import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, so Next compiles them directly.
  transpilePackages: [
    '@qualovix/shared',
    '@qualovix/audit-engine',
    '@qualovix/scanners',
    '@qualovix/reporting',
    '@qualovix/data',
  ],
  serverExternalPackages: [
    'playwright',
    'playwright-core',
    '@axe-core/playwright',
    '@prisma/client',
    'bullmq',
    'ioredis',
    '@react-pdf/renderer',
  ],
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // The auditor checks other sites for these; it must set them itself.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Next's dev overlay and runtime need inline styles/scripts.
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com data:",
              "img-src 'self' data: blob:",
              "connect-src 'self'",
              "frame-ancestors 'self'",
              "form-action 'self'",
              "base-uri 'self'",
              "object-src 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default config;
