# dsh-plugin-teamflow

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

## Core Features

- **Anti-fake-delivery**: ① Substantive validation — outputs containing rejection phrases ("I cannot complete", etc.) or below the per-stage length floor are treated as undelivered and routed to retry / human intervention; ② Token circuit breaker — a single stage accumulating 60k budget stops retries; ③ Context-exhaustion failures are not retried (retrying the same prompt likely reproduces); ④ Product-level concurrency lock — only one active pipeline per product at a time, preventing requirement state from stepping on itself; ⑤ Memory trimming — timeline summarization + in-memory stage output removal (kept on disk, reloaded in full on resume).
- **Auto completion report to main thread**: when a pipeline ends (success / failure / cancel / interrupt), it automatically delivers a summary (status / stage stats / total token / backlog / next-step guidance) to the initiating session's Agent — wakes on idle (followup), injects next-step context when busy (inject), using the same mechanism as DSH's background-task notifications (tool-jobs mode, but independently implemented and not dependent on the web-disabled tool-jobs). The user need not watch the panel; the model relays the result or continues per guidance (claim defects / transition / resume from checkpoint).
- **Resume from checkpoint**: every stage checkpoint persists to `$DSH_HOME/teamflow/runs/<runId>.json` (LangGraph checkpointer semantics); after a process crash / restart it is auto-marked `interrupted`, and `teamflow_resume` / the panel's "↻ resume from checkpoint" continues from the first unfinished stage (skipping completed stages, reusing full stage outputs).
- **Backlog persistence (workspace-isolated since v0.1.0)** under `$DSH_HOME/teamflow/<workspace>/backlog/` as `requirements.json` / `tasks.json` / `bugs.json`, surviving restarts; backlog is isolated per "workspace (project)" — one workspace is one product line, and different workspaces each see their own Team Workspace.
- **Single-task model (v0.1.0)**: one requirement = one rotating task card (no longer split by role); the task card records `devAssign` / `qaAssign` / acceptor, with state rotation: todo → developing → to-test → testing → to-accept → accepted | bounced | needs-human; the delivered frontend page also shows each role's **real token usage** spent on that task.
- **Artifact consolidation (v0.1.0)**: pipeline docs (PRD / design / architecture / tech spec / QA / memory / history) all consolidate into `docs/teamflow/`, command run logs into `logs/teamflow/<runId>/`, so the host `docs/<role>/` and project root are no longer polluted by TeamFlow; the host-side run log likewise lands in `<workspace>/logs/teamflow/<runId>.log`.
- **State machine + event log**: requirement (initiated → in-progress → to-accept → accepted), task (todo → developing → to-test → testing → to-accept → done | bounced | needs-human), defect (to-claim → in-progress → fixed-to-verify → closed).
- **Bounce-back threshold**: 2 consecutive Agent failures in a single stage auto-retry; still failing → `needs-human`, requiring human intervention.
- **Concurrency pool**: dev tasks run in parallel by `maxConcurrency` (default 3, max 8).
- **QA defect registration**: the QA report outputs in a fixed table → auto-parsed into bugs entering the backlog.
- **Token metering (official semantics)**: each stage records `usage` = **cache-miss input / cache-hit input / write-cache / output + call count** (accumulated per event by the sub-agent session) + **cache hit rate** (cacheRead / (input + cacheRead)). Workspace cards / task cards / completion reports all display in this basis — model-agnostic and consistent with the official bill.
- **lite mode (v0.1.0)**: lightweight micro-features — `teamflow_start(lite:true)` skips the standalone tech-spec doc stage (PRD is the contract) and goes straight **PRD → dev → QA → acceptance**; with `needDesign:true` it **keeps the UI/UX design stage**. Measured ~64% time / ~88% token savings vs the full 7-stage run.
- **Token circuit breaker**: when a stage's official total consumption (input + cacheRead + cacheWrite + output accumulated) exceeds `STAGE_TOKEN_BUDGET` (default 60k), retries stop and human intervention is required.
- **🏭 Team Workspace (Web tab)**: a session-header tab alongside chat / trace, containing:
  - Pipeline graph (stage swimlanes + node cards: status / duration / token / sub-agent session, 2s live refresh)
  - **Backlog drag-drop kanban** (requirement / task / defect three status swimlanes, cards dragged to transition, native HTML5 DnD zero-dep)
  - Cost center (per-stage token + total + runtime)
  - Human-intervention center (needs-human items aggregated + one-click terminal state)
  - History run switching + product switching

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
│           ├── ctx.typert.register(strict descriptors)   ← 7 Remote methods
│           ├── ctx.tools.register(teamflow_*)            ← 6 model tools
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

## Install (for users)

```bash
# Install from npm (after publish)
dsh plugin --profile web add dsh-plugin-teamflow

# Or local directory install (during development)
dsh plugin --profile web add file:./plugins/dsh-plugin-teamflow
```

After install, **restart** `dsh --profile web` for the host `teamflow-host` to take effect:
- The model side gains 11 `teamflow_*` tools: `start / triage / status / backlog / claim / update / assign / cancel / resume / pause / resume_session`;
- The browser session header shows the "🏭 Team Workspace" tab;
- Backlog is written to `$DSH_HOME/teamflow/<product>/backlog/*.json`.

> Note: `@deepseek-ai/*` are host-private packages; running requires the DeepSeek Harness (dsh) host environment; this package is neither published standalone nor runnable alone.

## Development & verification

```bash
npm test                # smoke (descriptors / structure / security) + journal (resume behavior)
npm run typecheck       # tsc --noEmit type check (same as VSCode, no drift)
node --check lib/host.mjs lib/client.js lib/store.mjs lib/descriptors.mjs
npm run bundle          # build client (tsdown → lib/client.js, __ModuleLoader__.load registers)
```

**Type resolution note**: `@deepseek-ai/dsh-*` are host-private packages (not on the public registry, injected by the dsh profile at runtime); types come from the locally installed host copy at `~/.dsh/profiles/node_modules/@deepseek-ai/*` — `tsconfig.json`'s `paths` already maps them (change the username in the path when moving across machines). The build (tsdown) does not depend on this mapping: the host build keeps `@deepseek-ai/*` external, and the client does not reference host packages.

Effective chain after changing code (recommended): `node deploy.mjs` (build + test + sync profile copy + detect running web and prompt restart) → restart `dsh --profile web`. Backup chain: `npm run bundle` → update profile copy (`pnpm update dsh-plugin-teamflow`, under `~/.dsh/profiles/web/`; if "Already up to date", first delete `node_modules/dsh-plugin-teamflow` then update) → restart `dsh --profile web`.

**⚠ Effectiveness prerequisite (easy to trip)**: the running web loads the host from the **profile deployment copy** (`~/.dsh/profiles/web/node_modules/dsh-plugin-teamflow/lib/`), not the source `plugins/.../lib/`. Building only the source does not take effect in the profile; you must deploy-sync + restart the process, otherwise old logic runs (e.g. the lite flag is silently ignored).

Note: `lib/` is excluded by `.gitignore`, but not by `.npmignore` — both `file:` install and npm publish must carry the build output (`exports["./client"]` points to `./lib/client.js`).

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
