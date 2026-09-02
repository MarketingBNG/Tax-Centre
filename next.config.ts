import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // These pull in native/large deps that must not be bundled into the server
  // build; Next must require() them at runtime instead.
  serverExternalPackages: ['exceljs', 'mammoth', 'pdf-lib'],

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
