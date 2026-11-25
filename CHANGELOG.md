# Changelog

All notable changes to Cictus are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Community files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`
  (Contributor Covenant v2.1), `SECURITY.md`, issue and pull-request
  templates, Dependabot for npm and GitHub Actions updates.
- README: fixed the stale intro (now lists all five sources), added CI
  and release badges, a Cictus-vs-pgloader-vs-Airbyte comparison, a
  rewritten roadmap, and an FAQ.

## [0.1.0] - 2026-11-23

First release.

### Added

- **Migration wizard** — six steps: connect source, connect target,
  discover & select, type mapping, migrate, validate & report, with
  live progress streamed over SSE.
- **Five migration sources:** SQL Server, MySQL, PostgreSQL, Oracle
  (thin mode, no Instant Client), SQLite (file upload or saved path).
- **Three Postgres targets:** NHost, Supabase, and any plain
  PostgreSQL 14+ server.
- **Schema discovery** — tables, columns, primary keys, foreign keys,
  indexes, views and exact row counts from the source.
- **Editable type mapping** with warnings for lossy conversions.
- **Data copy** — batched INSERTs (1,000 rows per batch,
  `ON CONFLICT DO NOTHING`, re-runs are safe) plus `COPY` bulk load
  for tables with 5,000+ rows, with automatic fallback to batched
  INSERTs.
- **Foreign keys after data** — FKs are created once rows are in
  place, so copy order and orphaned source rows cannot lose data.
- **View conversion** — best-effort, rule-based conversion of T-SQL
  and MySQL view definitions to Postgres.
- **Scheduled / recurring migrations** — cron schedules saved per
  source → target pair, ticking every minute while the server runs.
- **Hasura auto-track** — created tables and views are tracked via
  the Hasura Metadata API after migration to NHost (or any Postgres
  with a Hasura endpoint).
- **Saved connectors** — named source and target connections, stored
  only on the machine running the app.
- **Local DuckDB history** — every run recorded (runs, per-table
  validation, errors) and shown on the Dashboard and History pages.
- **Downloadable SQL** — the full migration script as a `.sql` file,
  without executing anything.
- **Enterprise UI** — collapsible sidebar, dashboard with run stats,
  brand icons for each provider, Inter + JetBrains Mono typography.

### Known limitations

See the [Limitations](README.md#limitations) section of the README:
tables/views/data only (no stored procedures, functions, triggers,
users/roles or Agent jobs), best-effort view conversion, no
incremental/CDC migrations, no row filtering or transforms, FKs need
clean data, and no built-in authentication yet.
