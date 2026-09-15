# dsh-plugin-teamflow

[![npm version](https://img.shields.io/npm/v/dsh-plugin-teamflow)](https://www.npmjs.com/package/dsh-plugin-teamflow) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[中文](./README.md) | English

TeamFlow team R&D pipeline — a distributable DeepSeek Harness plugin (install via `dsh plugin --profile web add`).

Turns "one-line user requirement → real R&D team multi-agent pipeline" into a host-level capability:

```
requirement → PRD (based on existing patterns / product memory, archived to prevent bloat)
            → (UI redesign) UI/UX design
            → (new project) architect plans and scaffolds + AGENTS.md
            → senior full-stack engineer tech spec (aligned with dispatched tasks)
            → parallel dev when tasks are splittable
            → QA functional testing (structured defects → register bugs)
            → product acceptance (update product memory)
```

## Screenshots

1. Pipeline view — stage serpentine lanes + node cards (status / duration / tokens / subagent session)

   ![Pipeline view](docs/screenshots/pipeline-view.png)

2. Backlog board — draggable lanes for requirements / tasks / defects

   ![Backlog board](docs/screenshots/board.png)

3. Stage detail drawer — full stage artifacts + token breakdown + "🎬 jump to subagent session"

   ![Stage detail](docs/screenshots/stage-detail.png)

4. Board task detail — task-card drawer (requirement text / assignments / event timeline / subtasks / defects / tokens)

   ![Board task detail](docs/screenshots/board-task-detail.png)

5. Team selector — 🏭 button + team dropdown

   ![Team selector](docs/screenshots/team-selector.png)

## Core Features

- **One-line requirement → accepted delivery**: requirement → PRD → technical design → parallel development → QA → acceptance is orchestrated end to end; every stage gets a task card, artifacts and a verdict. Small mechanical changes can use the `patch` / `lite` tiers to trim the stage set instead of running a full waterfall.
- **Multi-agent team + parallel development**: the requirement is split into parallelizable tasks from the architecture blueprint (3 concurrent by default, 8 max), with product / architecture / dev / QA each working in their own isolated context.
- **Anti-fake-delivery**: delivery is judged by evidence, not wording — a stage must provide a `[Verification evidence]` block (command + exit code + assertion count), QA runs its own adversarial probes, and acceptance only trusts an explicit verdict line (missing ⇒ the pipeline stops for a human).
- **QA bounce-back loop**: P0–P2 defects are sent back for a fix and re-verified (≤2 rounds), each defect carrying its own check command and pass criterion; exceeding the limit hands over to a human instead of pretending the run is "done".
- **Resume + completion report**: after a crash or restart the pipeline continues from the first unfinished stage (completed stages reuse their artifacts); when a run ends, a summary (status / stages / tokens / next steps) is delivered back to the originating session.
- **Your repository stays clean**: pipeline docs live in the `docs/teamflow/` task folder and the plugin's own run logs are archived out of your project when the run ends — the closing commit carries **code + the task folder only** (one commit per run, **no pre-configured `.gitignore` required**). If an older commit already swept in `logs/teamflow/`, untrack it in that repository with `git rm -r --cached logs/teamflow` (your local files stay).
- **🏭 Team workbench (two entry points)**: an in-session tab (pipeline graph, drag-and-drop kanban, cost centre, human-intervention centre) and an app-level panel (product-line view, usable across sessions); open any run to see its stages, tokens, verification evidence and artifacts. The UI is **bilingual (Chinese / English)** and follows the host language live; host replies, pipeline logs and pipeline artifacts follow it too (resolved once per run).
- **Token accounting you can audit**: every stage records its input (cache miss / hit), cache write, output and call count, plus the cache-hit rate, shown on the same basis in reports and in the workbench; mechanical stages automatically drop their reasoning effort and raise it again on retry.


## AGENTS.md minimal-invasion principle (important)

AGENTS.md is unconditionally injected into every session by the harness; it is **team assets**. TeamFlow follows separation of concerns:

- **AGENTS.md holds only the stable consensus layer**: team role flows, engineering conventions, doc index, and the `<!-- teamflow:begin/end -->` managed region (pointers only).
- **Product memory / todos go in a separate live doc** `docs/teamflow/memory.md` (read on demand, not injected every session → saves token).
- **Onboarding existing projects**: if AGENTS.md already exists → never rewrite / reorder / overwrite; only append a managed block at the end (if none); the team's original conventions are left untouched line by line.
- **Clean exit**: after a team stops using TeamFlow, deleting the managed block and `docs/teamflow/` fully restores it, with no ledger left in AGENTS.md.

## Architecture (stage 3)

```
web profile host composition
├── teamflow-host   (dsh-plugin-teamflow/host)      Cordis service `teamflow`
│     └── TeamflowService extends TypertRemoteService
│           ├── ctx.typert.register(strict descriptors)   ← 17 Remote methods
│           ├── ctx.tools.register(teamflow_*)            ← 12 model tools
│           └── node:fs → $DSH_HOME/teamflow/...
└── teamflow-client (dsh-plugin-teamflow/client, auto-scanned)  ← package.json declares dsh.client,
      └── ctx.remote.$mount(TEAMFLOW_REMOTE_CONTRIBUTION)      no patch line needed, clientModules auto-registers
            └── conversation.view tab "🏭 Team Workspace"
```

**Why not the @Remote decorator**: host plugins are distributed as plain JS to avoid decorator syntax / TS compilation requirements; `ctx.typert.register` registers strict descriptors (`descriptors.js` pure data, shared by host/client, keeping endpoint and wire parameters consistent).

**Why a host-level plugin (not a dynamic plugin)**: dynamic (in-session) plugins run in a restricted sandbox whose `fs` is hard-limited to the runtime root and cannot write to `$DSH_HOME` or the session workspace (observed `file access denied under workspace-write mode`). Only a formal plugin inside the host composition has real Node `fs`, able to land backlog in `$DSH_HOME`, and the client can register an independent tab.

## Directory structure

```
dsh-plugin-teamflow/
  package.json        # dsh.bundle.patch + dsh.client declarations; exports point to lib/ build output
  cordis.patch.yml    # insert block; entry name uses package root (so clientModules can scan dsh.client)
  tsdown.config.ts    # client build (ModuleLoader bundle → lib/client.js)
  tsdown.host.config.ts # host/store/descriptors build (ESM → lib/*.mjs)
  descriptors.ts      # Remote descriptors (pure data, shared by host/client)
  store.ts            # persistence layer: atomic write / backup / corruption self-heal + journal serialize / load (independently testable)
  host/index.ts       # TeamflowService (TS; built to lib/host.mjs for the host to load)
  client/index.tsx    # Team Workspace (TSX; built to lib/client.js)
  test/smoke.js       # dependency-free smoke test (descriptors / structure / security hardening)
  test/journal.test.js # journal behavior test (runs store.ts source directly)
```

**TypeScript note**: the whole repo is TS/TSX. The host **must be built** (cannot rely on Node strip-types to run directly) — Node 22's type stripping does not apply to files under `node_modules` ("unsupported for files under node_modules"), while the host composition loads plugins from `profile/node_modules`. Consistent with the DSH ecosystem (the `@deepseek-ai/dsh-*` host packages' exports all point to lib/*.js). After changing source, run `pnpm bundle` to rebuild and sync the profile copy's `lib/`.

## Requirements

- DeepSeek Harness (dsh) host, **web profile** (the plugin ships a browser-side workspace; the client targets the web platform);
- Node.js ≥ 22.18;
- Relies on host-provided `@deepseek-ai/dsh-*` and `react` (peerDependencies, injected by the host — no separate install needed).

### Version anchor (dsh host compatibility)

This plugin is developed and verified against **dsh v0.1.5-rc.2 (2026-09-10, tag `dsh-v0.1.5-rc.2`)**; on npm the `@deepseek-ai/dsh` package has `next`=0.1.5-rc.2 and `latest`=0.1.5-rc.1 (`latest` lags behind `next` — do not use `latest` to judge the release line). `peerDependencies` stay at `*` (host-injected, deliberately loose), and `package.json` declares the compatibility window **`engines.dsh: ">=0.1.5-rc.2 <0.2.0"`** plus **`dsh.manifestVersion: 1`** — dsh does not read or validate either field today (they exist as types only), so they are declarative author metadata.

Compatibility check of 2026-09-10 (dsh 0.1.5-rc.2): plugin panel slots (the old `conversation` root slot → the `conversation` key under `main`), session format V3 + Session lifecycle (`SessionHandle`, async `agentLoop.create()`, session locks), removal of `ctx.agent` and typed Inbox, adjusted default tools for SDK/Headless/ACP, subprocess handles without pid — **the plugin is compatible with all of them** (it uses none of the changed interfaces; the `conversation.view` / `conversation.input.right` declarations are unchanged and no slot was removed). One follow-up item:

- **The synchronous session event readers are deprecated** (`session.eventAt()` / `snapshotEvents()` / `ownEvents()`; since 2026-09-09 the host allows existing calls but forbids new ones, aiming to stop keeping the full event sequence resident in memory): **token metering now prefers the official Session projection** (`ctx.sessionProjections.stateOf(session,'tokenUsage')` for the four buckets + `'sessionStats'.steps` for the call count), with event scanning degraded to a fallback for hosts without projections; **the guard reminder channel moved to the official `Agent.inject()` and the stall check to the official `subagentTiming` projection's `active.through`** (long silent tools are still exempted by the agent-activity guard). Only **repeat detection** still reads events (it needs streaming text; the official replacement — subscribing to `'session/event'` post-commit delivery — requires an equivalent predicate first, see `docs/TODO.md`).

## Install (for users)

```bash
# Install from npm (after publish)
dsh plugin --profile web add dsh-plugin-teamflow

# Or local directory install (during development)
dsh plugin --profile web add file:./plugins/dsh-plugin-teamflow
```

After install, **restart** `dsh --profile web` for the host `teamflow-host` to take effect:
- The model side gains 12 `teamflow_*` tools: `start / triage / status / backlog / claim / update / assign / cancel / resume / pause / resume_session / merge`;
- The browser session header shows the "🏭 Team Workspace" tab;
- Backlog is written to `$DSH_HOME/teamflow/<product>/backlog/*.json`.

> Note: `@deepseek-ai/*` are host-private packages; running requires the DeepSeek Harness (dsh) host environment; this package is neither published standalone nor runnable alone.

## Quick start

1. **Pick a team**: click the 🏭 button next to the input box and choose a team (or "no team" = chat directly, no pipeline);
2. **Say the requirement**: just describe it — the model calls `teamflow_start` automatically (auto-triage: patch / lite / tech / medium / full); or force a mode, e.g. "run this in medium mode";
3. **Watch progress**: switch to the 🏭 Team Workspace tab in the session header — the pipeline graph live-refreshes (per-stage token / duration / sub-agent session), and the backlog kanban supports drag transitions and card detail drawers;
4. **Get the result**: the pipeline reports back to the session automatically when done (status / stage stats / token / next steps); interrupted/failed runs can "↻ resume from checkpoint".

> Note: after `teamflow_start`, the **main thread should not modify code or run verifications itself** — implementation, QA, and reporting are done by pipeline sub-agents (avoid fighting the pipeline over the workspace).

## Uninstall (for users)

```bash
dsh plugin --profile web remove dsh-plugin-teamflow
```

After restarting `dsh --profile web`, the plugin is fully removed (the model-side `teamflow_*` tools and the 🏭 Team Workspace tab disappear).

Optional cleanup (NOT done automatically; run as needed):
- **Runtime data**: delete `$DSH_HOME/teamflow/` (backlog / run records — confirm you no longer need them first).
- **Project traces**: if a team used TeamFlow in a project, delete the `<!-- teamflow:begin/end -->` managed block in that project's `AGENTS.md` and the `docs/teamflow/` directory to fully restore it (the "clean exit" rule of the AGENTS.md minimal-invasion principle).

## Development & verification

```bash
npm test                # smoke (descriptors / structure / security) + journal (resume behavior)
npm run typecheck       # tsc --noEmit type check (same as VSCode, no drift)
node --check lib/host.mjs lib/client.js lib/store.mjs lib/descriptors.mjs
npm run bundle          # build client (tsdown → lib/client.js, __ModuleLoader__.load registers)
```

**For plugin developers** (the local dev loop of THIS plugin): see [`AGENTS.md`](./AGENTS.md) and [`docs/adr/`](./docs/adr) in the repo — deployment sync (`node deploy.mjs` → restart `dsh --profile web`), the "running web loads the host from the profile deployment copy, building source alone does not take effect" caveat, design decision records (ADR-0001~0009) and benchmarks (`docs/benchmarks/`). All repo source is TS/TSX and must be built first (`pnpm bundle`) to run (`strip-types` does not apply under `node_modules`).

Note: `lib/` is excluded by `.gitignore` but must ship with the package (`files` whitelist includes `lib/`; `exports["./client"]` points to `./lib/client.js`).

## Contract quick reference

| Tool / Remote | Purpose |
|---|---|
| `teamflow_start` / `teamflow.start(sessionId, requirement, options)` | Start the pipeline |
| `teamflow_status` / `teamflow.list()` + `teamflow.snapshot(runId)` | Query run progress (stage / status / token / log / needs-human?) |
| `teamflow_backlog` / `teamflow.backlog(product)` | View backlog (+ persistence path) |
| `teamflow_claim` | Claim a task or defect |
| `teamflow_update` / `teamflow.backlogUpdate(kind, id, to, product, reason)` | Manually transition state (handle needs-human) |
| `teamflow_cancel` / `teamflow.cancel(runId)` | Cancel a run |
| `teamflow_resume` / `teamflow.resume(runId, sessionId)` | Resume from checkpoint (rerun from first unfinished stage) |
| `teamflow_triage` | Requirement triage preview (start auto-triages by default; use only to pre-assess / force a mode) |
| `teamflow_assign` | Assign owner of a task / defect (separate from claim: claim only changes state) |
| `teamflow_pause` / `teamflow_resume_session` | Pause / resume teamflow triggering for the current session (session-level, auto-reset on new session) |

## License

MIT — see [LICENSE](./LICENSE).
