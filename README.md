# Cictus — SQL Server, MySQL, PostgreSQL, Oracle & SQLite → Postgres Migrator

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-14-black.svg)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](https://www.typescriptlang.org/)
[![Postgres](https://img.shields.io/badge/Postgres-16-blue.svg)](https://www.postgresql.org/)
[![CI](https://github.com/sybrius/cictus/actions/workflows/ci.yml/badge.svg)](https://github.com/sybrius/cictus/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/sybrius/cictus)](https://github.com/sybrius/cictus/releases)

**Cictus** is an open-source web app that migrates database tables, schema,
data and views from **SQL Server, MySQL, PostgreSQL, Oracle or SQLite**
to **PostgreSQL** — NHost, Supabase, or any plain Postgres server. It is
built for teams moving an existing application database to Postgres
without hand-writing the DDL: point it at a source, pick tables and
views, review the type mapping, and migrate with live progress,
per-table validation, and a full run history.

- **Sources:** SQL Server, MySQL, PostgreSQL, Oracle, SQLite (file)
- **Targets:** NHost (Hasura), Supabase, generic PostgreSQL
- **Stack:** Next.js 14 (App Router), TypeScript, Tailwind, `mssql`,
  `mysql2`, `pg`, `oracledb`, `node:sqlite`, DuckDB for local run history

## Features

- **6-step migration wizard** — connect source → connect target →
  discover & select → type mapping → migrate → validate & report.
- **Schema discovery** — tables, columns, primary keys, foreign keys,
  indexes, views and row counts, straight from the source's
  `INFORMATION_SCHEMA`.
- **Editable type mapping** — every column's Postgres type is shown with
  warnings for lossy conversions, and can be overridden inline before
  anything is created.
- **Batched data copy** — 1,000 rows per batch, one transaction per batch,
  `ON CONFLICT DO NOTHING` (re-runs are safe), with per-table progress
  streamed over SSE. A failed table is reported and skipped; the run
  continues with the next table.
- **COPY bulk load** — tables with 5,000+ rows are loaded with
  `COPY ... FROM STDIN` into a staging table, then
  `INSERT ... SELECT ... ON CONFLICT DO NOTHING` into the target, so
  large tables transfer at COPY speed while re-runs stay safe. Tables
  with geography/geometry columns, and any table whose COPY fails, fall
  back to the batched INSERT path automatically.
- **Scheduled / recurring migrations** — save a source → target pair,
  a table/view selection and a cron expression on the Schedules page;
  the server ticks every minute and runs each due schedule with the
  same engine as a manual run. A run that comes due while the server
  is off fires once when it starts again. Scheduled runs show in
  History with a "Scheduled" badge and the schedule's name.
- **Foreign keys after data** — FKs are added once all rows are in place,
  so copy order and orphaned rows in the source cannot lose data. A FK
  that still fails is reported by constraint name, with the data already
  copied.
- **View conversion** — best-effort, rule-based conversion of T-SQL and
  MySQL view definitions to Postgres, with notes on anything that needs
  review (see [View conversion](#view-conversion)).
- **Hasura auto-track** — after a migration to NHost (or any Postgres
  with a Hasura endpoint), created tables and successfully-created
  views are tracked via the Hasura Metadata API (`pg_track_table`) so
  they appear in the GraphQL API without a manual step in the Hasura
  console. Tables that are already tracked are reported, not treated
  as errors, and tracking never fails the run. Enable it per-run in
  the wizard (Step 4) or per-schedule; it needs the Hasura admin
  secret saved on the target connector (never sent to the browser).
  See [Hasura auto-track](#hasura-auto-track).
- **Saved connectors** — named, reusable source and target connections.
  Passwords are stored only on the machine running the app
  (`data/connectors.json`, git-ignored) and are never sent back to the
  browser; the wizard sends only the connector id and the server
  resolves the credentials.
- **Local DuckDB history** — every run is recorded in
  `data/migrations.duckdb` (runs, per-table validation, errors) and shown
  on the Dashboard and History pages. No server, no credentials — just
  results.
- **Downloadable SQL** — generate the full migration script as a `.sql`
  file and review or run it yourself, without executing anything.

## Supported sources & targets

| | Details |
|---|---|
| **Sources** | SQL Server (2016+), MySQL 8 / MariaDB 10.5+, PostgreSQL 14+, Oracle 19c+ (thin mode, no Instant Client), SQLite 3 (file) |
| **Targets** | NHost Postgres, Supabase Postgres, any PostgreSQL 14+ |

### Source notes

| Source | Notes |
|---|---|
| SQL Server | `dbo` maps to Postgres `public`. Named instances resolve via the SQL Browser (UDP 1434). Identity columns become `GENERATED BY DEFAULT AS IDENTITY`. |
| MySQL | The selected database maps to Postgres `public` (MySQL has no schemas). `tinyint(1)` maps to `boolean`; `int unsigned` maps to `bigint`; `bigint unsigned` maps to `numeric(20)`. `AUTO_INCREMENT` becomes identity. `DATETIME` (no timezone) maps to `timestamp`; `TIMESTAMP` maps to `timestamptz`. `ENUM`/`SET` map to `text` with a warning. Row counts are exact `COUNT(*)` — `information_schema.TABLE_ROWS` is only an InnoDB estimate and is not used. |
| PostgreSQL | Same-engine migration (e.g. an on-prem Postgres → NHost/Supabase). Introspection uses `information_schema` + `pg_catalog` for indexes. `serial`/`identity` columns are re-created as identity columns — `nextval(...)` defaults are dropped, since Postgres forbids a DEFAULT on an identity column. Arrays map element-wise (`integer[]`, `text[]`). Custom enum types map to `text` with a warning. |
| Oracle | Connects in thin mode — no Oracle Instant Client needed. Introspected scope is the tables owned by the connecting user (`OWNER = <user>`). `NUMBER(p, 0)` maps by precision (≤4 → `smallint`, ≤9 → `integer`, ≤18 → `bigint`, larger → `numeric`); `NUMBER` with no precision maps to `numeric`. `VARCHAR2`/`NVARCHAR2` → `varchar`, `CLOB` → `text`, `DATE` → `timestamp`, `TIMESTAMP WITH TIME ZONE` → `timestamptz`, `RAW`/`BLOB` → `bytea`. `ROWID`/`BFILE`/`SDO_GEOMETRY` need manual review. NUMBERs are fetched as strings so 38-digit precision is not lost. |
| SQLite | Upload a `.sqlite` / `.sqlite3` / `.db` file in the wizard (or save a file path on a connector). The file is opened read-only; the database maps to Postgres `public`. Types follow SQLite affinity rules on the declared type (`VARCHAR(255)` → `varchar(255)`, `DECIMAL(10,2)` → `numeric(10,2)`, `BOOLEAN` → `boolean`, `DATETIME` → `timestamp`). An `INTEGER PRIMARY KEY` column is the rowid alias and becomes an identity column. |

### Target notes

| Target | Connection | After migration |
|---|---|---|
| NHost | Dashboard → Database → Connection string (enable public access first): `postgres://postgres:…@<subdomain>.db.<region>.nhost.run:5432/postgres` | Track tables in Hasura (Dashboard → Hasura → Data) |
| Supabase | Project Settings → Database → Connection string, direct (port 5432): `db.<project-ref>.supabase.co`, user `postgres`, database `postgres` | Tables appear in the Table Editor; check RLS policies before exposing via the API |
| PostgreSQL | Any Postgres host/port/database/user/password | Nothing extra |

Use the direct 5432 connection (not the 6543 pooler) for DDL and bulk loads.

## How Cictus compares

Cictus is new — first release November 2026, single maintainer — so here
is an honest comparison with the established options (star counts as of
November 2026).

| | Cictus | pgloader | Airbyte |
|---|---|---|---|
| Approach | Visual 6-step wizard + API | Single-command CLI | Full ELT platform |
| Sources | SQL Server, MySQL, Postgres, Oracle, SQLite | MySQL, Postgres, SQLite, SQL Server, CSV and more | 700+ connectors |
| Targets | Postgres (NHost, Supabase, plain) | Postgres | Postgres, warehouses, data lakes |
| Scheduling | Built-in cron schedules | External (cron / systemd) | Built-in |
| Bulk load | `COPY` for 5,000+ rows | `COPY`-based | Batch |
| Hasura auto-track | Yes | No | No |
| Self-host | `npm run dev` (Docker image planned) | Binary / Docker | Docker / Cloud |
| License | MIT | PostgreSQL licence | ELv2 |
| Maturity | New, single maintainer | Established since 2010 (6,563 stars) | Company-backed (22,422 stars) |

If you need a scriptable one-command migration today, pgloader is the
established choice. If you need hundreds of connectors and a hosted
platform, Airbyte. Cictus fits when you want a visual,
review-before-you-migrate flow to Postgres, with scheduling and Hasura
auto-track built in.

## Quick start

```bash
git clone https://github.com/sybrius/cictus.git
cd cictus
npm install
cp .env.example .env.local   # fill in your own values; never commit .env.local
npm run dev                  # http://localhost:3000
```

Production build:

```bash
npm run build
npm start
```

Requirements: Node.js 20+ and npm. No database server is needed to run
the app itself — it connects to your source and target databases over the
network.

## Usage

1. **Connectors (optional)** — save a SQL Server or MySQL source and an
   NHost / Supabase / PostgreSQL target once, then pick them in the
   wizard instead of re-typing credentials.
2. **New migration** — the wizard walks through source → target →
   discover & select → type mapping → migrate → validate.
3. **History** — every run, with per-table row counts and errors.
4. **Dashboard** — totals across runs, recent migrations, connector status.

### The wizard in detail

1. **Connect source** — pick a saved SQL Server / MySQL connector or
   connect manually. **Test connection** verifies the login;
   **Diagnose (DNS + port)** tells you whether a failure is DNS, TCP,
   or login/TLS, without logging in.
2. **Connect target** — pick a saved NHost / Supabase / PostgreSQL
   connector or paste a connection string manually.
3. **Discover & Select** — introspects the source; pick tables and views,
   with row counts and no-PK flags (tables without a primary key cannot
   be tracked in Hasura until one is added).
4. **Type Mapping** — editable source → Postgres type map with warnings
   for lossy conversions.
5. **Migrate** — schema (tables → indexes) → data in 1,000-row batches →
   foreign keys → views → live log + progress, streamed over SSE.
6. **Validate & Report** — source vs target row counts, error list, and a
   downloadable `.sql` script of the generated DDL.

## Configuration

| Variable | Purpose |
|---|---|
| `SQLSERVER_HOST` / `SQLSERVER_PORT` / `SQLSERVER_USER` / `SQLSERVER_PASSWORD` / `SQLSERVER_DATABASE` | Source SQL Server. The wizard collects these in the UI; the env vars are only defaults/documentation. |
| `SQLSERVER_TRUST_CERT` | `true` if the server uses a self-signed certificate. |
| `SQLSERVER_ENCRYPT` | `true` by default; set `false` for a local server if the test fails with "Could not connect (sequence)". |
| `SQLSERVER_INSTANCE` | Optional named instance (e.g. `SQLEXPRESS`). |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | Source MySQL. Port defaults to 3306. |
| `MYSQL_SSL` | `true` only if the MySQL server requires TLS. |
| `PG_SOURCE_URL` | Source PostgreSQL connection string (for a Postgres → Postgres migration). |
| `ORACLE_HOST` / `ORACLE_PORT` / `ORACLE_SERVICE` / `ORACLE_USER` / `ORACLE_PASSWORD` | Source Oracle. Port defaults to 1521; service is the service name (not a SID). |
| `NHOST_POSTGRES_URL` | Full Postgres connection string from the NHost Dashboard → Database. Use the direct (non-pooled) string for DDL. |
| `NHOST_SUBDOMAIN` / `NHOST_REGION` | Your NHost project identifiers (display / Hasura links). |
| `NHOST_ADMIN_SECRET` | Hasura admin secret — server-side only, used by the Hasura auto-track step (and the "Test Hasura" button) when the secret is saved on the target connector. Never expose it to the browser. |

**Credentials are never hardcoded and never stored server-side beyond the
request that uses them** (except saved connectors, which live only in the
local, git-ignored `data/connectors.json`). Each API route opens its own
pool and closes it afterwards.

## How migration works

- **Schema discovery** — SQL Server: `INFORMATION_SCHEMA` + `sys.*`,
  row counts from `sys.partitions`. MySQL: `INFORMATION_SCHEMA`
  (columns, key usage, referential constraints, statistics, views) with
  exact `COUNT(*)` per table. PostgreSQL: `information_schema` +
  `pg_catalog` (indexes via `pg_index`; expression indexes are skipped
  with a note) with exact `COUNT(*)` per table. Oracle: `ALL_TAB_COLUMNS`
  / `ALL_CONSTRAINTS` / `ALL_INDEXES` / `ALL_VIEWS`, scoped to the
  connecting user's tables, with exact `COUNT(*)` per table. SQLite:
  `sqlite_master` + `PRAGMA table_info` / `foreign_key_list` /
  `index_list` / `index_info`, with exact `COUNT(*)` per table.
- **Type mapping** (`src/lib/type-map.ts`) — SQL Server: `int` →
  `integer`, `bigint` → `bigint`, `decimal(p,s)` → `numeric(p,s)`,
  `nvarchar(max)` → `text`, `datetime2` → `timestamptz`, `bit` →
  `boolean`, `uniqueidentifier` → `uuid`, `varbinary` → `bytea`,
  `xml` → `xml`. MySQL: `tinyint(1)` → `boolean`,
  `int unsigned` → `bigint`, `decimal(p,s)` → `numeric(p,s)`,
  `varchar(n)` → `varchar(n)`, `datetime` → `timestamp`,
  `timestamp` → `timestamptz`, `json` → `jsonb`, `enum`/`set` → `text`.
  PostgreSQL: types are mostly normalised (`character varying` →
  `varchar(n)`, `timestamp with time zone` → `timestamptz`, arrays
  element-wise); custom types map to `text` with a warning, except
  PostGIS `geography`/`geometry`, which pass through. Oracle:
  `NUMBER(p, 0)` by precision (see Source notes), `VARCHAR2` →
  `varchar`, `CLOB` → `text`, `DATE` → `timestamp`, `BLOB` → `bytea`.
  SQLite: declared-type affinity (`VARCHAR(255)` → `varchar(255)`,
  `DECIMAL(10,2)` → `numeric(10,2)`, `BOOLEAN` → `boolean`,
  `DATETIME` → `timestamp`, bare/unknown → `bytea`).
  Lossy types carry warnings: `money` → `numeric(19,4)`,
  `datetimeoffset` loses the original offset text, `sql_variant` /
  `hierarchyid` / `rowversion` need manual review.
- **DDL** (`src/lib/ddl.ts`) — `CREATE TABLE` with PK,
  `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`, `CREATE INDEX`, and
  `CREATE OR REPLACE VIEW`. Identity / `AUTO_INCREMENT` columns become
  `GENERATED BY DEFAULT AS IDENTITY` and their sequences are re-seeded
  past the max value after the data load.
- **Data copy** (`src/lib/migrate-data.ts`) — 1,000 rows per batch, one
  transaction per batch, `ON CONFLICT DO NOTHING`, explicit identity
  values, `bit` 0/1 → boolean coercion, MySQL `BIT(1)` buffers →
  boolean, invalid dates → `NULL`, objects → `jsonb`. A failed batch is
  reported and the table is marked failed; other tables continue. A
  dropped source connection retries the table once. Tables with 5,000+
  rows use the COPY bulk load instead (see Features): rows are streamed
  into a same-shape TEMP staging table with `COPY ... FROM STDIN`
  (tab-delimited text format, `\N` for NULL), then moved into the
  target with `INSERT ... SELECT ... ON CONFLICT DO NOTHING`, so the
  transfer is fast and re-runs stay idempotent. Spatial columns stay
  on the INSERT path, and a COPY failure falls back to INSERT.
- **Scheduled migrations** (`src/lib/scheduler.ts`, `src/lib/cron.ts`) —
  schedules live in the DuckDB store (`schedules` table) and are
  created on the Schedules page from saved connectors. The scheduler
  starts with the server (`src/instrumentation.ts`, tick every minute)
  and runs due schedules through the same `executeMigration()` engine
  as the wizard (`src/lib/run-migration.ts`). Cron is the standard
  5-field form (`minute hour day-of-month month day-of-week`, with
  `*/n`, lists, ranges and month/weekday names) in the server's local
  time; `next_run_at` is advanced before a run starts so a long run
  or a restart never double-fires a slot. Runs are recorded in
  History with `trigger: 'schedule'` and the schedule's name.
- **Hasura auto-track** (`src/lib/hasura.ts`) — after validation, when
  enabled, the engine calls the Hasura Metadata API (`POST
  /v1/metadata`, `pg_track_table`) for every table created in the run
  and every view created successfully. The endpoint is derived from
  the target connector: NHost → `https://<subdomain>.hasura.<region>.nhost.run`,
  any other Postgres → the saved Hasura endpoint. The admin secret
  comes from the connector (never the browser) and is sent only as the
  `x-hasura-admin-secret` header. A table that is already tracked
  (`already-tracked` 400) is reported as such, not as a failure, and
  tracking never fails the run. The summary (tracked / already-tracked
  / failed) shows in Step 6 and in History. Supabase targets have no
  Hasura, so the option is not offered for them.
- **Validation** — row count per table, source vs target, shown in Step 6
  and recorded in the DuckDB history.

### View conversion

View conversion is best-effort and rule-based — review converted views
before relying on them. Anything unrecognised is kept in a note, and a
failed view logs its converted SQL so the exact problem can be diagnosed.

| Source | Handled |
|---|---|
| T-SQL | `TOP n` → `LIMIT n`, `GETDATE()` / `SYSUTCDATETIME()` → `now()`, `ISNULL` → `COALESCE`, `CONVERT(type, expr, style)` → `CAST`, `DATEADD` → `+ INTERVAL`, `N'…'` → `'…'`, `[brackets]` → `"quotes"`, `dbo.` → `public.`, `WITH (NOLOCK)` and other table hints stripped, leading CTEs preserved. `+` string concatenation is flagged (`\|\|` in Postgres). |
| MySQL | `` `backticks` `` → `"quotes"`, `` `db`.`table` `` → `"public"."table"`, `IFNULL` → `COALESCE`, `IF(a, b, c)` → `CASE WHEN`, `DATE_ADD` / `DATE_SUB` → `+/- INTERVAL`, `LOCATE(a, b)` → `STRPOS(b, a)`, `ISNULL(x)` → `(x IS NULL)`, `NOW()` → `now()`, `CURDATE()` → `CURRENT_DATE`, `UNIX_TIMESTAMP(x)` → `extract(epoch from x)`, `UUID()` → `gen_random_uuid()`. `CONCAT()` works as-is in Postgres. |
| PostgreSQL | Source views are already valid Postgres (`pg_get_viewdef`), so only the shared identifier-quoting steps run — no dialect rewrites. |
| Oracle | `NVL` → `COALESCE`, `SYSDATE` / `SYSTIMESTAMP` → `now()`, `TO_DATE(x, fmt)` → `CAST(x AS timestamp)` (the format string is dropped — check it), `FROM DUAL` dropped, owner prefix → `"public".`, `VARCHAR2(` / `NUMBER(` in casts → `varchar(` / `numeric(`. `TO_CHAR`, `DECODE`, `ROWNUM` and `CONNECT BY` are flagged for review — they have no direct Postgres equivalent. |
| SQLite | `date('now')` → `CURRENT_DATE`, `datetime('now')` → `now()`, `time('now')` → `CURRENT_TIME`, common `strftime('%Y-%m-%d', x)` patterns → `to_char(x, 'YYYY-MM-DD')` (other patterns are flagged). |

Identifiers keep their exact case: Postgres folds unquoted names to
lowercase, but the tables and columns are created quoted (`"CallLog"`,
`"WorkerId"`), so view references are quoted with the exact
table/column names from the introspected schema.

## Local DuckDB history

Every migration run is recorded in `data/migrations.duckdb` (tables
`migrations`, `migration_tables`, `migration_errors`) — no server, no
credentials, just results. Query it directly, e.g. with the DuckDB CLI:

```sql
SELECT started_at, source_name, target_name, target_type, rows_copied, errors_count
FROM migrations ORDER BY started_at DESC;
```

The `data/` directory is git-ignored: the DuckDB file and
`data/connectors.json` live only on the machine that runs the app.

One DuckDB file can only be opened by one instance at a time, so the
instance is kept as a process-wide singleton (`globalThis`) — in Next.js
dev mode each route gets its own copy of a module, and a module-level
singleton was opened twice, which failed with a file-lock error.

## NHost notes

- Find the Postgres connection string in the NHost Dashboard → your project
  → **Database**. The app connects with SSL (`rejectUnauthorized: false`,
  matching NHost's public endpoint).
- **`geography` / `geometry` columns need PostGIS.** NHost Postgres does not
  enable it by default: enable it in the NHost dashboard (Database →
  Extensions) *before* migrating tables that use those types, or those
  columns will fail. The target connection test reports whether PostGIS is
  enabled.
- **After migration, track the tables in Hasura** — the wizard can do
  this automatically (Step 4, "Track tables in Hasura after
  migration") when the target connector has the Hasura admin secret
  saved; see [Hasura auto-track](#hasura-auto-track). Or track
  manually in the NHost Dashboard → Hasura → Data → Track. Tables
  without a primary key cannot be tracked — add a PK or a unique
  constraint first. The wizard flags no-PK tables in Step 3.
- **Hasura permissions:** after tracking, set table permissions in Hasura
  (or NHost Auth roles) — migration only creates the tables, it does not
  grant GraphQL access.
- **Large databases:** data copy streams from the source in batches, but
  the SSE request stays open for the whole run. For very large tables,
  migrate in smaller selections (a few tables per run) or run the
  generated `.sql` + a bulk loader (`COPY`) instead.

## Hasura auto-track

After a migration, tables only appear in the GraphQL API once Hasura
tracks them. The app can do that step for you, right after the data
copy validates:

1. **Save the admin secret on the target connector** — on the
   Connectors page, an NHost or plain-Postgres target has a "Hasura
   auto-track (optional)" box: paste the Hasura admin secret. For
   NHost the endpoint is derived automatically
   (`https://<subdomain>.hasura.<region>.nhost.run`); for a plain
   Postgres target, paste the Hasura endpoint too. The secret is
   stored only in the local `data/connectors.json` and is never sent
   to the browser (the API only reports whether one is saved).
   "Test Hasura" on the connector card checks the endpoint + secret
   with an `export_metadata` call.
2. **Enable it for the run** — Step 4 of the wizard shows a "Track
   tables in Hasura after migration" checkbox when the target can do
   it (it is on by default when a secret is saved). Schedules have
   the same checkbox, so recurring runs track new tables too.
3. **Result** — Step 6 reports tracked / already-tracked / failed
   tables. Tracking never fails the run: if Hasura is unreachable or
   rejects a table, the migration still completes and the failure is
   listed.

Notes:

- Only tables created in that run and views created successfully are
  tracked. A table that already exists in the target is not re-tracked.
- NHost is rolling out Constellation (its own GraphQL engine) alongside
  Hasura; Constellation does not implement the metadata HTTP API, so
  the app calls the `.hasura.` host's `/v1/metadata`, which remains
  the correct endpoint for metadata authoring.
- Supabase targets have no Hasura, so the option is not offered.
- After tracking, set table permissions in Hasura (or NHost Auth
  roles) — migration only creates the tables, it does not grant
  GraphQL access.

## Limitations

What the tool does not do, so you can plan around it:

- **Tables, views and data only.** Stored procedures, functions,
  triggers, standalone sequences, users / roles / permissions, SQL
  Server Agent jobs and SSIS packages are not migrated. Only tables
  (schema + data) and views move.
- **View conversion is best-effort, not a compiler.** Views are
  converted with rule-based rewrites per dialect (see
  [View conversion](#view-conversion)). Anything unrecognised is kept
  in a note, and a view that still fails is reported with its
  converted SQL in the log so the exact problem can be diagnosed —
  but complex constructs (CTEs with column lists, derived tables,
  dialect-specific functions) may need a manual rewrite.
- **No incremental or change-data-capture migrations.** Every run
  copies the full selected tables. Re-runs are safe (`ON CONFLICT DO
  NOTHING`), but they are not incremental — a scheduled run re-copies
  everything each time. There is no row filtering, column renaming
  or value transformation; the only per-column control is the type
  override in Step 4.
- **Foreign keys need clean data.** FKs are added after the data copy,
  so copy order cannot lose rows — but if the source has orphaned
  rows (a foreign key pointing at a parent row that does not exist),
  that FK fails and is reported by constraint name while the data
  stays copied. Clean the orphans in the source, or drop the FK in
  the target.
- **Some type mappings are lossy.** `ENUM` / `SET` become `text`
  (values are not enforced), `money`, `sql_variant`,
  `hierarchyid` and `rowversion` need manual review, Oracle
  `ROWID` / `BFILE` / `SDO_GEOMETRY` are not carried over, and
  `geography` / `geometry` columns need PostGIS enabled on the
  target before the migration or those columns fail. The wizard
  flags every lossy mapping in Step 4 — review it before running.
- **One source → one target per run.** A run migrates one source
  database into one target. There is no fan-out to several targets
  and no merging of several sources in a single run.
- **Hasura tracking has prerequisites.** Auto-track only works for
  NHost or plain-Postgres targets with a Hasura admin secret saved
  on the connector, and only for tables created in that run.
  Tables without a primary key (or a unique constraint) cannot be
  tracked at all — add one first. Supabase targets have no Hasura,
  so the option is not offered for them.
- **Schedules only run while the server runs.** This is a local tool:
  the scheduler ticks while `npm run dev` (or the production
  server) is up. A run that comes due while the server is off fires
  once when it starts again — nothing fires while the machine is off.
- **Long runs hold one request open.** The migration streams
  progress over SSE for the whole run. For very large databases,
  migrate in smaller selections (a few tables per run) or run the
  generated `.sql` plus a bulk loader instead.
- **COPY bulk load is selective.** Only tables with 5,000+ rows use
  the COPY path, and tables with `geography` / `geometry` columns
  stay on the batched INSERT path. A COPY failure falls back to
  INSERT automatically.
- **Source-specific scope.** Oracle migrates only the tables owned by
  the connecting user. SQLite migrates a file that must sit on the
  machine running the app, opened read-only. SQL Server named
  instances resolve via the SQL Browser (UDP 1434), and TCP/IP must
  be enabled on the server. MySQL row counts are exact `COUNT(*)`,
  which is slow on very large tables.
- **One history file, one process.** The DuckDB history file
  (`data/migrations.duckdb`) can only be opened by one process at a
  time — a second dev server pointed at the same folder fails with a
  file-lock error. Stop the other server (or `node.exe`) first.
- **No authentication of its own.** The app holds database
  credentials in memory for the duration of a request and stores
  saved connectors on disk, so run it on localhost or behind your
  own auth — do not expose it publicly without adding
  authentication.

## Troubleshooting

### SQL Server: `Failed to connect to QYLA:1433 - Could not connect (sequence)`

This is a pre-login handshake failure: SQL Server never completed login.
It is **not** a wrong-password error — the server is not answering on
that host:port at all, or it closes the connection during TLS setup.
Click **Diagnose (DNS + port)** in Step 1 first — it tells you whether
DNS, TCP, or login/TLS failed, without trying to log in.

Most common causes, in order, for a local server:

1. **TCP/IP is disabled.** SQL Server Express / named instances ship with
   TCP/IP off. Open **SQL Server Configuration Manager → SQL Server
   Network Configuration → Protocols for MSSQLSERVER** (or for your
   instance) → **TCP/IP → Enabled**. Then **IP Addresses → IPAll → TCP
   Port = 1433**, and **restart the SQL Server service**.
2. **It is a named instance on a dynamic port, not 1433.** If your server
   is `QYLA\SQLEXPRESS`, put `SQLEXPRESS` in the **Instance** field and
   leave Port at 1433 — the app then asks the SQL Server Browser (UDP
   1434) for the real port. Make sure the **SQL Server Browser** service
   is running. Or find the real port in Configuration Manager and use
   that port with no instance name.
3. **The service is stopped, or the firewall blocks 1433.** In PowerShell:
   ```powershell
   Test-NetConnection QYLA -Port 1433
   sqlcmd -S QYLA,1433 -U sa -Q "SELECT @@VERSION"
   Get-Service MSSQLSERVER, SQLBrowser
   ```
   `TcpTestSucceeded: False` means nothing is listening — go back to (1).
   Allow port 1433 through Windows Firewall (inbound TCP).
4. **Wrong host name.** `QYLA` is the PC name. If the app runs on that
   same PC, use `localhost` or `127.0.0.1` instead. If the app runs in
   Docker / WSL, `QYLA` will not resolve — use the PC's LAN IP address
   or `host.docker.internal`.
5. **TLS.** The test first tries encryption on, then automatically retries
   with encryption off. If the retry also fails, it is not a TLS problem.
   You can also uncheck **Use encryption (TLS)** in Step 1 for a local
   server.

### MySQL: access denied / cannot connect

- `Access denied for user` (1045) — the server answered, so the network
  is fine. Check the username/password, and that the MySQL user may
  connect from this host: a user created as `'app'@'localhost'` cannot
  log in from another machine — create it as `'app'@'%'` (or the app's
  IP) with the needed grants.
- `Unknown database` (1049) — the database name is wrong (it is
  case-sensitive on Linux).
- `Host … is not allowed to connect` (1130) — same host-privilege problem
  as 1045; see above.
- `Client does not support authentication protocol` — the user uses
  `caching_sha2_password` over a non-TLS connection. Enable SSL for the
  connector, or change the user to `mysql_native_password`.
- Nothing listening on 3306 — check that `mysqld` is running, that
  `bind-address` allows this host, and that the firewall allows 3306.

### Other errors

- `Login failed` (SQL Server) — the server answered, so the network is
  fine. Check the username/password, that SQL Server authentication
  (mixed mode) is enabled, and that the login can access the database.
- `ENOTFOUND / getaddrinfo` — the host name does not resolve from where
  the app runs; use `localhost` on the same machine, or the LAN IP /
  `host.docker.internal` from Docker / WSL.
- `IO Error: Cannot open file …\data\migrations.duckdb` — another
  `node.exe` (a stale dev server) holds the DuckDB file. End the extra
  `node.exe` in Task Manager and restart `npm run dev`.
- A view fails with `syntax error at or near …` — the failed view's
  converted SQL is printed in the dev-server log on the `View failed:`
  line; check what construct was not converted and adjust the view or
  the converter (`src/lib/ddl.ts`).

## FAQ

**Do I need a live source database to try Cictus?**
Yes — point it at a real source and a Postgres target. A bundled sample
database with a one-command demo migration is on the roadmap.

**Can Cictus migrate stored procedures, functions or triggers?**
No — tables, views and data only. See [Limitations](#limitations).

**What happens if some rows break a foreign key?**
The data stays. The FK is reported by constraint name and skipped; the
run continues. Clean the orphaned rows in the source, or drop that FK
in the target.

**Does it work with Supabase and NHost?**
Yes — both are Postgres targets. NHost also gets Hasura auto-track:
created tables and views are tracked in the GraphQL API automatically.

**Is it safe to expose the app publicly?**
No. Run it on localhost or behind your own auth — it holds database
credentials in memory for the duration of a request and has no built-in
auth yet. Opt-in auth is on the roadmap.

**How do I run a migration on a schedule?**
Use the Schedules page: pick a saved source → target pair, a table/view
selection and a cron expression. The server ticks every minute and runs
each due schedule with the same engine as a manual run; schedules only
run while the server is running.

## API routes

| Route | Purpose |
|---|---|
| `POST /api/source/test` | Test the source connection (any supported source). |
| `POST /api/source/diagnose` | DNS + TCP check for the source host/port, no login. |
| `POST /api/source/schema` | Introspect tables, columns, PKs, FKs, indexes, views, row counts. |
| `POST /api/target/test` | Test the Postgres connection (+ PostGIS check). |
| `POST /api/migrate` | Run the migration; streams progress as SSE (`text/event-stream`). |
| `POST /api/migrate/ddl` | Return the generated SQL script (no execution). |
| `GET /api/connectors` · `POST /api/connectors` · `DELETE /api/connectors` | Saved connectors (passwords never leave the server). |
| `POST /api/connectors/test` | Test a saved connector. |
| `GET /api/history` · `GET /api/history/[id]` | Migration run history from the local DuckDB store. |

## Project layout

```
src/
  app/
    page.tsx                    Dashboard
    migrate/page.tsx            6-step wizard
    connectors/page.tsx         Saved connectors
    history/page.tsx            Run history
    schedules/page.tsx          Scheduled migrations
    layout.tsx / globals.css
    api/source/test|schema|diagnose|upload/route.ts
    api/target/test/route.ts
    api/migrate/route.ts        SSE streaming migration
    api/migrate/ddl/route.ts    SQL script download
    api/connectors/route.ts     Connector CRUD
    api/connectors/test/route.ts
    api/hasura/test/route.ts    Hasura connection test
    api/history/route.ts        Run list + stats
    api/history/[id]/route.ts   Run detail
    api/schedules/route.ts      Schedule CRUD
    api/schedules/[id]/route.ts
    api/schedules/[id]/run/route.ts
    api/schedules/tick/route.ts
  components/
    ui.tsx              Shared UI kit (cards, buttons, badges)
    Sidebar.tsx         Collapsible sidebar
    Topbar.tsx          Breadcrumbs + status
    BrandIcons.tsx      Provider brand marks
    ConnectionForm.tsx  Source/target connection forms
    SchemaTree.tsx      Table/view picker with row counts
    TypeMappingTable.tsx Editable type map
    MigrationLog.tsx    Auto-scrolling log
    ProgressBar.tsx
  instrumentation.ts    Starts the scheduler (dev/server runtime)
  lib/
    type-map.ts         Source → Postgres type mapping + warnings
    sqlserver.ts        mssql pool, introspection, batched streaming
    mysql.ts            mysql2 pool, introspection, batched streaming
    postgres-source.ts  Postgres as a source
    oracle.ts           oracledb thin mode, introspection, streaming
    sqlite.ts           node:sqlite, read-only file introspection
    postgres.ts         pg Pool, connection test, transactional DDL
    ddl.ts              DDL generation + view conversion (all dialects)
    migrate-data.ts     Batched + COPY bulk load, identity-sequence fix
    run-migration.ts    Shared migration engine (manual + scheduled)
    source-dispatch.ts  Dispatch on source type
    connectors.ts       Saved connectors (local JSON store)
    resolve-connector.ts Resolve connector id / form payload + source type
    history-db.ts       DuckDB run history (globalThis singleton)
    scheduler.ts        Schedule ticking + background runs
    cron.ts             5-field cron parsing + next-run calculation
    hasura.ts           Hasura Metadata API (pg_track_table)
```

## Contributing

Contributions are welcome — bug reports, new source/target support, and
view-converter improvements especially.

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # production build
npm run dev         # dev server on http://localhost:3000
```

Guidelines:

- **Keep the source abstraction intact.** New sources go in their own
  `src/lib/<source>.ts` (config schema, test, diagnose, introspect,
  streaming) and map onto the shared `TableInfo` / `ColumnInfo` /
  `ViewInfo` shapes; the DDL generator, data copy and validation should
  not need source-specific branches beyond the type map and the view
  dialect.
- **Do not invent mappings.** A type or function with no Postgres
  equivalent gets a warning and `needsReview`, not a silent guess.
- **Verify before claiming.** Run `npm run typecheck` and
  `npm run build` before opening a PR; if you touched the view
  converter, add a unit case for the construct you changed.
- **No credentials in code, issues, or PRs.** Use `.env.local` and the
  local `data/` store; never paste connection strings or passwords.

Please open an issue first for larger changes (a new source database, a
new target, a change to the migration order) so the design can be agreed
before the code is written.

## Roadmap

Done so far:

- [x] PostgreSQL → PostgreSQL migrations (same engine, different source)
- [x] Oracle / SQLite sources
- [x] Scheduled / recurring migrations
- [x] `COPY`-based bulk load for very large tables
- [x] Hasura metadata API integration (auto-track tables after migration)

Next:

- [ ] Docker image + Compose demo (app + local Postgres target)
- [ ] Bundled sample database for a one-command demo migration
- [ ] CLI / headless mode reusing the migration engine
- [ ] Unit-test suite (Vitest) wired into CI
- [ ] Benchmarks vs pgloader on the sample dataset
- [ ] `docs/` on GitHub Pages
- [ ] Opt-in authentication for self-hosted use
- [ ] Coordinated launch: Show HN, r/PostgreSQL, awesome-postgres

## Security

- No credentials in code, no credentials stored (except saved connectors,
  local only), no credentials logged.
- All API inputs are validated with `zod`; table identifiers are
  allow-list validated before being interpolated into SQL.
- Run this app on localhost or behind your own auth — it holds database
  credentials in memory for the duration of a request, so do not expose
  it publicly without adding authentication.

## License

MIT — see [LICENSE](LICENSE).
