# Contributing

Thanks for considering contributing to TeamFlow! This is a single-repo plugin project with
a small, opinionated codebase — please read this before opening PRs.

## What the project is

`dsh-plugin-teamflow` is a **distributable plugin** for the DeepSeek Harness (dsh) host:
it turns "one-line requirement → multi-agent R&D pipeline" into a host capability
(Cordis service + Web tab + model tools). All repo source is TypeScript/TSX; the package
ships built `lib/` output (host must be built — Node's `strip-types` does not apply under
`node_modules`).

## Environment

- Node ≥ 22.18, pnpm ≥ 11
- **A local dsh profile is required for `typecheck`**: `@deepseek-ai/dsh-*` are host-private
  packages (not on the public registry); their types come from the locally installed host
  copy (`~/.dsh/profiles/node_modules/@deepseek-ai/*`, mapped in `tsconfig.json` `paths`).
  CI runs `test` + `bundle` only, for the same reason.

## Getting started

```bash
pnpm install
pnpm test          # smoke (descriptors/structure/security) + verdict + stages + journal
pnpm bundle        # build client + host → lib/
pnpm typecheck     # needs the local dsh profile types (see above)
```

## Lint gate

`pnpm run lint` (= `pnpm lint`) runs oxlint with `--deny-warnings`, so **warnings are failures**:
the tree is kept at 0 warnings / 0 errors. CI runs the same command before `test` and `bundle`
(`.github/workflows/ci.yml`), so a warning you leave behind also fails your PR. Fix it — don't
silence it with a disable comment.

Note that oxlint walks **untracked files too**: scratch directories left in your working tree can
fail your local run even though CI (which only sees the commit) is green. Commit-time scope is
what counts.

Rules live in `.oxlintrc.json` (`correctness` = error). A few deliberate carve-outs:

- **`catch (e) {}` is intentional best-effort style**, not an accident: `no-unused-vars` is a
  warning with `caughtErrors: none`, so swallowing an error stays legal.
- **`_`-prefixed parameters and variables are exempt** (`argsIgnorePattern`/`varsIgnorePattern: ^_`)
  — use `_name` when a signature forces an unused binding.
- **`no-useless-fallback-in-spread` and `no-new-array` are off on purpose**: `|| {}` fallbacks and
  `new Array(n)` carry a *type* role under `strict: false` duck-typing — narrowing them (e.g. to
  `??`) degrades the consuming call sites and makes `tsc` report errors. They are not style
  preferences, so don't "clean them up".
- `no-constant-condition` is off as well: the QA-rework loop in `host/core/pipeline.ts` is a
  `while (true)` with a bounded `round > QA_REWORK_LIMIT` break and an inline disable. Keep any
  such loop bounded the same way.

## Where things live

```
host/                # TeamflowService + core/* (pipeline, backlog, runner, guard, triage, state…)
client/index.tsx     # 🏭 Team Workspace web tab (hyperscript/preact-style, no JSX build deps)
store.ts             # persistence layer (atomic write / journal serialization), independently testable
descriptors.ts       # Remote descriptors (pure data, shared host/client)
docs/adr/            # design decision records (ADR-0001~0009) — read before touching pipeline internals
AGENTS.md            # maintainer's product memory & engineering conventions (internal, Chinese)
test/                # dependency-free test suites
```

## Conventions

- **Dependency direction**: `types/constants/util` → `prompts`/`core/*` → `index` (facade).
  No reverse/cyclic imports. All prompt text lives in `host/prompts/index.ts`.
- **Prompt language split (by design)**: instruction layer is English; *output contract
  terms* (`基线依赖`/`取代`/`未发现缺陷`/defect-table header/`验收结论`) stay Chinese —
  parsers (`parseAcceptanceVerdict`, `parseDefects`) match those anchors. Don't "unify" the
  language without touching the parsers.
- **No runtime deps beyond the host `ctx`**: `store.ts` uses only `node:fs`; everything else
  is injected by the harness.
- Every behavior change should carry a smoke assertion (`test/smoke.js` source-string
  assertions are the cheap safety net for this codebase).
- **Docs & screenshots**: user-facing behavior changes must touch **both** `README.md` and
  `README.en.md` (they are kept in sync line by line). Screenshots live in `docs/screenshots/`
  and are **split by UI language**: Chinese UI → `docs/screenshots/<name>.png`, English UI →
  `docs/screenshots/en/<name>.png`. Never point the English README at a Chinese screenshot
  (or vice versa) — re-shoot and overwrite; keep each file under ~400 KB and the same viewport
  for both languages.
- Tests must stay dependency-free (no test framework; `node test/*.js`).

## PR workflow

**Branch model**: `main` mirrors the **published release** (kept identical to npm `latest`) and only
receives release merges — it is not a development branch. Day-to-day work accumulates on the current
**release branch** `release-vX.Y.Z` (one per release cycle, long-lived, pushed to the remote; a new one
is cut right after each release).

1. Open an issue first if the change is non-trivial (pipeline stage semantics, state machine,
   persistence format, prompt contracts).
2. **Branch from the latest release branch** (e.g. `release-v0.2.0`) — **not from `main`** — and open
   your PR **against that release branch**. Keep PRs focused — we merge with a real merge commit
   that keeps every commit (we do not squash).
3. CI runs `pnpm lint` + `pnpm test` + `pnpm bundle` on pushes to `main` and `release-*` and on every
   PR; make sure the same three are green locally too.
4. Update `README.md`/`README.en.md` if user-facing, `CHANGELOG.md` for released behavior
   changes, and `AGENTS.md` (maintainer memory) for pipeline-level decisions.

Releases are cut from the release branch: finalise version + `CHANGELOG` + `docs/releases/<v>.md` →
`npm publish` (the manual 2FA node) → PR → merge into `main` **keeping every commit** (no squash) →
annotated tag → GitHub Release → cut the next release branch. See `AGENTS.md` §4 for the exact order.

## License

MIT — see [LICENSE](./LICENSE). By contributing you agree your work is licensed the same way.