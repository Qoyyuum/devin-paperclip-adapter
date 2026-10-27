# devin-paperclip-adapter

A [Paperclip](https://paperclip.ing) **external adapter** that runs the
[Devin CLI](https://docs.devin.ai) as a local process, so a Paperclip company
can hire Devin as an agent. It is designed around the free SWE-2 models
(`swe-2-high` is the default) but works with any model the operator's Devin
account can see in `devin models list`.

## How it works

Each Paperclip heartbeat runs one Devin turn:

```
heartbeat -> devin -p --prompt-file <tmp> --model <m> --permission-mode <m> [-r <sessionId>]
```

- The Devin CLI runs non-interactively (`-p`) in the agent's working directory.
- After the run, the adapter discovers the session id via
  `devin list --format json` and stores it in Paperclip `sessionParams`.
- The next heartbeat resumes the same Devin conversation with
  `-r <sessionId>` (when the cwd still matches), so the agent keeps context
  across wakes.
- If the stored session no longer exists, the adapter retries once with a
  fresh session and reports `clearSession: true`.
- All stdout is emitted as `devin.*` JSON event lines; the bundled
  `./ui-parser` renders init/status/assistant/result entries in the run
  viewer.
- An `acp` engine is also available: it drives `devin acp` over the Agent
  Client Protocol for structured thinking/tool-call/usage events in the
  transcript and session resume via `session/load`.

## Prerequisites

- **Node.js >= 24.11** on the Paperclip host.
- **Devin CLI** installed on the Paperclip host (`devin` in `PATH`).
- **`devin auth login`** completed for the OS user that runs the Paperclip
  server — the adapter inherits that user's credentials.

## Setup: connect Devin to Paperclip

### 1. Install the adapter

**From npm** (recommended):

```http
POST /api/adapters/install
{ "packageName": "devin-paperclip-adapter", "version": "1.0.0" }
```

Or pick `devin-paperclip-adapter` from the Adapter Manager UI if your
Paperclip instance browses the registry.

**From a local checkout** (development / unpublished):

```bash
git clone https://github.com/Qoyyuum/devin-paperclip-adapter.git && cd devin-paperclip-adapter
npm install && npm run build
```

```http
POST /api/adapters/install
{ "packageName": "/absolute/path/to/devin-paperclip-adapter", "isLocalPath": true }
```

Paperclip imports `dist/index.js`, so build first for local installs.

### 2. Register the adapter type

The package self-describes as adapter type **`devin_local`**. After install it
appears in the adapter list; the bundled config schema
(`getConfigSchema`) drives the agent-config form in the UI.

### 3. Verify the environment

Run the adapter's environment test (UI "Test environment" button, or the
adapter test endpoint). It checks, in order:

| Check | What it verifies |
|---|---|
| execution target | local host only — remote/SSH targets are rejected |
| `cwd` | configured working directory is absolute (missing dirs are OK — created on first run) |
| `devin version` | the CLI is resolvable in `PATH` |
| `devin auth status` | the CLI is logged in |
| ACP hello probe | `devin acp` initialize handshake (acp engine only) |
| skills home | `~/.agents/skills` parent is reachable (created on first run) |

Fix any `error`-level checks before hiring an agent on this adapter.

### 4. Hire a Devin agent

Create an agent with adapter `devin_local` and set the fields below. The
minimal viable config is just `model`; everything else has defaults.

## Agent configuration

| Field | Default | Notes |
|---|---|---|
| `command` | `devin` | CLI binary name or absolute path |
| `cwd` | Paperclip workspace | Absolute working directory for the Devin session |
| `model` | `swe-2-high` | Any id from `devin models list` |
| `engine` | `cli` | `cli` = `devin -p` one-shot per heartbeat; `acp` = `devin acp` structured session |
| `acpMode` | derived | Devin ACP session mode id (`ask`, `plan`, `smart`, `accept-edits`, `bypass`). Defaults to a mapping from `permissionMode`; acp engine only |
| `permissionMode` | `smart` | `auto` / `accept-edits` / `smart` / `dangerous` |
| `sandbox` | `false` | Pass `--sandbox` (bwrap/seatbelt exec sandbox) |
| `instructionsFilePath` | — | File prepended to the run prompt |
| `promptTemplate` | built-in | `{{agentId}}`, `{{runId}}`, `{{context.*}}` vars |
| `timeoutSec` | `0` | Hard turn timeout (0 = unlimited) |
| `graceSec` | `20` | Grace period before force-kill |
| `extraArgs` | `[]` | Extra CLI args appended to the invocation |
| `env` | `{}` | Extra env vars for the Devin process |

`dangerous` auto-approves every tool call including arbitrary shell commands —
use it only on trusted, isolated hosts.

## Behavior notes

- **Local only.** Remote/SSH execution targets are rejected; Devin runs on the
  Paperclip host under the server's OS user and credentials.
- **Skills.** Desired Paperclip skills are symlinked into `~/.agents/skills`
  (a directory Devin scans globally) on each run; stale Paperclip-managed
  links are removed. The agent's cwd is never touched. On Windows, directory
  junctions are used so no elevated privileges are needed.
- **Env injection.** `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` (the run-scoped
  token), `PAPERCLIP_RUN_ID`, `PAPERCLIP_TASK_ID`, wake/approval vars and
  workspace vars are injected so Devin can call the Paperclip API from its
  shell.
- **Billing** is reported as `subscription` (account-backed; free-tier models
  report no per-run cost).

## Package layout

| Export | Contents |
|---|---|
| `devin-paperclip-adapter` | adapter metadata (`type`, `label`, `models`, `agentConfigurationDoc`) and `createServerAdapter` |
| `devin-paperclip-adapter/server` | server-side adapter module: `execute`, `testEnvironment`, `sessionCodec`, `listDevinModels` |
| `devin-paperclip-adapter/ui-parser` | browser-safe transcript parser for `devin.*` event lines |

Every export ships TypeScript declarations (`.d.ts`) generated by `tsc`, so
consumers get full typing under `NodeNext`/`bundler` resolution.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

Iterate locally with `POST /api/adapters/devin_local/reload` after rebuilds.

## Publishing

### npm

Releases are published by GitHub Actions
(`.github/workflows/publish.yml`) via npm **trusted publishing** (OIDC —
no npm token is stored). Publishing a GitHub release whose tag matches
`package.json` `version` (e.g. tag `v1.0.1` for version `1.0.1`) triggers
the workflow; a tag/version mismatch fails the run.

One-time setup on npmjs.com under the package's **Settings → Trusted
Publisher**:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `Qoyyuum` |
| Repository | `devin-paperclip-adapter` |
| Workflow filename | `publish.yml` |
| Allowed actions | enable `npm publish` |

Manual publishing still works as a fallback:

```bash
npm login          # once
npm publish        # prepublishOnly runs clean -> build -> test -> typecheck
```

`prepublishOnly` guarantees the tarball always contains freshly compiled
`dist/` output and generated `.d.ts` stubs — it runs in the workflow too.

### JSR (jsr.io)

A `jsr.json` manifest ships with the repo. JSR publishes the TypeScript
source directly, so consumers get types automatically.

```bash
# Edit "name" in jsr.json to a scope you own (JSR requires @scope/name),
# keep "version" in sync with package.json, then:
npx jsr publish
```

npm dependencies are declared in the `imports` map of `jsr.json`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `devin_not_found` check fails | `devin` not in `PATH` for the Paperclip server's OS user — set `command` to an absolute path |
| `devin_auth_missing` | run `devin auth login` as the same OS user that runs Paperclip |
| Run fails with unknown model | model id isn't available to the account — check `devin models list` |
| Session doesn't resume | `cwd` changed between runs, or the stored session expired — the adapter retries once with a fresh session and reports `clearSession` |
| Agent stuck in `verifying` | rerun the environment test; any `error`-level check blocks hiring |
