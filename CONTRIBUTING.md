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

## Where things live

```
host/                # TeamflowService + core/* (pipeline, backlog, runner, guard, triage, state…)
client/index.tsx     # 🏭 Team Workspace web tab (hyperscript/preact-style, no JSX build deps)
store.ts             # persistence layer (atomic write / journal serialization), independently testable
descriptors.ts       # Remote descriptors (pure data, shared host/client)
docs/adr/            # design decision records (ADR-0001~0008) — read before touching pipeline internals
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
- Tests must stay dependency-free (no test framework; `node test/*.js`).

## PR workflow

1. Open an issue first if the change is non-trivial (pipeline stage semantics, state machine,
   persistence format, prompt contracts).
2. Branch from `main`, keep PRs focused; squash commits on merge.
3. CI runs `pnpm test` + `pnpm bundle`; make sure both are green locally too.
4. Update `README.md`/`README.en.md` if user-facing, `CHANGELOG.md` for released behavior
   changes, and `AGENTS.md` (maintainer memory) for pipeline-level decisions.

## License

MIT — see [LICENSE](./LICENSE). By contributing you agree your work is licensed the same way.