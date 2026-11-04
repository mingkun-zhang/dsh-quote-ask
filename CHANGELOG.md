# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/) while DSH itself is pre-1.0.

## [1.1.2] — 2026-11-04

### Added

- **Copy in the custom selection menu**: right-clicking a transcript selection
  now offers “复制选中文字” before the quote actions. The plugin suppresses the
  native context menu, so without this item the browser's Copy entry was
  unavailable on that selection.

## [1.1.1] — 2026-11-04

### Changed

- Highlight colour changed from blue to bright yellow (light theme 55%,
  dark theme 32% opacity) so it reads like a highlighter marker; the numbered
  badge stays on the plugin accent colour.

## [1.1.0] — 2026-11-04

### Added

- **Source-conversation highlight + number**: every live quote is painted on the
  exact excerpt in its main conversation and carries the same number as its
  chip-panel entry. Removing the quote, consuming the turn, or closing the side
  chat removes the highlight and badge.
- The highlight uses the CSS Custom Highlight API, so the transcript DOM is
  never mutated; ranges are re-anchored from the stored offsets, surrounding
  text, and excerpt text when the transcript re-renders or paginates.
- A small browser harness (`test/highlight-harness.html`) covers quote/remove,
  transcript shifts, side-chat quotes, and numbering.

### Changed

- Side-chat chip panels now show the transcript-wide quote number (main
  attachments first, then side chats) so panels and badges never disagree.

## [1.0.0] — 2026-11-02

### Added

- First public release of **Quote Ask / 引问**.

### Changed

- Renamed the project to **Quote Ask / 引问**; package and repository are now
  `dsh-quote-ask`.
- Internal identifiers moved to the new namespace: HTTP routes
  `/dsh-quote-ask/*`, resource protocol and tab kind `quoteask`, module id
  `dsh-quote-ask`, localStorage keys `dsh-quote-ask.*`, and data directory
  `$DSH_HOME/quote-ask/`.
- One-time client cleanup removes legacy `dsh-side-chat` storage keys, drafts,
  and restored `sidechat` tabs.

## [0.6.3] — 2026-11-02

### Changed

- Quote-panel hint now separates its two clauses with a comma instead of a dot:
  `右键选中新文字可继续添加，点 × 删除该条`.

## [0.6.2] — 2026-11-02

### Changed

- Unified the quote-panel hint for side chats and main-conversation
  attachments: `右键选中新文字可继续添加 · 点 × 删除该条`.

## [0.6.1] — 2026-11-02

### Changed

- “添加至对话” no longer shows a success toast; the quote chip appearing in the
  composer is the feedback.
- Removed the leading quote glyph from the “已选文本片段” chip.

## [0.6.0] — 2026-11-02

### Added

- **“添加至对话”**: the selection context menu now attaches a quote to the next
  turn of the main conversation. The main composer shows the same “已选文本片段”
  chip as a side chat, supports multiple attachments, opens the quote panel on
  hover/click, and lets each quote be removed.
- The Host attaches the quoted context through the model-only system prompt for
  exactly one turn; quotes attached while a turn is already running wait for the
  next turn. Missing turn-end signals are covered by an agent-idle and a
  route-side fallback.
- Main-conversation attachments are cleared on a full DSH restart; a page reload
  keeps them.

## [0.5.4] — 2026-10-24

### Fixed

- Side chats left open when DSH quits are now cleaned up. The Host deletes every
  open side chat on plugin disposal and the startup sweep removes anything left
  by a previous process, so their sessions no longer appear under the ungrouped
  conversation list after a restart.
- The client now purges quote-ask entries, drafts, cleanup records and saved
  right-sidebar `quoteask` tabs when the app starts; restored tabs are closed
  through the sidebar API. A page reload (`Ctrl+R`) keeps them because the Host
  process and sessions are still alive.

## [0.5.3] — 2026-10-20

First public release.

### Added

- Side chat opened from a text selection in the main conversation.
- A new blank scratch session per side chat; no inherited history in the UI.
- Model-only context injection: main-conversation text messages, tool-result
  summaries, and all quotes are written to `context.md` and inserted through a
  system-prompt section scoped to the quote-ask scratch cwd.
- Exact quote anchors: DOM node key, turn, character offsets inside the rendered
  message, surrounding text, and full message text.
- Composer quote chip with a panel listing every quote; the panel clamps to the
  viewport and repositions on resize/scroll.
- Per-quote deletion. The Host regenerates `context.md` and redacts the matching
  occurrence from the main transcript; re-adding the quote restores it.
- Close-time cleanup of the scratch directory, context file, session log,
  projection cache, spill directory, browser draft, and cleanup journal.
- Client-side hiding of the quote-ask row in the conversation list without using
  DSH's archive feature (which blocks model steps).
- In-process finalization of the cleanup journal after 5s/20s, with a boot-time
  sweep as a crash safety net.
- Windows install/uninstall scripts for the DSH Desktop profile.
- Contract tests (`test/verify.mjs`) that run without a live DSH installation.

### Fixed during pre-release testing

- Composer stayed at the top in blank/hero state; it now sits at the bottom.
- Archiving the quote-ask session blocked every model step; replaced with
  client-side list-row hiding.
- A UTF-8 byte-size cap silently discarded Chinese quote-ask context; the reader
  now accepts large context files and the transcript cap is 600k characters.
- Appending a quote could exceed the Host request-body cap and return
  `invalid-body`; the append request now sends only the new quote.
- Panel overflow in fullscreen/resized windows.
