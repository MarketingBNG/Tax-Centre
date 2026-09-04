import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // These pull in native/large deps that must not be bundled into the server
  // build; Next must require() them at runtime instead.
  serverExternalPackages: ['exceljs', 'mammoth', 'pdf-lib'],

  // The review engine falls back to the skill folder in the repo when the
  // database has no firm copy installed. Nothing imports those markdown files,
  // so tracing cannot infer them and a deploy would ship without them — the
  // fallback would then be missing on exactly the fresh deploy it exists for.
  outputFileTracingIncludes: {
    '/api/**': ['./Skills/**/*.md'],
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
