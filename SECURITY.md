# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅ Current development release |

Cictus is a young project with a single major line so far. Security
fixes go into the current release line; there is no long-term-support
branch yet.

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.**

Use GitHub's private vulnerability reporting for this repository:
**Security tab → Report a vulnerability**. That opens a private
advisory visible only to you and the maintainers. If private reporting
is unavailable, contact the maintainers through GitHub instead.

Please include, where you can:

- What the vulnerability is and where it lives (file / route / input)
- Steps to reproduce it, or a minimal proof of concept
- What an attacker could do with it (read data? run SQL? reach a
  credential?)

We will acknowledge the report, assess it, and fix it before disclosing
anything publicly. Please give us a reasonable window to do that.

## What to know about this app's security posture

- **No built-in auth.** Run Cictus on localhost or behind your own
  authentication. It holds database credentials in memory for the
  duration of a request, so do not expose it publicly without adding
  authentication (opt-in auth is on the roadmap).
- **Credentials stay local.** Saved connector passwords are stored
  only on the machine running the app (`data/connectors.json`,
  git-ignored) and are never sent back to the browser. Never paste
  connection strings or passwords into issues, PRs, or discussions.
- **Inputs are validated.** All API inputs are validated with `zod`;
  table identifiers are allow-list validated before being interpolated
  into SQL.
- **Dependencies.** Dependabot is enabled for npm (and GitHub Actions)
  updates; please keep PRs that bump dependencies small and reviewable.
