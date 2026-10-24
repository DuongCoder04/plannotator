# Changelog

## [Unreleased]

## [0.17.0] - 2026-10-24

### Added
- **Guided Reviews.** An agent reads a pull request or your local changes and splits them into chapters, the core of the change first, and you read them in VS Code's own diff editor: an overview with a diagram and code links, what changed and why for each chapter, chapter and file ticks, CodeLens and the status bar. The Guided Reviews dashboard opens from the activity bar and lists your repositories, local changes and pull requests (works without a folder open). Guides are shared with Plannotator's web app and export as one HTML file.
- **Your agent, over ACP.** Claude Code, Codex, OpenCode, Pi, GitHub Copilot CLI, Cursor, Kiro and Kilo Code, plus any other ACP agent through `plannotator.guides.customAgent`. The agent runs with your own install, login and settings. The ACP adapters for Claude Code, Codex and Pi are installed for you on first use (pinned versions, into the extension's storage, nothing global); turn that off with `plannotator.guides.installAdapters`.
- **Permission requests come to you.** The agent is never blocked by the extension: its requests show in the run with every option it offers, and when your setup holds a run back (a request you turned down, a tool your settings or sandbox blocked), the guide says so and offers a way through. Automatic approval is opt-in (`plannotator.guides.autoApprove`).
- **Ask the agent.** Select lines in a guide diff (or use the file's CodeLens or a chapter's ask box) and ask; the question box opens right under the lines and shows the agent's progress. The answer is the agent's own page, opened beside the diff in a sandboxed tab with no network and no access to VS Code; its links open the code, a symbol or a chapter. Follow-ups continue the same conversation, and answers are saved with the guide and listed under each chapter.
- **Pull requests** need the GitHub CLI (`gh`). Each one opens in a git worktree in the extension's storage, so your checkout is never touched; pull requests from other repositories are cloned there too.

## [0.4.0] - 2026-02-11

### Added
- Custom WebviewPanel with embedded iframe (replaces Simple Browser)
- Cookie persistence across sessions via reverse proxy and virtual cookie jar
- Auto-close panel when plan is approved or feedback is sent
- VS Code notification when panel opens
- Tab icon for Plannotator panel
- Plannotator output channel for diagnostics

### Changed
- Renamed display name from "Plannotator WebView" to "Plannotator"

## [0.1.0] - 2026-02-11

### Added
- Initial release
- Intercept Plannotator browser opens in VS Code integrated terminal
- URI handler for `vscode://plannotator-webview/open?url=...`
- Router shell script for PLANNOTATOR_BROWSER env var
- Configurable URL pattern matching
- Manual URL opening command
