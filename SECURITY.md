# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes       |

Only the latest release on the current major version line receives security
updates.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/jayminwest/trellis/security/advisories).

1. Go to the [Security Advisories page](https://github.com/jayminwest/trellis/security/advisories).
2. Click **"New draft security advisory"**.
3. Fill in a description of the vulnerability, including steps to reproduce if
   possible.

### Response Timeline

- **Acknowledgment:** within 48 hours of your report.
- **Initial assessment:** within 7 days.
- **Fix or mitigation:** within 30 days for confirmed vulnerabilities.

We will keep you informed of progress throughout the process.

## Scope

trellis audits other repositories, so its most sensitive surfaces are:

- **Credential hygiene in logs and artifacts.** trellis runs no agent and
  calls no model, but audits may execute a target repo's own tooling commands.
  The pino logger redacts sensitive keys (`token`, `api_key`, `password`,
  `secret`, `authorization`, `set-cookie`); report any path that leaks a
  credential or secret into logs, the SQLite store, or a rendered report.
- **Reading untrusted repositories.** `trellis audit`/`drift` read arbitrary
  target repos and their configs. Report any path traversal, command injection
  via repo contents, or unsafe execution of code from an audited repo.
- **The canonical `standards/` set and `targets.yaml`.** Report tampering or
  injection vectors in how canonical files or fleet targets are loaded.

trellis's full threat model will be documented here once the design stabilizes.
In the meantime, please report anything that looks like a vulnerability through
the process above and we'll triage it.
