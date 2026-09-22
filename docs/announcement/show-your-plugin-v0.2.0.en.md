<!-- Announcement · English version · anchored to **v0.2.0** (2026-09-23) · venue TBD (GitHub Discussion or elsewhere; the body assumes no particular platform)
     **This version posts in ENGLISH by default**; the Chinese version (`show-your-plugin-v0.2.0.zh.md`) is the switcher target, linked on the first line of the body.
     Suggested titles:
       ▶ primary [Plugin] TeamFlow v0.2.0 for DeepSeek Harness — requirement → acceptance, with quality gates, token accounting and resume
       · alt [Plugin] TeamFlow v0.2.0 — a multi-agent R&D pipeline for DeepSeek Harness (requirement → acceptance)
     Every number below can be checked verbatim in the repository (sources are noted inline). This is a NEW
     announcement: the previous one (`github-discussion-show-your-plugin.md`, anchored to v0.1.8) is frozen and kept for history only.
     **Previous posting**: the v0.1.8 announcement ran in `deepseek-ai/deepseek-harness` Discussions [#6405](https://github.com/deepseek-ai/deepseek-harness/discussions/6405) (2026-09-12 07:26 UTC) under the title "dsh-plugin-teamflow：把「一句话需求」跑成一条带质量门禁的多 Agent 研发流水线"; @boshk0 asked "Is there English translation?" in its comments — that request is why this version posts in English.
     **Editorial line (decided 2026-09-23)**: this version does NOT surface the third comparison measurement (`assetd-clarity-vs-gate.md`, a tie) or self-critical phrasing — that style stays in the repository's internal docs. The data itself is still in `docs/benchmarks/` (linked in the body); nothing was deleted.
     ➜ This file freezes after posting too; write a new one, anchored to that version, next time. -->

[中文](./show-your-plugin-v0.2.0.zh.md) | English

<!-- Switcher line — two situations, do not mix them up:
     · Inside the repository use a RELATIVE path (the line above; same form as README.md:5 / README.en.md:5) — always valid on the repo pages.
     · In the POSTED text replace it with a post-to-post link (a relative path is a dead link in a Discussion or on any external forum):
         English post line 1 → [中文](<URL of the Chinese post>) | English
         Chinese post line 1 → 中文 | [English](<URL of the English post>)
       Post URLs are permanent and depend on no branch, commit or tag — which is exactly why this file pins neither a SHA nor a tag: the reader should land on the POST, not on a source-file revision.
       If the Chinese version is not posted anywhere yet, drop this line from the English post (or state the repo path in the body).
     · Both files currently live only on release-v0.2.1 and are not on main yet; once they land on main the relative path keeps working unchanged. -->

> `dsh plugin --profile web add dsh-plugin-teamflow` → restart `dsh --profile web` and you're in

**Sound familiar?** You ask an agent to change a 2,000-line module. It says "done". You run the tests and three old behaviors are quietly broken. On long tasks the model drags an ever-growing context behind it and nobody ever signs off — **context bloat + no gates** are the two failure modes of the single-session agent.

**TeamFlow is built for exactly those two**: give it a one-line requirement in a session and it spins up a subagent team that runs `requirement → PRD → (UI/UX design) → (scaffold) → technical plan → parallel dev → QA → acceptance`. Every artifact lands on disk as a file, the acceptance verdict is a contract, failures surface loudly, a crash is resumable, and every token maps to the host's own accounting. **The point is engineering discipline, not a "one prompt, one app" toy.**

**Current release: v0.2.0** (npm `latest`). **If you installed an older version, read the next section first** — 0.1.9 simply does not work on the current host.

---

## Upgrade first: why 0.1.9 has to go

Since dsh `0.1.7-alpha.1` the session format is **v4**: the host validates `source.kind` *before* an event is admitted into the Session, and it requires a **producer-owned** form (`plugin:dsh-plugin-teamflow`). 0.1.9 still emitted the v3-era wrapper (`{kind:'plugin', plugin}`), so **every live injection was rejected on the spot** — team-context injection, completion reports and guard reminders, all three dead. From the user's side the plugin simply stopped working. And 0.1.6-alpha.2 or older has **no** v3→v4 migration package, so the two source shapes are mutually incompatible. Bottom line: **v0.2.0 is the only release that runs on a v4 host.**

| | |
|---|---|
| Compatibility window | `engines.dsh: ">=0.1.7-alpha.1 <0.2.0"` (author's declaration; the host does not enforce it) |
| Measured with semver | `0.1.7-alpha.1/2`, `0.1.7`, `0.1.8`, `0.1.9` **pass**; `0.1.6-alpha.2`, `0.2.0*` **fail** |
| Requirements | dsh **web profile**, Node ≥ 22.18, a writable `$DSH_HOME` (host-level `fs`) |

---

## What it looks like

**Global panel** — sidebar icon → cross-session / product-line view (product line → run list + backlog)

![Global panel](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/en/global-panel.png)

**Pipeline view** — serpentine stage lanes with node cards (status / duration / tokens / subagent session, refreshed every 2s)

![Pipeline view](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/en/pipeline-view.png)

**Stage detail** — full stage artifact + token breakdown + jump to the subagent session

![Stage detail](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/en/stage-detail.png)

**Backlog board** — requirement / task / defect swimlanes, drag-and-drop transitions (native HTML5 DnD, zero dependencies)

![Backlog board](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/en/board.png)

**Task card detail** — original requirement / assignment / event timeline / child cards / defects / tokens by role

![Board task detail](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/en/board-task-detail.png)

**Team selector** — one workspace can carry several teams (a team *is* a stage set)

![Team selector](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/en/team-selector.png)

> The UI itself is **bilingual (Chinese / English)** and follows the host language live. The screenshots above are the English UI; the Chinese set lives in `docs/screenshots/`.

---

## Core features

### ① Five stage-set tiers with model-driven triage

`patch` (single-point fix, dev self-test as the floor) / `lite` (small feature, PRD *is* the contract) / `tech` / `medium` / `full`.

By default `teamflow_triage` reads the requirement and picks the tier (regex does deterministic guardrails only); you can also force one through the call arguments. The point is **matching process weight to requirement size**: `lite` drops the standalone technical-plan stage entirely, `patch` is just a confirmation plus dev. **New in v0.2.0**: the tier is no longer whatever the model feels like — architecture guardrails force an upgrade to `medium`.

### ② New in v0.2.0 — clarification gate (blocks before a run is even created)

Before starting, the pipeline reuses **that same triage call** to run a pre-check (threshold and self-consistency are judged by the host). If it trips, you get `needs-clarification` and **no run is created** — the requirement's fuzzy edges get asked about *before* you spend anything, instead of surfacing at acceptance. **Only the `patch` tier is exempt**; once you have supplied a supplement it will not block again; a resume does not re-run triage (the authoritative decision lives in exactly one place).

### ③ Artifacts are files (single-track output)

Each requirement gets one self-contained task folder `docs/teamflow/<yyyyMMdd>-r<N>-<slug>/` holding PRD / DESIGN / TECHNICAL / QA-REPORT / ACCEPTANCE.

**The full QA and acceptance reports exist only as files; the subagent's reply is a summary plus paths.** The host parses the files — a missing or empty file is a **hard failure routed to a human, with no fallback to parsing the model's reply**. That kills the classic two-track mismatch where the reply says "all green" and the file says nothing.

### ④ Acceptance verdict contract (tightened in v0.2.0)

The verdict line must be a **literal template** (✅ / ⚠️ / ❌ / 📝) and must be the **last line of the file**. **No verdict line → human review; never assume "passed"** — the old implementation fell back to the most optimistic verdict, i.e. the quality gate silently under-reported. A throwaway "no changes needed" in the body was once substring-matched into a requirement rejection that failed the whole pipeline. Two more calibrations are now pinned by tests: the verdict line must not hide behind a heading like `## 1. Acceptance summary` (headings used to skew the parse), and 📝 only counts at the start of a line (matching it anywhere misjudged real reports). Defect parsing likewise **only accepts an explicit severity header**; a table without one is skipped wholesale.

### ⑤ Resume, at task granularity

Every stage checkpoints to `$DSH_HOME/teamflow/<product>/runs/<runId>.json` (atomic write + `.bak` + corruption self-healing).

After a crash or restart the run is marked `interrupted`; `teamflow_resume` continues from the first unfinished stage, and the dev stage re-runs **only the tasks that did not succeed**, reusing the artifacts that did. Retries carry a diagnostic packet (failure class / guard reason / rejection-hit points / tail of the output) — blind retries become informed ones. **New in v0.2.0**: task identity is the host-generated `dt-N` only (title-based double keys used to split one task into two backlog cards).

### ⑥ Token accounting on the host's official basis + per-stage circuit breaker

Each stage records `usage` = input (uncached) / input (cached) / cache write / output + call count + cache-hit rate.

The source is the **official Session projection** (`ctx.sessionProjections.stateOf(session,'tokenUsage')` for the four buckets, `'sessionStats'.steps` for calls) — the same fold the host's own token meter uses, so **there is no second ledger to drift**. The circuit breaker uses **newly consumed** tokens (`input + cacheWrite + output`, i.e. **cache hits excluded** — cache hits are cheap replays, and counting them means "any single failure trips the breaker instantly", making automatic retry pointless). Crossing `FRESH_TOKEN_BUDGET` (200k by default) stops retrying and routes to a human, while reports and UI still use the official billed basis. **New in v0.2.0**: the budget adapts to the provider's caching ability (providers without prompt caching no longer hit the wall on fixed overhead alone).

### ⑦ QA rework loop

P0–P2 defects found by QA → back to dev for confirmation and fix → re-verification, at most 2 rounds, then a human (the run continues as "known issues" read-only, and is **not** allowed to merge).

Defects are registered idempotently by `reqId + defectId`, and closing is automatic once re-verification passes (P3 observations stay open). If dev has failed tasks, the run is **stopped at the QA door** instead of burning QA tokens on nothing.

### ⑧ In-flight guard + new in v0.2.0: environment-unavailable early stop

A runaway subagent must be visible — and **stopped**. The signals are pure progress signals with **no time budget** (a legitimately slow-but-productive task must not be interrupted): **reasoning loop** (the same streamed fragment recurring inside a sliding window with zero writes in that window), **stall** (the official `subagentTiming` projection's `active.through` stops advancing), **idling** (events still flow but no tool call for a long time). Any of them triggers `dispose()` on that attempt. The backdrop is a measured QA subagent that looped for **38 minutes and burned 4.81M tokens with zero output**.

**New in v0.2.0 — a fifth early-stop signal, `env-unavailable`**: when the same tool keeps failing with the *same* error (reminder after 2 consecutive hits, abort after 3, **no automatic retry**, and it **outranks "it finished"**), the host names the environment and quotes the original error. This came out of a real host failure: the Windows sandbox could not materialize ACLs on a user-created directory, so every shell command in that workspace failed 100% of the time — and the model just retried, then reasoned at length, **burning 52,588 output tokens in one stage with zero output**. With the signal in place, the same workspace and the same failure ended at **1,510 tokens / 15 seconds**. (The host-side bug is filed upstream — see the links at the end.)

### ⑨ New in v0.2.0 — the pipeline is interruptible

Three entry points share one two-step cancel button (click once, then confirm); `cancelRun` only accepts `status === 'running'`; **concurrent stages all stop together** and the pool takes no new work afterwards. Terminal-state normalization runs in the first line of a `finally`, the cancel origin is persisted, and **a cancelled run never nudges the model to resume** (it used to reopen itself).

### ⑩ Team workbench (in-session and global)

A tab in the session header — the pipeline lanes, the drag-and-drop backlog board (requirements / tasks / defects), a cost center (tokens and wall-clock per stage), a human-intervention center (needs-human aggregation plus one-click terminal states), and run history switching. A task card pushes its task-folder artifacts into the host's **right sidebar** for preview. **New in v0.2.0**: the cross-session **global panel** (sidebar icon → product-line view) shipped in v0.1.8; this release added a stop entry point (stop straight from a run row), turned its artifact jump from a silent downgrade into a **real session jump** (`uiWorkspace.openSession`), and made it fully bilingual.

### ⑪ Minimal footprint in your repository (the full version of ⑧ in the previous announcement)

- **AGENTS.md is your asset, not ours**: if it already exists we **never rewrite, reorder or overwrite** it — we only append one managed pointer block (`<!-- teamflow:begin/end -->`) at the end (skipped if already present, and not a single other line is touched). Product memory lives separately in `docs/teamflow/memory.md`, read on demand and not injected into every session. Disable the plugin, delete the managed block and `docs/teamflow/`, and your repo is exactly as it was.
- **One run, one commit**: product code + task folder (PRD / TECHNICAL / QA-REPORT / ACCEPTANCE) + `memory.md` land in the same commit; **`logs/teamflow/` is never committed** (run logs are process evidence, not repository content), with an index-level unstage as the backstop.
- **`.gitignore` gets exactly one line, and only the line it should get**: right before a commit we idempotently add `logs/teamflow/` (plugin-owned logs, not deliverables); a failed or cancelled run **never** leaves you an uncommitted `.gitignore` change. **What your project should ignore is not ours to decide** — baseline noise such as `node_modules/` is excluded only at the `git add` index layer (decided by `git check-ignore`, and anything already ignored is never named explicitly). An earlier implementation wrote those rules into the user's `.gitignore`; that was ruled out of bounds and reverted.
- **Writes have a boundary, and the log root is not in your project**: apart from product code and the AGENTS.md managed zone, we write only under `docs/teamflow/` and the run's log staging directory — **never into your `docs/<role>/` folders and never into the project root**. During a run logs are staged in the workspace, then on terminal state whitelisted (check scripts / notes / `captures.json`) into `$DSH_HOME/teamflow/<workspace>/logs/<runId>/` with the copy deleted, keeping the most recent 20 runs per workspace; command output and snapshots are never written to files.

---

## For people building dsh plugins: pitfalls we actually hit

This part may be more useful to the community than the plugin itself — all of it is measured, not theorized:

- **New: session v4 requires a producer-owned `source.kind` on injected events.** The host validates before admitting, and the v3 wrapper (`{kind:'plugin', plugin}`) is **rejected** — quietly: the plugin still loads, the tools still appear, only the injections do nothing. Emit `plugin:<your-package>`, or don't inject. (This single fact is the entire reason for the 0.1.9 → 0.2.0 upgrade.)
- **The host's strict codec shape can change, and when it does, "dsh won't start".** v0.1.6-alpha.2 changed the typert strict descriptor from `{mode,typeSymbol,schema}` to `{mode,typeSymbol,create}` — **registering throws**, and the user sees dsh fail to boot rather than a plugin error. Probe the host version where you can; at minimum state your compatibility window in the README.
- **Host-level plugin vs dynamic plugin**: a dynamic (in-session) plugin runs inside a restricted sandbox whose `fs` is pinned to the runtime root (`file access denied under workspace-write mode` in our test) — it cannot write `$DSH_HOME`. If you need real Node `fs` and your own tab, you must be a proper plugin in the host composition.
- **You can skip the `@Remote` decorator**: distributing as plain JS means no decorator syntax and no TS build requirement — use `ctx.typert.register(strict descriptors)` with descriptors as a **pure-data** file shared by host and client, so endpoints and wire params cannot drift apart.
- **`cordis.patch.yml`'s entry name must be the package root**: a subpath makes `clientModules` miss `dsh.client`, and the client **silently fails to register** — a very quiet trap worth documenting.
- **There is exactly one way to jump to a session from the client**: `uiWorkspace.openSession`. `sessions.openSubagent` / `sessions.open` were removed from the host; referencing them still compiles and fails at runtime.
- **Prefer official channels over reimplementing them**:
  - light guard reminders → `run.localAgent.inject()` (the host claims them in a batch at the protocol safety boundary; you don't write your own step/end state machine)
  - stall detection → the `subagentTiming` projection's `active.through` (reading a subagent's `session.events` snapshot view goes blind — our length heuristic once misjudged "10 minutes without an event" while it was working fine)
  - accounting → the `tokenUsage` / `sessionStats` projections; when the host renames a key we follow it instead of maintaining a second ledger
  - interruption → the official `SubagentRun.dispose()`
- **Judge on structured fields, don't guess from text**: our first environment-failure detector guessed at error strings; it only became reliable after switching to `tool/result.isError === true` (plus a line-leading `Error` fallback for older hosts).
- **Declare the optional peer of whichever package owns the slot you register into**: put it in `dsh.client.inject`, or you will hit "slot does not exist" whenever load order varies.
- **The truth about workspace isolation keys**: the host's `resolveByPath` is async, so a synchronous plugin call cannot get the UUID — what actually takes effect is the path-derived `slugPath(cwd)`. We rewrote comments and docs to state that as fact and filed the real fix as a TODO instead of insisting on "prefer the UUID".
- **`tsdown` needs two configs**: host / store / descriptors emit ESM `.mjs`, the client emits `__ModuleLoader__.load` format; the two exits are not interchangeable.
- **New: never let an environment failure masquerade as a model failure.** Sandbox / permission / path problems on the host side usually surface as one line inside a tool result; the model retries, then reasons, then hits the output ceiling — what you see is `max-tokens`, and the real cause is the environment. Give yourself a "same tool, same error, repeatedly → stop and name the environment" criterion (ours is `env-unavailable`).

---

## Known limits / what we do not promise

- **web profile only** (the plugin ships a browser-side workbench; the client targets the web platform).
- **"7 stages" is the maximum set of the `full` tier**: design and scaffold are conditional stages that need an explicit flag; `patch` is prd + dev only, with no separate QA / acceptance.
- The global product-line panel is currently **read-only** (no backlog write path).
- The dev stage must end with a verification-evidence block (command + exit code + assertion count + failing-line reference), which the host extracts and keeps. It is an **auditable self-report**, not a formal guarantee — its value is turning "a unilateral claim of all-green" into structured, cross-checkable evidence.
- The circuit-breaker threshold (`FRESH_TOKEN_BUDGET`, 200k default) is still a constant, not a service Config.
- We A/B'd reasoning-effort downgrades for mechanical stages, but the sample is still too small to support a credible savings figure, **so we make no such claim**.
- Every quality gate is a **heuristic criterion**, not a formal proof: the origin, tuning and counterexamples of each one are recorded in the ADRs / benchmarks / devlog, so they are traceable and reproducible.
- Jumping to a subagent session across a parent boundary is limited by the host (currently disabled with a message).
- `runs/` under `$DSH_HOME/teamflow/` has **no TTL yet** (logs do have a forgetting mechanism: the most recent 20 runs per workspace).
- This is a **solo project** — issues and PRs are welcome.
- The package **depends on the DeepSeek Harness host and cannot run standalone** (every `peerDependency` is injected by the host: several `@deepseek-ai/*` packages plus `react`).

---

## Install and requirements

```bash
# from npm
dsh plugin --profile web add dsh-plugin-teamflow

# or from a local directory (during development)
dsh plugin --profile web add file:./plugins/dsh-plugin-teamflow

# a restart is required before it takes effect
dsh --profile web
```

Once installed:

- the model side gains 12 `teamflow_*` tools (`start` / `triage` / `status` / `backlog` / `claim` / `update` / `assign` / `cancel` / `resume` / `pause` / `resume_session` / `merge`);
- the browser gains the "🏭 Team workbench" tab in the session header plus the cross-session global panel in the sidebar;
- backlog and run records are written under `$DSH_HOME/teamflow/<workspace>/`.

**Requirements**: dsh web profile, Node ≥ 22.18, `engines.dsh: ">=0.1.7-alpha.1 <0.2.0"`.

---

## Benchmarks

Same requirement, same baseline, two execution paths — we ran two of these A/Bs, and both the numbers and the post-mortems are reproducible in the repository:

| Benchmark | Date | Size | Result |
|---|---|---|---|
| [pipeline-vs-native.md](https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/benchmarks/pipeline-vs-native.md) | 2026-08-20 | larger (local-persistence rewrite) | pipeline **saved ~39% tokens**, was ~29% slower; functionally equivalent |
| [hold-pipeline-vs-native.md](https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/benchmarks/hold-pipeline-vs-native.md) | 2026-08-27 | small (<300 lines changed) | pipeline **spent 44% more tokens**, 40% slower; but it delivered 470 lines of dedicated tests plus per-AC acceptance, while the native arm never implemented the hold sound (AC-16/17) |

The two point in opposite directions on cost, and they mean the same thing: **what the pipeline spends extra buys acceptance-grade quality** — dedicated tests, per-AC verification and a full document set are exclusive outputs the native arm cannot produce, and the price of not producing them is an unimplemented acceptance item slipping through.

**Both ran on pre-release internal builds (v0.10.x / v0.13)**; the quality-first work added since (cognition bootstrap, QA rework loop, per-requirement task folders) raises tokens and wall-clock further. `docs/benchmarks/` also holds the later comparison measurements and the full post-mortems — **the documents there are the authority on every number and verdict**.

**New: one more document that is not an A/B.** We did a **static, point-by-point comparison** of "TeamFlow vs dsh's built-in Agent Teams (experimental)" — both sides' sources, docs and git facts, **with no end-to-end experiment**. The verdict and the evidence are in the document itself: [teamflow-vs-dsh-builtin-agent-team.md](https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/benchmarks/teamflow-vs-dsh-builtin-agent-team.md).

---

## Links

- Repository: https://github.com/MichaelShii/dsh-plugin-teamflow
- npm: https://www.npmjs.com/package/dsh-plugin-teamflow
- v0.2.0 release notes (bilingual, item-by-item changes and upgrade notes): https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/releases/v0.2.0.md
- Architecture decision records (ADR 0001–0009): https://github.com/MichaelShii/dsh-plugin-teamflow/tree/main/docs/adr
- Benchmarks and post-mortems (every measurement and post-mortem): https://github.com/MichaelShii/dsh-plugin-teamflow/tree/main/docs/benchmarks
- Development log: https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/devlog.md
- TODO and known gaps: https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/TODO.md
- New: host issue filed upstream (Windows sandbox ACL provisioning failure): https://github.com/deepseek-ai/deepseek-harness/discussions/7538
- New: the previous announcement thread (v0.1.8, 2026-09-12): https://github.com/deepseek-ai/deepseek-harness/discussions/6405 — the "intent clarification" feedback in its comments (@tongwoojun / @zweix123) became feature ② (the clarification gate), and the "is there an English translation?" request (@boshk0) is why this post is in English.

> **Consistency note**: every version anchor in this document (`v0.2.0` / `>=0.1.7-alpha.1 <0.2.0` / npm `latest`) was written on **2026-09-23**. The author will not retro-edit it after posting (editing it would turn a historical statement into today's words) — for current facts, trust the repository's `README.md` and `CHANGELOG.md`.
