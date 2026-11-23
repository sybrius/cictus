/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // mssql / pg / DuckDB are server-only; keep them out of the client
  // bundle. DuckDB's node-api ships optional native bindings per
  // platform — webpack must not try to resolve them all.
  experimental: {
    serverComponentsExternalPackages: ['mssql', 'pg', 'tedious', '@duckdb/node-api', '@duckdb/node-bindings-linux-x64'],
  },
};

module.exports = nextConfig;
