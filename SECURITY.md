# Security Policy

## Reporting a Vulnerability

If you find a security vulnerability in dsh-plugin-teamflow, please report it privately
instead of opening a public issue:

- **Preferred**: GitHub Security Advisory — [Report a vulnerability](https://github.com/MichaelShii/dsh-plugin-teamflow/security/advisories/new)
- **Fallback**: open an issue with the `security` label (if the advisory UI is not available)

Please include:

- The affected version(s)
- A minimal reproduction (requirement input, plugin version, host environment)
- Impact description (e.g. path traversal via `productRoot`/workspace handling, prompt injection
  surfaces, arbitrary command execution through sub-agent tool calls)

## What to expect

- Acknowledgment within 3 business days.
- A fix is targeted for the next release; security fixes are backported to the latest minor
  when practical.

## Scope

This plugin runs as a **host-level plugin inside DeepSeek Harness (dsh)** with real Node `fs`
access — sub-agents it spawns execute commands in the session workspace. That is by-design
(same trust level as the harness itself). The security boundary that matters is:

- **Prompt injection from untrusted requirement text** — requirements are model-generated
  transcripts; the pipeline treats them as data, but sub-agent prompts embed them. Report
  any path where requirement text can escape its delimiters and alter stage instructions.
- **Path handling** — `productRoot`, workspace paths, `docs/teamflow/<folder>` naming
  (`slug` is validated `[a-z0-9-]{3,24}`; anything else you find is in scope).
- **Sub-agent tool abuse** — a compromised sub-agent could `fs`/`exec` in the workspace;
  hardening here is welcome.