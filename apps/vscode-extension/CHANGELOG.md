# Changelog

## [Unreleased]

### Changed
- Guided Reviews: a guide is read in one tab, **Guide**, which is Plannotator's own guide reader (the one the web app and guides.show render) in VS Code's colors and fonts: the overview, then every chapter's text beside its files' diffs on one scrolling page, with a chapter strip at the top. Hovering a name in a diff shows the language server's hover and the definition (and the chapter that changes it); ⌘-click (Ctrl-click) or F12 goes to the definition, in the guide or in the real file beside; Shift+F12 lists the references. Each file has **Open in editor** and **Diff**.
- Guided Reviews: ask about selected lines in the Guide tab's diff, or about a chapter in the box under its text. The answer tab opens beside at once and shows the agent's work; answers are marked on the lines they are about.

### Removed
- Guided Reviews: the chapter side view, reading a guide file by file in VS Code's diff editor, the CodeLens line on guide files and the comment-thread question box. The **Guided Reviews** side bar stays as the guide's outline; right-click **Ask the Agent About This…** stays in VS Code's own diff of a guide's file (a quick input now).

### Added
- Guided Reviews: ask the agent about selected code, a file or a chapter, and read its answer as a page beside the diff (the agent's own HTML, scripts included, in a sandboxed frame; Mermaid drawn by the Guide tab's engine). The guide's own ACP session answers when the agent can load it; answers are saved with the guide and listed under the chapter, with follow-ups in the same conversation. Selected lines (and the file's CodeLens) open the question box right under the lines, as a comment thread that shows the agent's progress and links to the answer.
- Guides view: write a Guided Review of a pull request or your local changes with Claude Code over ACP, watch it build, and read it chapter by chapter in the native diff editor (overview with a Mermaid diagram and code links, chapter and file ticks, CodeLens, status bar). Guides are shared with Plannotator's web app. A pull request's own Claude Code settings and MCP servers are never loaded; guide history off (`PLANNOTATOR_GUIDE_HISTORY=0`) is honored.

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
