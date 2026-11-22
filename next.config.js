/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // mssql / pg are server-only; keep them out of the client bundle.
  experimental: {
    serverComponentsExternalPackages: ['mssql', 'pg', 'tedious'],
  },
};

module.exports = nextConfig;
