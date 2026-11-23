'use client';

import { siMysql, siNhost, siPostgresql, siSqlite, siSupabase } from 'simple-icons';

/**
 * Provider brand marks for the connector buttons and cards.
 *
 * PostgreSQL, MySQL, SQLite, Supabase and NHost use their official
 * Simple Icons paths (single-colour silhouettes, drawn in the brand
 * colour). Oracle and Microsoft SQL Server were removed from
 * Simple Icons, so they are drawn as simple brand-colour glyphs
 * instead: Oracle's red "O" ring, and SQL Server's red database
 * cylinder.
 */

export type BrandType =
  | 'nhost'
  | 'supabase'
  | 'postgres'
  | 'postgres-source'
  | 'sqlserver'
  | 'mysql'
  | 'oracle'
  | 'sqlite';

interface BrandDef {
  /** Brand colour used for the mark. */
  hex: string;
  /** Simple Icons path data, when one exists for the provider. */
  path?: string;
  /** Custom glyph, for providers without a Simple Icons entry. */
  custom?: 'oracle' | 'sqlserver';
}

const BRANDS: Record<BrandType, BrandDef> = {
  nhost: { hex: `#${siNhost.hex}`, path: siNhost.path },
  supabase: { hex: `#${siSupabase.hex}`, path: siSupabase.path },
  postgres: { hex: `#${siPostgresql.hex}`, path: siPostgresql.path },
  'postgres-source': { hex: `#${siPostgresql.hex}`, path: siPostgresql.path },
  mysql: { hex: `#${siMysql.hex}`, path: siMysql.path },
  sqlite: { hex: `#${siSqlite.hex}`, path: siSqlite.path },
  oracle: { hex: '#C74634', custom: 'oracle' },
  sqlserver: { hex: '#CC2927', custom: 'sqlserver' },
};

export function brandHex(type: BrandType): string {
  return BRANDS[type].hex;
}

/** A provider's brand mark, drawn in its brand colour. */
export function BrandIcon({ type, className }: { type: BrandType; className?: string }) {
  const brand = BRANDS[type];
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      {brand.path ? (
        <path d={brand.path} fill={brand.hex} />
      ) : brand.custom === 'oracle' ? (
        <circle cx="12" cy="12" r="6.8" fill="none" stroke={brand.hex} strokeWidth="3.4" />
      ) : (
        <g fill={brand.hex}>
          <ellipse cx="12" cy="6.8" rx="6.2" ry="2.4" />
          <path d="M5.8 6.8v9.7c0 1.3 2.8 2.4 6.2 2.4s6.2-1.1 6.2-2.4V6.8c0 1.3-2.8 2.4-6.2 2.4S5.8 8.1 5.8 6.8z" />
          <path
            d="M5.8 12.2c0 1.3 2.8 2.4 6.2 2.4s6.2-1.1 6.2-2.4"
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.1"
          />
        </g>
      )}
    </svg>
  );
}
