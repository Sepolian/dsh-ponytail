# dsh-ponytail

A thin Ponytail adapter for **DeepSeek Harness 0.2.0-rc.2**. It uses Ponytail **v4.10.0** instructions and all upstream skills unchanged, with isolated session modes and a native persistent default.

## Installation

Use Node `^22.19.0 || >=24.0.0` and DSH `0.2.0-rc.2`.

### Built package

Download the `.tgz` asset from a GitHub Release, or build it below, and install it into the Web profile:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-ponytail-0.1.0-rc.1.tgz
dsh --profile web
```

Tarball installation requires no source checkout or package build scripts. It may download runtime dependencies from your configured package registry.

## Build from source

Clone this repository and run:

```sh
npm ci
npm run typecheck
npm test
npm pack
```

`npm ci` and `npm pack` run the same self-contained `prepare` build. No sibling upstream checkout is required. The package is marked `private` to disable npm registry publication; Git installs and tarball distribution still work.

## Commands

| Command | Effect |
|---|---|
| `/ponytail` | Show effective mode, session override, and persistent default |
| `/ponytail lite`, `full`, `ultra`, or `off` | Set only this session's mode |
| `/ponytail default` | Clear this session's override and follow the default |
| `/ponytail default lite`, `full`, `ultra`, or `off` | Save the shared default durably; overrides stay intact |
| `/ponytail status` | Same read-only status query |
| `/ponytail-review [notes]` | Run the upstream one-shot review skill |
| `/ponytail-audit [notes]` | Run the upstream whole-repository audit skill |
| `/ponytail-debt [notes]` | Run the upstream shortcut-ledger skill |
| `/ponytail-gain [notes]` | Show the upstream measured-impact scoreboard |
| `/ponytail-help [notes]` | Show the upstream command/skill reference |

`stop ponytail` and `normal mode` also disable the receiving session when sent as standalone messages. A phrase inside an ordinary request does not switch mode. Help/review/audit/debt/gain are one-shot tasks and do not change the persistent mode.

The initial default is `full`. DSH stores subsequent default changes in its `ponytail` storage domain under the selected host's storage backend. Runtime overrides disappear on disposal/restart. Separate DSH homes have separate persistent defaults; processes sharing one backend should follow that backend's supported ownership rules.

Native in-process spawn/fork children take their owning parent's effective mode at child creation. Later parent changes leave the child alone. A child's `/ponytail default` clears its inherited snapshot. Children launched through external processes use that host's own default; parent override transport is not implemented.

## Compatibility

Host API peers target DSH `0.2.0-rc.2` and Cordis `~4.0.4`. The official Web/base profile supplies agents, system prompts, skills, and native storage. Custom profiles must provide those services and a durable storage-domain backend; commands activate when the native commands registry is available. Mount one adapter per storage-domain facility. The native domain does not broadcast default changes between processes.

An explicit DSH complete-prompt plugin supersedes ordinary prompt sections, including this one. Skill invocation metadata uses DSH's native filesystem parser; upstream asset bytes remain unchanged.

Runtime and package checks cover Linux with Node 22. Windows/macOS and live external model providers are untested. Rerun the checks before changing the supported DSH version or peer ranges.

## Upstream fidelity

`vendor/ponytail/` is generated from a pinned upstream Git commit. It contains the exact instruction/config modules, skill tree, and license, plus a SHA256 manifest and CommonJS package scope. Runtime startup validates it before calling the upstream renderer. No instruction text is maintained in TypeScript.

```sh
npm run check:assets
npm run sync:upstream
```

These optional upstream-maintenance commands expect the pinned Ponytail checkout at `e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156` in `../upstream/ponytail`. Updating upstream deliberately changes the pin in `scripts/sync-upstream.mjs`, regenerates assets, and reruns drift/runtime/package checks. Normal builds and Git installs use only the included vendor files. The main Ponytail skill remains user-invocable but is hidden from model invocation because its rules are already in the system prompt; the other policies use DSH's native upstream-metadata parser.

## Development

```sh
npm run typecheck
npm test
npm run benchmark
```

Tests use real DSH services and agent-loop sessions with a deterministic model transport; no API credentials are required. The benchmark prints its JSON report to stdout.

For package acceptance checks, install the official DSH CLI in the ignored runtime directory:

```sh
npm install --prefix .runtime --no-audit --no-fund @deepseek-ai/dsh@0.2.0-rc.2
npm run verify:package
```

The verifier checks isolated source preparation and pack lifecycles, archive layout and upstream hashes, a clean consumer install, missing/corrupt asset rejection, official Web profile installation and startup, session isolation, commands, skills, authenticated HTTP access, and incompatible peer rejection. It uses disposable profiles and a deterministic model transport. Reports, logs, caches, and tarballs are written under `.runtime/` and excluded from Git and package contents.

## Acknowledgements

This adapter bundles unmodified [Ponytail](https://github.com/DietrichGebert/ponytail) assets by DietrichGebert and contributors, and uses native APIs provided by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Development research drew on [WODE25500's PR #743](https://github.com/DietrichGebert/ponytail/pull/743) for upstream instruction reuse, [redtidev1918's PR #792](https://github.com/DietrichGebert/ponytail/pull/792) for packaging and native command integration, [MengYuil's adapter](https://github.com/MengYuil/dsh-ponytail/tree/9b03d3ffcff96b7e8e4ff749802b04cca23e1b51) for per-session mode state and the skill-command flow, [Wenaixi's adapter](https://github.com/Wenaixi/dsh-ponytail/tree/0cc805062e92e790d51d1758e1c6394d04e40b86) for lifecycle mapping and DSH API adaptation, and [gongyijie85's adapter](https://github.com/gongyijie85/dsh-ponytail/tree/0a837a6bc5849955dc07b4be7d40ca95e60fa459) for filesystem skill discovery.

## License

The adapter is licensed under [MIT](LICENSE). Bundled Ponytail assets retain their [upstream license and copyright notice](vendor/ponytail/LICENSE).
