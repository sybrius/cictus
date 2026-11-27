/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // mssql / pg are server-only; keep them out of the client bundle.
  experimental: {
    serverComponentsExternalPackages: ['mssql', 'pg', 'tedious'],
    // Enables src/instrumentation.ts, which starts the background
    // scheduler for recurring migrations when the server starts.
    instrumentationHook: true,
  },
};

module.exports = nextConfig;
