<!-- Announcement · English · anchored to **v0.2.7** (2026-10-11) · posting platform TBD (GitHub Discussion / external communities; the body assumes no platform)
     **This is the default version to post**; the Chinese one is `show-your-plugin-v0.2.7.zh.md`.
     Suggested title:
       ▶ dsh-plugin-teamflow v0.2.7: confirm what you actually want, before it gets built
         (Lineage: the v0.1.8 title was "dsh-plugin-teamflow：把「一句话需求」跑成一条带质量门禁的多 Agent 研发流水线"; the
          v0.2.0 announcement added the version number. This one keeps the "package + version + verb phrase" shape.)
       · alt [Plugin] TeamFlow v0.2.7 — a PRD confirm sheet, and machine contracts out of your deliverables
     This is the **short** announcement: the 230-line v0.2.0 write-up still lives in `show-your-plugin-v0.2.0.zh.md`
     / `.en.md` for the full product picture; this file only covers **what changed and why it's worth upgrading**.
     Historical v0.1.8 announcement: `github-discussion-show-your-plugin.md` (frozen).
     **Posting history**: v0.1.8 ran in `deepseek-ai/deepseek-harness` Discussions #6405; v0.2.0 has not been posted.
     Every number quoted here can be verified word-for-word in the repository (sources noted inline).
     ➜ Like its predecessors, this file stops being updated once posted; a new announcement gets a new file with
       the version anchoring of its time. -->

[中文](./show-your-plugin-v0.2.7.zh.md) | English

> `dsh plugin --profile web add dsh-plugin-teamflow` → restart `dsh --profile web` and you're set

**Has this happened to you?** You hand an agent a one-line requirement, it finishes, you look at it — and **it isn't what you wanted**. It didn't do anything wrong: you never said. It quietly turned everything you *didn't* say into an assumption, and wrote that assumption into the spec.

**That's what TeamFlow is for.** Say the requirement once, and it spins up a team of sub-agents that runs `requirement → PRD → technical design → parallel development → QA → acceptance`. Every artifact lands on disk as a file, the acceptance verdict follows a contract, failures surface explicitly, and a crashed run can be resumed.

**Current version: v0.2.7** (44 commits / 39 files / +3724 −279). **No breaking changes** — install and restart.

---

## What changed in this version

### ① A PRD confirm sheet: confirm what you want before it gets built

When the pipeline finishes the PRD stage it **stops and asks you** — but only when it genuinely needs your call:

- The requirement involves a **subjective taste item** (visual style / interaction model / persona / how data is stored…) ⇒ it pauses, lays out its assumptions, and waits for you to adjust them;
- It's a pure **information gap** (something with an objective answer, like which library) ⇒ **it does not interrupt** — it proceeds with the recommended value.

There's a deliberate stance behind this: **the gate does not depend on how strong the model is.** Better models will need less clarification over time, but "what the product should look like" is *your* call — the plugin's job is to guide you and lower the cost of understanding, not to silently decide subjective things for you.

> Concretely: the PRD's assumption section now has two kinds of entries — **open facts** and **subjective taste items** — and the confirm sheet only pauses on the latter.

### ② Machine contracts no longer leak into your deliverables

The pipeline used to pass structured data between stages (a state block and an architecture blueprint) as text that **ended up where you could see it** — on subtask cards, in Markdown previews, at the end of delivered documents. A user sent a screenshot: **a wall of raw JSON, right there on screen.**

This version moves both entirely **out of the human-readable channel**:

- The architecture blueprint now goes to a **dedicated file** (it no longer gets appended to `TECHNICAL.md` — on a real run it had occupied **31%** of that document's characters);
- The state block works the same way, and the file contains **plain JSON** — not even wrapper markers;
- Delivered documents (PRD / TECHNICAL / QA-REPORT / ACCEPTANCE) now contain **zero machine markers** — open them in Typora or VS Code and you see clean prose.

### ③ Four resume / checkpoint fixes

- **Could not resume after a confirm-sheet pause** — the checkpoint predicate used a wrong proxy ("all recorded stages are done", which is always false on a zero-stage run);
- **State never refreshed within a run** — the merge function returned a new object and the call site dropped it, so conclusions written by one stage were **invisible** to later stages in the same run;
- **Zero-stage run checkpoint mislocated** — "did nothing" and "did everything" shared one return value, so resuming could **skip requirement clarification and development entirely and run acceptance against an empty PRD**;
- **Task labels called a first attempt a "rerun"** — after a confirm-sheet pause, twelve tasks that had never run were all labelled "rerun", reading like the previous run had crashed.

---

## Upgrading

**No breaking changes** — just upgrade:

```
dsh plugin --profile web add dsh-plugin-teamflow   # or via the in-app plugin marketplace
# restart dsh --profile web (or the desktop app)
```

Two fields were **removed from the public tool schema** (`needConfirm` / `clarifyStrength`) in favour of env vars (`TEAMFLOW_CONFIRM` / `TEAMFLOW_CLARIFY`). If your calls passed them, they are **silently ignored, never an error** — these switches are now driven by the requirement's content, and you don't need to set them.

---

## Links

- Repository: https://github.com/MichaelShii/dsh-plugin-teamflow
- This release (full changelog, bilingual): https://github.com/MichaelShii/dsh-plugin-teamflow/releases/tag/v0.2.7
- Previous announcement (full product picture, 230 lines): [v0.2.0](./show-your-plugin-v0.2.0.en.md)
- Feedback: issues or discussions, either is fine. For bugs, please include `dsh --version` and the plugin version.
