# Security Policy

## Scope

`dsh-quote-ask` is a local DSH Desktop plugin. It has no network access, no
telemetry, and no credential handling. The Host half does read and delete files
under the DSH data directory, so cleanup and path-safety bugs are in scope.

## Reporting a vulnerability

Please report privately through GitHub's **Security → Report a vulnerability**
flow on this repository when available. If that is unavailable, open a minimal
issue that says you have a security report without disclosing exploit details,
and the maintainer will arrange a private channel.

Useful details:

- DSH Desktop version and OS;
- affected file/section (`lib/index.js` or `lib/client/index.js`);
- reproduction steps and impact;
- whether the issue can delete or expose data outside the quote-ask scope.

Please do not test against other people's data. The plugin is designed to be
auditable: read the two source files and [cleanup-and-compatibility.md](./docs/cleanup-and-compatibility.md)
before reporting.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | ✅ |
| < 1.0 | ❌ |

## Design boundaries

- The Host only deletes paths derived from plugin-generated UUIDs and verifies
  ownership proofs before removing a session.
- The main conversation is never written or deleted; the redaction feature only
  rewrites the side chat's derived `context.md`.
- No secrets are stored by the plugin. DSH itself may store model credentials.
