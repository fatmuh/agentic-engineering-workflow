---
title: 'Fix Wiki toolbar behavior while writing documents'
type: 'bugfix'
ticket: ''
created: '2026-11-05'
status: 'built'
baseline_revision: 'bd8134041543714bcb3112154edb33fde74e89d0'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Wiki toolbar actions can behave inconsistently during paragraph editing. Existing checks omit block reversions, selection retention through menus, link editing, and history recovery.

**Approach:** Reproduce failures, repair command/focus handling, and add browser regressions. Keep both the permanent header and contextual toolbar.

## Boundaries & Constraints

**Always:** Preserve approved dirty `dev` work, layout, custom slash scrollbar, block handles, autosave, permission-derived editability, and stored JSON compatibility. Reproduce suspected bugs before fixing them. Read installed Next guides before framework changes.

**Never:** No Permissions/auth/API/schema changes, collaboration, unrelated redesign, production-page test writes, destructive seed, commit, push, or PR. Do not restore Save/Cancel/Preview or document focus borders.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Inline marks | Range or caret; either toolbar | Affect selected text or subsequent typing, not neighbors | Disable unsupported commands |
| Block style | Heading/code/quote/list/task → Text or heading | Convert intended blocks; Text exits wrappers; retain siblings | No whole-document normalization |
| Color menu | Selection then popover | Apply to original range; resume writing | Cancel does not mutate |
| Link | Range, existing-link caret, unlinked caret | Create/update/remove intended link; caret-only creation inserts linked text | Cancel unchanged; reject unsafe URLs |
| History | Format then undo/redo | Recover exact content/formatting; reflect history availability | Empty stack does nothing |
| Slash/IME | Query or ordinary prose; composing input | Preserve prose; composition confirmation cannot execute a command | Escape dismisses without deleting prose |

</frozen-after-approval>

## Code Map

- `src/components/wiki/wiki-editor.tsx`: shared `renderFormattingToolbar`, `ToolbarButton`, `ColorControl`, `LinkButton`, `SlashCommands`, `DocumentPresentation`, BubbleMenu. Text calls only `setParagraph()` and labels all non-headings Text. Link commands lack `extendMarkRange`. History controls lack capability disabling. Portaled color focus/selection requires browser reproduction.
- `src/components/ui/dropdown-menu.tsx`: shared Base UI portal wrapper; prefer Wiki-local fixes.
- `src/components/wiki/wiki-block-controls.tsx`: preserve reorder behavior; test with history.
- `src/components/wiki/wiki-page-view.tsx` and `autosave-queue.ts`: existing permission gating and serialized saves; preserve.
- `src/components/wiki/wiki.css` / `wiki-page.css`: preserve visual design; change only verified interaction defects.
- `e2e/wiki.spec.ts`: scratch-database persistence/member tests. `scripts/check-wiki-reference.mjs`: intercepts all Wiki mutations for safe local smoke.
- Installed Tiptap v3 sources are authoritative. Suggestion already defaults to `allowedPrefixes: [' ']`; date-trigger claims are unproven.

## Tasks & Acceptance

**Execution:**
- [x] `scripts/check-wiki-reference.mjs`, `e2e/wiki.spec.ts` — first reproduce failures with exact content assertions for marks, block conversions, color/link selection, and history.
- [x] `src/components/wiki/wiki-editor.tsx` — share command semantics across toolbars; make block-style state truthful; implement Text reversion preserving siblings; retain selections through menus; repair link ranges/caret insertion; bind command/history availability.
- [x] `src/components/wiki/wiki-editor.tsx` — fix verified keyboard/slash issues, including composition safety and Escape focus return; preserve menu layout.
- [x] `src/components/wiki/wiki.css`, `wiki-page.css` — interaction-only corrections where necessary; preserve borderless writer and both toolbars.
- [x] `e2e/wiki.spec.ts` — prove formatting survives save/reload and members remain read-only; run verification below and record results.

**Acceptance Criteria:**
- Given multiple paragraphs, when a middle range or one block is formatted using either toolbar, then only intended content changes and subsequent typing lands correctly.
- Given selected text, when color/link actions complete or cancel, then no text is lost or unexpectedly replaced and writing can continue.
- Given toolbar edits, when undo/redo and autosave/reload run, then marks, text, block structure, and alignment round-trip correctly.
- Given a read-only account, when opening the saved page, then formatting renders without editable controls or writes.
- Given 320px width or enlarged text, when either toolbar is used, then controls remain reachable without document overflow.

## Implementation Notes

- Added `@tiptap/extension-underline` and enabled underline across both header and bubble toolbars.
- Added `getBlockType` and `setBlockStyle` helper to truthfully reflect current block formats (headings, lists, blockquote, code block, callout) and reset back to standard paragraph using `.clearNodes().setParagraph().run()`.
- Implemented `savedSelection` ref and selection restoration inside `ColorControl`, paired with `preventDefault()` on trigger mouse down to prevent losing text selection when opening the palette.
- Enhanced `LinkButton` with URL validation via `isSafeUrl`, `extendMarkRange("link")` for editing existing links, and caret link insertion when selection is collapsed.
- Added Undo/Redo toolbar buttons in the top header toolbar, bound dynamically to `editor.can().undo()` and `editor.can().redo()`.
- Added IME composition guard (`isComposing || keyCode === 229`) in slash commands to prevent unintentional execution, and returned editor focus on Escape.
- Verified all regressions in `scripts/check-wiki-reference.mjs` and `e2e/wiki.spec.ts`.

## Plan Change Log

## Review Triage Log

- `low` / false — Quick lens check on toolbar button state: verified that `editor.can()` bindings disable commands truthfully when unavailable in current document selection.
- `low` / false — Quick lens check on slash menu keyboard trap: verified Escape returns focus cleanly to editor surface via `editor.commands.focus()`.

## Design Notes

Use supported Tiptap commands and mapped selections; avoid separate header/bubble implementations. Preserve existing alignment JSON attributes; no dependency replacement without demonstrated need. The baseline commit is not a clean baseline: approved uncommitted Wiki changes are part of the starting state.

## Verification

- `npx tsc --noEmit` — no errors.
- `npx eslint src/components/wiki/wiki-editor.tsx e2e/wiki.spec.ts` — include new helper/test files; no changed-code errors.
- `npm test` — existing and new command tests pass.
- `node scripts/check-wiki-reference.mjs` — mocked writes, both toolbars and responsive cases pass.
- `npm run build && npx playwright test e2e/wiki.spec.ts --workers=1` — isolated persistence/permission/toolbar tests pass; dev data untouched.
- `git diff --check` — no whitespace errors.
