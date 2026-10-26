# Plannotator agent guidance

Plannotator's project guidance is split into focused guides under [`docs/agent-guides/`](docs/agent-guides/). Read this file for the project overview and global guardrails, then read the guide relevant to the code or behavior you are changing.

> **Reusing the document UI (theme / markdown / editor / settings / comments / layout) in the commercial Workspaces app? Read [`packages/ui/README.md`](packages/ui/README.md) FIRST.** It explains the published `@plannotator/ui` + `@plannotator/core` packages and the host-override seams a host plugs its own backend into via `configurePlannotatorUI()`. A prior from-scratch reimplementation of this UI broke the app and was reverted. Do not rebuild it or recreate `packages/document-ui`; add a seam to `@plannotator/ui` instead, keep Plannotator's app unchanged, and never delete working code until a human confirms parity in the browser.

## Project

Plannotator is a plan review UI for Claude Code that intercepts `ExitPlanMode` via hooks, letting users approve or request changes with annotated feedback. It also provides code review for git diffs and annotation of arbitrary Markdown files.

Read [`project-and-development.md`](docs/agent-guides/project-and-development.md) for the repository map, runtime overview, development and test rules, build steps, and marketing site.

## Topic guides

- [`environment.md`](docs/agent-guides/environment.md) — supported environment variables and their behavior.
- [`plan-review.md`](docs/agent-guides/plan-review.md) — plan review flow, VS Code Guides, and Pi behavior.
- [`claude-code-mod.md`](docs/agent-guides/claude-code-mod.md) — Claude Code hooks module and its tool behavior.
- [`opencode-t3-and-codex.md`](docs/agent-guides/opencode-t3-and-codex.md) — OpenCode, T3 Code, and Codex integration details.
- [`code-review.md`](docs/agent-guides/code-review.md) — code review flow, Ask AI defaults, and UI behavior.
- [`annotate.md`](docs/agent-guides/annotate.md) — annotate flow and editing behavior.
- [`inbox.md`](docs/agent-guides/inbox.md) — index to the focused Inbox guides.
- [`server-and-storage.md`](docs/agent-guides/server-and-storage.md) — archive, server APIs, plan history, feedback archive, usage counts, and plan diff.
- [`guides-and-shared-ui.md`](docs/agent-guides/guides-and-shared-ui.md) — Guided Reviews and shared data, parser, annotation, sharing, shortcut, and syntax-highlighting behavior.

The `packages/ui/AGENTS.md` file contains additional guidance scoped to `packages/ui/`.
