# Changelog

## [Unreleased]

## [0.17.0] - 2026-10-28

### Added
- **Guided Reviews.** An agent reads a pull request or your local changes and splits them into chapters, the core of the change first. You read the guide in one **Guide** tab: an overview with a diagram, then each chapter's explanation beside its files' diffs, on one scrolling page in your VS Code colors and fonts. Hover a name in a diff to see VS Code's own hover, where it is defined, and the chapter that changes it; ⌘-click (Ctrl-click) or F12 goes to the definition, Shift+F12 lists the references. Each file has **Open in editor** and **Diff**. Tick chapters and files as you go. The Guided Reviews dashboard opens from the activity bar and lists your repositories, local changes and pull requests (it works without a folder open); the side bar shows the open guide's outline. Guides are shared with Plannotator's web app and export as one HTML file.
- **Your agent, over ACP.** Claude Code, Codex, OpenCode, GitHub Copilot CLI, Cursor, Kiro and Kilo Code write guides, and any other ACP agent works through `plannotator.guides.customAgent`. Pi is listed but can't write guides yet (its ACP adapter does not pass the guide's tools on to Pi). The agent runs with your own install, sign-in and settings: Claude Code and Codex run the `claude` / `codex` on your PATH (turn off `plannotator.guides.useInstalledCli` to use the copy that comes with the adapter). The ACP adapters for Claude Code, Codex and Pi are installed for you on first use (pinned versions, into the extension's storage, nothing global); turn that off with `plannotator.guides.installAdapters`. When a run ends, anything the agent started (a dev server, a watcher) is stopped with it.
- **Permission requests come to you.** The agent is never blocked by the extension: its requests show in the run with every option it offers, and when your setup holds a run back (a request you turned down, a tool your settings or sandbox blocked), the guide says so and offers a way through. Automatic approval is opt-in (`plannotator.guides.autoApprove`).
- **Ask the agent.** Select lines in a guide's diff (new lines or removed lines) and ask in the box that opens on them, or ask about a chapter in the box under its text. The answer opens beside the guide at once and shows the agent's work; it is the agent's own page, in a sandboxed tab with no network and no access to VS Code, and its links open the code, a symbol or a chapter. Follow-ups continue the same conversation. Answers are saved with the guide and marked on the lines they are about. In VS Code's own diff of a guide's file, right-click **Ask the Agent About This…**.
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
