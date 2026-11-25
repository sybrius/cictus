# Contributing to Cictus

Thanks for helping make Cictus better. Bug reports, new source/target
support, and view-converter improvements are especially welcome.

## Quick start

```bash
git clone https://github.com/sybrius/cictus.git
cd cictus
npm install
npm run typecheck   # tsc --noEmit
npm run build       # production build
npm run dev         # dev server on http://localhost:3000
```

There is no test runner in the repo yet — a Vitest suite is on the
[roadmap](README.md#roadmap). Until it lands, verify your change with
`npm run typecheck`, `npm run build`, and a manual run against a real
(or SQLite-file) source if you touched migration behaviour.

## How to contribute

- **Bug reports:** open an issue with the bug-report template — source
  database and version, target, the exact error message, and the
  relevant lines from the dev-server terminal. Redact passwords and
  connection strings.
- **Feature requests:** open an issue with the feature-request template
  first, so the design can be agreed before code is written.
- **Larger changes** (a new source database, a new target, a change to
  the migration order, anything touching the data-copy path): please
  open an issue first.
- **Small fixes** (docs, a type mapping, a view-converter rule): a PR
  straight away is fine.

## Pull requests

- Keep a PR to one concern. A focused PR gets reviewed faster than a
  bundle.
- Run `npm run typecheck` and `npm run build` before opening the PR.
- Update the README (and `CHANGELOG.md`, under Unreleased) when your
  change alters behaviour a user would notice.
- Follow the existing code style: TypeScript strict, Tailwind for
  styling, Lucide icons for UI, brand marks from
  `src/components/BrandIcons.tsx` for provider buttons.

## Guidelines

- **Keep the source abstraction intact.** New sources go in their own
  `src/lib/<source>.ts` (config schema, test, diagnose, introspect,
  streaming) and map onto the shared `TableInfo` / `ColumnInfo` /
  `ViewInfo` shapes. The DDL generator, data copy and validation
  should not need source-specific branches beyond the type map and the
  view dialect.
- **Do not invent mappings.** A type or function with no Postgres
  equivalent gets a warning and `needsReview`, not a silent guess.
- **Verify before claiming.** If you touched the view converter,
  verify the construct converts correctly with a manual run and
  describe the case in the PR; if you touched the data copy, test it
  against a real source where you can.
- **No credentials in code, issues, or PRs.** Use `.env.local` and the
  local `data/` store; never paste connection strings or passwords.
  Saved connector passwords live only on the machine running the app
  (`data/connectors.json`, git-ignored) and are never sent back to the
  browser.
- **Do not expose the app publicly** while working on it — it holds
  database credentials in memory for the duration of a request and has
  no built-in auth yet.

## Security issues

Do not open a public issue for a vulnerability. See
[SECURITY.md](SECURITY.md).

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
