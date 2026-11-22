import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SQL Server → NHost Migrator',
  description:
    'Migrate SQL Server tables, schema, data and views to NHost (Postgres / Hasura).',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
