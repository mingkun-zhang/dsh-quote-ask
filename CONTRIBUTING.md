# Contributing

Thanks for taking a look. This is a small, build-free DSH plugin; the most useful
contributions are bug reports with reproducible steps and focused PRs.

## Development setup

1. Install [DeepSeek Harness Desktop](https://github.com/deepseek-ai/deepseek-harness).
2. Clone this repository somewhere stable (the DSH profile links to that folder,
   so avoid a temp directory you delete later).
3. Install the working copy into your desktop profile:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
   ```

4. Fully quit and relaunch DSH Desktop after changing Host/client code.

There is no bundler and no runtime dependency. `lib/` is shipped as-is.

## Tests

Run the contract test before opening a PR:

```bash
node test/verify.mjs
# or
node scripts/check.mjs
```

The test creates a temporary `DSH_HOME`; it never touches your real DSH data.

## Code style

- Plain ESM in `lib/index.js`; the client half uses DSH's hand-written
  `window.__ModuleLoader__.load({ id, factory })` format.
- Prefer small, named helpers; keep DSH-facing comments in English and
  user-facing strings in the existing locale files where practical.
- Do not add network dependencies, telemetry, or build steps without discussing
  them first.
- Keep the Host and client halves in sync: a new client RPC needs a Host route
  and a test.

## Pull requests

- Keep the diff focused; separate refactors from behavior changes.
- Describe the user-visible effect and the DSH version/platform you tested on.
- Include a test for cleanup, context, or anchor changes — those are the
  regression-prone areas.
- Screenshots are welcome for UI changes.

## Reporting bugs

Please include:

- DSH Desktop version and OS;
- what you selected / asked, and what happened;
- any error toast text (for example `invalid-body`);
- whether it reproduces after a full DSH restart.

Do not paste private conversation content unless it is necessary; trim it first.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md).
