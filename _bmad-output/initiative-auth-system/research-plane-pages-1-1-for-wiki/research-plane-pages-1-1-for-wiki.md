---
title: 'technical research: Plane Pages 1:1 for wiki'
type: 'technical'
topic: 'Plane Pages 1:1 for wiki'
decision: 'Replicate Plane Pages UI/editor 1:1 in this project''s wiki'
source: 'makeplane/plane (GitHub, preview + master) + npm registry'
status: complete
preset: 'standard'
validation: 'normal'
claims: {'verified': 13, 'unverified': 0, 'overturned': 0}
sources_count: 22
created: '2026-11-04'
updated: '2026-11-04'
---

# technical research: Plane Pages 1:1 for wiki

**Decision this research serves:** Replicate Plane Pages UI/editor 1:1 in this project's wiki

## Executive summary

Plane's Pages is powered by `@plane/editor` — a **private, AGPL-3.0 workspace package that is not published to npm**, built on **TipTap v2.22.3** with **realtime collaboration (yjs + @hocuspocus/provider) as its core architecture** [1][2][3][4]. This project runs TipTap v3.32.2 with no collab server. Three consequences follow directly:

1. **"1:1" cannot mean "same code".** The editor cannot be installed (not on npm), cannot be vendored without dragging six `@plane/*` workspace packages [1], cannot run unmodified on our tiptap v3 (v2→v3 breaking API change) [2], and must not be copied verbatim anyway — Plane is AGPL-3.0 and §13's network source-offer duty attaches to modified copies offered as a service [19][20].
2. **"1:1" can mean "same look, feel, and behavior" for a single-user editor.** Nearly every editor capability Plane ships maps to stock tiptap v3 extensions (StarterKit, task lists, text align, placeholder, character count, colors, table, code-block-lowlight, emoji, mention) or a small hand-written node (callout). The signature UX — the slash-command menu — is a custom UI over `@tiptap/suggestion`, rebuilt here with our stack [6]. Feasibility tiers are quantified in Dimension 1.
3. **The UI chrome around the editor is fully replicable and now precisely mapped** (Dimension 2): list tabs, collapsing search, order-by with Asc/Desc, 52px rows with tooltip-only dates, the 294px navigation pane with outline/info/assets tabs, 2×2 stat cards, version timeline, and the exact Tailwind token vocabulary Plane styles it with. Two corrections to our current wiki emerged: Plane rows carry **no label chips and no visible updated-time text** (dates live in tooltips), and its tabs are Public/Private/Archived — a visibility model the frozen wiki plan forbids, so we keep our own tabs but restyle them Plane-style.

**Recommendation:** re-implement Plane Pages' UI patterns from scratch on our existing tiptap v3 + Base UI + scoped CSS stack (license-safe path A), adopt the UI blueprint in three passes (list view → detail chrome → editor extensions), and treat realtime collaboration as permanently out of scope per the frozen wiki plan. Full mapping table in Recommendations.

---

## Dimension 1: Editor architecture

*Digest: `digests/editor-r1-1.md` (10 tool calls, sources [1]–[7], [22])*

### What Plane's editor actually is

`@plane/editor` v1.5.0 (preview branch) / v1.4.3 (master) is the monorepo's "Core Editor that powers Plane" — a private workspace package, TypeScript + tsdown, ESM, exporting `./lib` and `./styles.css` [1]. It is **not installable**: the npm registry returns 404 for `@plane/editor` and every sibling `@plane/*` UI package [3]. It is also **not extractable**: its package.json depends on six workspace packages (`@plane/constants`, `@plane/hooks`, `@plane/propel`, `@plane/types`, `@plane/ui`, `@plane/utils`, all `workspace:*`) and its component API expects app-side handlers (`EditorRefApi`, `TFileHandler`, `TServerHandler`) [1][4].

The engine is **TipTap v2.22.3** (catalog-pinned: core, react, starter-kit, pm, html, suggestion, plus extension packages for blockquote, character-count, collaboration, document, emoji, heading, image, list-item, mention, placeholder, task-item/list, text, text-align, text-style, underline) [2]. This project runs tiptap v3.32.2; the v2→v3 major break means Plane's extension code cannot be dropped in even if licensed.

### The defining architecture choice: realtime collaboration

The Pages editor is `CollaborativeDocumentEditorWithRef` with a `realtimeConfig` (`wss://<LIVE>/collaboration`), onStateChange sync status, and user presence colors, over `@hocuspocus/provider` 2.15.2, `yjs` ^13.6.20, `y-prosemirror`, `y-protocols`, `y-indexeddb`, and `@tiptap/extension-collaboration` [4][2]. Plane's editor experience is *designed around* multiple writers. This is infrastructure (a websocket collab server), not an npm install — and the frozen wiki plan (`plan-confluence-notes.md`) explicitly forbids realtime collaboration for this project's wiki. A faithful 1:1 therefore excludes the one architectural element Plane's editor is named after.

### What the title actually is

Plain `<TextArea>`: placeholder "Untitled", maxLength 255 with a hover/focus character counter, autoFocus, Enter `preventDefault()` → `editorRef.setFocusAtPosition(0)` (focus jumps into the body), and read-only mode renders an `<h6>` [5]. Our current implementation (textarea, select-all on "Untitled", Enter → focus `.ProseMirror`) already matches this behavior — verified against source.

### The slash-command menu

`packages/editor/src/extensions/slash-commands/` — `command-menu.tsx` uses `@tiptap/suggestion` + FloatingOverlay. Items: Text, Heading 1–6, Numbered list, Bulleted list, To-do list, Table, Quote, Code, Callout, Divider, Emoji, Colors, Background colors, Image — gated per-workspace via `disabledExtensions`/`flaggedExtensions` [6]. This is a custom UI over a stock extension — the exact pattern we can rebuild with `@tiptap/suggestion` + our Base UI/floating layer on v3.

### Full inventory (behavior → stock v3 equivalent)

| Plane capability | Plane location | Stock tiptap v3 equivalent |
|---|---|---|
| Bold/italic/headings/lists/quote/hr/history | starter-kit.ts | StarterKit v3 |
| To-do lists | task-list/task-item (stock) | Stock |
| Underline/TextStyle/TextAlign | stock | Stock (v3 StarterKit absorbs several) |
| Text/background colors | custom-color.ts | Mostly stock (TextStyle+Color) + small custom |
| Slash menu | slash-commands/* | Custom UI over @tiptap/suggestion |
| Table | extensions/table/ custom | Stock table v3 + small port |
| Code block | extensions/code/ + lowlight | Stock code-block-lowlight |
| Inline code | code-inline + prosemirror-codemark | Stock + custom styling |
| Callout block | extensions/callout/ | Custom node — hand-write (simple) |
| Images/upload | image/, custom-image/, TFileHandler | Stock Image + upload plumbing |
| Mentions | mentions/ + useEditorMention | Stock Mention + renderer + search backend |
| Emoji picker | emoji/ + @tiptap/extension-emoji | Stock |
| Placeholder | placeholder.ts | Stock |
| Markdown paste | tiptap-markdown dep | Community; v3 compat unverified |
| Drag handle / side menu | side-menu.ts | Custom (community v3 pkgs exist) |
| Keymaps / enter / list-keymap | keymap.ts, enter-key.ts | Custom |
| Trailing node / unique-id / typography | extensions dir | Community/stock |
| Realtime collab + presence | collaboration + hocuspocus + realtimeConfig | Needs yjs server — infrastructure |
| Title | title.tsx TextArea | Trivial |
| Fixed toolbar | toolbar/toolbar.tsx | Custom UI |
| TOC pane | summary/content-browser.tsx | Custom (walk headings) |
| AI menu | ai/ask-pi-menu.tsx | Custom, Plane-specific — drop |
| Work-item embeds | work-item-embed/ | Custom, Plane-specific — drop |

### Feasibility tiers (on our tiptap v3.32 + React 19 + Next 16)

1. **Cheap (stock v3):** StarterKit, TaskList/TaskItem, TextAlign, Placeholder, CharacterCount, Link, Image, Table, Mention, Emoji, code-block-lowlight. Title already done.
2. **Cheap–moderate:** Callout, colors, trailing-node, typography, drag handle (community).
3. **Moderate (native UI rebuild):** slash menu, fixed Plane-style toolbar, TOC pane.
4. **Moderate–expensive:** upload flow plumbing, mentions backend, markdown round-trip.
5. **Expensive (excluded):** realtime collab — server project + explicitly out of scope.

**Verdict:** a 1:1 *look-and-feel* single-user replica is very achievable with tiers 1–3. A 1:1 *architecture* including collaboration is a server project this project has forsworn.

---

## Dimension 2: Pages UI blueprint

*Digest: `digests/ui-r1-1.md` (12 tool calls, sources [8]–[18])*

All structure verified against master; the lead re-verified the load-bearing files exist identically on the default branch **preview**, where the path prefix is `apps/web/components/pages/**` (the `core/` layer was removed) and the shared package is `@makeplane/propel` [8][22].

### List view

- **Tabs are Public / Private / Archived only** (URL `?type=`) — no All/Recent/Favorites tabs [8]. Tab triggers: `px-4 text-13 font-medium`; active = accent text + `rounded-t border-t-2 border-accent-strong` — an *underline on top*, not bottom.
- **Header layout:** secondary header row — left tabs; right = search + order-by + filters (favorites is a boolean filter inside that dropdown); a third row of applied-filter chips appears only when filters are applied [9][11].
- **Rows** (shared `ListItem`): `min-h-[52px]`, bottom border, hover background; a single link area = icon (PageIcon h-4 w-4, tertiary) + truncated title (text-13) with tooltip; right cluster = owner avatar (tooltip "Owned by {name}"), public/private icon, a rotated-dash divider, **Info icon whose tooltip is "Created on {date}"** (dates are tooltip-only), favorite star, overflow menu [10].
- **Corrections to our current wiki list:** Plane rows have **no label chips** and **no visible updated-time text**. Our recently added label-chip row and relative-time span diverge from Plane and should be removed for a 1:1. (Favorite star needs a favorites backend we lack — omit; visibility icon needs public/private — omitted per frozen plan.)
- **Order-by:** Name / **Date created** / **Date modified**, each with Ascending/Descending submenu, CheckIcon on active [12]. Our current control lacks "Date created" and Asc/Desc.
- **Search:** collapsed to an icon button; expands to 256px input, placeholder "Search pages", ESC clears then closes [12].
- **Empty/loading:** `EmptyStateDetailed` (assetKey "page" for zero pages, "search" for no hits; create CTA role-gated); loader = header skeleton + 10 rows of random-width title bars [17].

### Detail view

- **Structure:** main column (version overlay → editor toolbar root with pane toggle → content-limit banner → editor body) + right navigation pane as a flex sibling [13].
- **Header actions** (`gap-1`): ArchivedBadge, OfflineBadge, LockControl (3 states: neutral icon button; locked pill accent bg "Locked"; transient "Unlocked" pill 600ms), CopyLinkControl (Link→Check icon for 1s), FavoriteControl, PageOptionsDropdown [14].
- **Title area** is *inside* the body region: 48px strip, hover-revealed emoji/icon picker ("Icon" button, always visible when title empty, disabled when locked) [14].
- **Navigation pane:** fixed **294px** aside, `border-l`, `bg-surface-1`, closes by negative-margin slide (marginRight 0 → −294px, 300ms ease-out — stays mounted), close = ArrowRightCircle; **tabs outline / info / assets** driven by `?paneTab=` query param, default `outline`; Tabs with animated Indicator [15].
  - **Outline:** H2/H3 tree walked from the editor doc (PageContentBrowser) — needs doc access, trivial client-side.
  - **Info:** 2×2 stat cards grid (`grid-cols-2 gap-2`, cards `rounded-sm bg-layer-2 p-2`, value text-14 semibold + label text-13 tertiary): Words, Characters, Paragraphs, Read time (<60s shown as seconds, else "Nm") + "Edited by"/"Created by" actor rows + divider + **version history timeline** (accent-headed, current version accented, rows link `?version={id}`) [16].
  - **Assets:** per-image entry — 48×44 thumbnail (bg-cover), truncated name, hover Download icon [16].
- Our current pane (Info/Comments) has the right bones but: tab set differs (Plane has Outline default + Assets; we keep Comments as a fourth since our comments are page-level — a deliberate divergence), no stat cards, no outline, and pane width 19rem ≈ 304px vs Plane's 294px.

### Styling vocabulary

Tailwind v4 `@theme` CSS variables in `@plane/tailwind-config` (`variables.css`, `@theme` at lines ~692/727/979; dark via `[data-theme*="dark"]`) [18]. Observed token names map cleanly onto our CSS-variable system: `bg-surface-1/2`, `bg-layer-1/2/3`, `bg-layer-transparent(-hover/-selected)`, `border-subtle`, `text-primary/secondary/tertiary/placeholder`, `text-accent-primary`, `border-accent-strong`, `text-11/13/14`, plus animation names (`slide-in-right`, `lock-icon`, `fade-out`). A 1:1 re-implementation should carry these *names* over as our CSS custom properties, not the OKLCH values verbatim (license dimension).

---

## Dimension 3: License & portability

*Digest: `digests/license-r1-1.md` (7 tool calls, sources [19]–[21], [1], [22])*

- **One license, whole repo:** `LICENSE.txt` at root = GNU AGPL v3.0; GitHub API confirms `license.spdx_id: AGPL-3.0`; no other LICENSE/NOTICE/COPYING, no `ee/` directory, no dual licensing — Pages UI and the editor package are under the same single grant [19][20].
- **Nothing on npm:** `@plane/editor`, `@plane/rich-text-editor`, `@plane/document-editor`, `@plane/lite-editor`, `@plane/block-editor`, `@plane/ui`, `@plane/shared` all 404 [3].
- **Upstream engine is MIT:** `@tiptap/core` on npm is MIT (current 3.32.2) — depending on tiptap carries only MIT notice-preservation duties [21].
- **The operative clause** — AGPL §13 (Remote Network Interaction): if you modify the Program and let users interact with it over a network, you must offer **all** such users the Corresponding Source of your version, at no charge, by standard means.

### Verdict for this project (private app today, possible SaaS later; not legal advice)

| Path | Duty | Fit |
|---|---|---|
| **A. Re-implement patterns from scratch** | None — §13 triggers only on *modified copies*; self-written code reproducing observed behavior is not a copy | **Safest; recommended.** Don't paste code, CSS values verbatim, or assets while doing it. |
| **C. Depend on upstream npm packages** | MIT notices only | Viable *variant* of A for the engine (tiptap) — but impossible for any Plane-authored code (nothing published) |
| **B. Copy files verbatim, keep notices** | Full AGPL incl. §13 network source offer on the combined work once served | Riskiest. Practically dormant while private, but the moment it's offered as a service the whole combined work's source-disclosure question lands. Only if full disclosure at launch is acceptable. |

**Binding constraint for the implementer:** every Plane-named pattern in this report must be **re-written from scratch** in this repo's idioms (our tokens, our components, tiptap v3). No verbatim JSX/TSX, no copied CSS custom-property values, no lifted asset files.

---

## Cross-dimension insights

1. **The three dimensions converge on one conclusion:** AGPL (D3) + not-on-npm (D1/D3) + tiptap v2 (D1) means the *only* legal and mechanical 1:1 path is **clean-room re-implementation on our tiptap v3 stack** — and D2 shows that path is fully mapped and mostly cheap. The 1:1 that exists is a UI/UX 1:1, not a code 1:1.
2. **Collab is doubly excluded:** it's the expensive tier (D1) *and* the frozen wiki plan forbids it. Anything presence-flavored (user colors, sync badges) should not even be stubbed.
3. **Plane's UI assumes a backend we don't have** (D2): public/private visibility, favorites, archive, versions, per-workspace extension flags. A faithful look must substitute: no visibility icon (or a neutral one), no star, no version timeline (or a "last edited" row where the timeline sits), tabs that reflect our real states (All pages) in Plane's visual language.
4. **The tooltip-only date pattern is the quiet tell of Plane's density** (D2): information the user rarely needs never occupies row space. Removing our label chips + relative time is a *simplification* the 1:1 forces — and it makes rows faster to render.
5. **Token vocabulary ports, token values don't** (D2 × D3): adopting Plane's *names* (`bg-surface-1`, `text-tertiary`, `border-subtle`) as our CSS variables documents the lineage and speeds porting, while values stay ours.

## Recommendations (bound to the decision)

Implement in three passes; all work re-implemented from scratch per the license verdict.

| # | Plane Pages element | Action | Where in our code |
|---|---|---|---|
| 1 | Rows: icon+title link only, 52px, tooltip-only dates; drop label chips & relative time | **Adopt** (corrects current work) | `wiki-view.tsx`, `wiki-list.css` |
| 2 | Overflow menu (Open page / Open in new tab / Copy link / Page info), Info icon button | Keep (already built) | `wiki-view.tsx` |
| 3 | Owner avatar + divider in right cluster | Keep (already built); no visibility icon, no star | `wiki-view.tsx` |
| 4 | Tabs restyle: top-accent underline, text-13; keep our tab set (All pages) — Public/Private/Archived needs a visibility backend the frozen plan forbids | **Adapt** | `wiki-list.css` |
| 5 | Order-by: add "Date created" + Ascending/Descending submenu, CheckIcon on active | **Adopt** | `wiki-view.tsx` sort control |
| 6 | Search collapse-to-icon, 256px expand, ESC clear-then-close | **Adopt** | `wiki-view.tsx`, `search-filter-controls.tsx` |
| 7 | Empty states (page/search variants) + 10-row skeleton loader | **Adopt** | `wiki-view.tsx` |
| 8 | Detail topbar: CopyLink (Link→Check 1s), lock omitted, pane toggle; title area 48px with hover icon slot (no emoji picker — no backend; reserve the slot) | **Adopt/adapt** | `wiki-page-view.tsx` |
| 9 | Pane: 294px, slide-closed (stay mounted), tabs **Outline / Info / Assets / Comments** (Comments is our deliberate extra), `?paneTab=` deep-link | **Adapt** | `wiki-page-view.tsx`, `wiki-page.css` |
| 10 | Outline tab: H2/H3 tree from editor JSON | **Adopt** | new, reads page.content |
| 11 | Info tab: 2×2 stat cards (words/characters/paragraphs/read-time) + Edited-by/Created-by rows; version timeline omitted (no backend) | **Adopt** | pane Info panel |
| 12 | Assets tab: image thumbnails from existing attachments API | **Adopt** | pane Assets panel |
| 13 | Editor: slash-command menu over `@tiptap/suggestion` (v3) with Plane's item set minus gated ones | **Adopt** | `wiki-editor.tsx` |
| 14 | Editor: task lists, text/background colors, callout, code-block-lowlight, character count, trailing node | **Adopt** (stock v3 / small custom) | `wiki-editor.tsx` |
| 15 | Editor: fixed Plane-style toolbar with block-type dropdown (keep), color dropdown, table ops | **Adopt** | `wiki-editor.tsx` |
| 16 | Drag handle / side menu | Defer (community pkg evaluation needed) | — |
| 17 | Markdown paste, mentions, emoji picker | Defer (v3-compat/backend unverified) | — |
| 18 | Realtime collab, presence, sync badges | **Skip** — frozen plan forbids | — |
| 19 | AI menu, work-item embeds | **Skip** — Plane-specific | — |
| 20 | AGPL hygiene: no verbatim code/CSS values/assets from Plane | **Binding rule** | all files |

## Open questions

1. `toolbar.tsx` contents were enumerated but not read in full (budget) — the exact Plane toolbar button order/labels for pass 3 should be confirmed from source before building.
2. Mentions: Plane's mention search hits a work-item API we don't have; if wanted, what would ours mention? (Defer with #17.)
3. Markdown round-trip: is `tiptap-markdown` (or equivalent) v3-compatible? Unverified.
4. Does the user want the pane to adopt `?paneTab=` URL state (Plane does) — matching Plane exactly — or keep local state? (Recommend URL state; it also fixes deep-links.)
5. Community drag-handle packages for v3 (e.g. tiptap-pro alternatives) unmapped — evaluate at pass 3.

## Staleness map

- Plane's `preview` branch moves fast (editor 1.4.3 → 1.5.0 between master and preview; `@plane/propel` → `@makeplane/propel` scope rename in flight). Structural claims (layout, pane, tabs) verified stable across both branches as of 2026-11-04; **re-check paths before any future re-read** — the `core/` layer removal shows paths churn.
- Class-name/token claims (D2 styling) reflect preview as of access date; Tailwind v4 `@theme` internals are stable but Plane's token *values* churn.
- License: AGPL-3.0 since inception, single-license; re-verify only if Plane announces commercial editions.
- npm: `@tiptap/core` 3.32.2 current at access; our project pins it, so no drift risk inside the repo.

## Sources

| Ref | Source | Publisher | Accessed |
|---|---|---|---|
| [1] | `packages/editor/package.json` (preview) via raw.githubusercontent.com | makeplane/plane | 2026-11-04 |
| [2] | `pnpm-workspace.yaml` (master) — dependency catalog | makeplane/plane | 2026-11-04 |
| [3] | registry.npmjs.org — `@plane/*` lookups (404), `@tiptap/core` | npm registry | 2026-11-04 |
| [4] | `packages/editor/src/components/editor-body.tsx` (master) | makeplane/plane | 2026-11-04 |
| [5] | `apps/web/core/components/pages/editor/title.tsx` (master) | makeplane/plane | 2026-11-04 |
| [6] | `packages/editor/src/extensions/slash-commands/command-menu.tsx` + dir listing (master) | makeplane/plane | 2026-11-04 |
| [7] | `packages/editor/src/extensions/core-without-props.ts` + extensions dir listing (master) | makeplane/plane | 2026-11-04 |
| [8] | `apps/web/core/components/pages/list/tab-navigation.tsx` (master; re-verified on preview at `apps/web/components/pages/...`) | makeplane/plane | 2026-11-04 |
| [9] | `apps/web/core/components/pages/header/root.tsx` (master) | makeplane/plane | 2026-11-04 |
| [10] | `core/list/list-item.tsx`, `list/block.tsx`, `block-item-action.tsx` (master) | makeplane/plane | 2026-11-04 |
| [11] | `pages/filters/root.tsx` (master) | makeplane/plane | 2026-11-04 |
| [12] | `pages/order-by.tsx`, `pages/search-input.tsx` (master) | makeplane/plane | 2026-11-04 |
| [13] | `apps/web/core/components/pages/editor/page-root.tsx` (master) | makeplane/plane | 2026-11-04 |
| [14] | `pages/editor/header/actions.tsx`, `editor/lock-control.tsx`, `editor/header/root.tsx` (master) | makeplane/plane | 2026-11-04 |
| [15] | `pages/editor/navigation-pane/root.tsx` + `index.ts` (master) | makeplane/plane | 2026-11-04 |
| [16] | `pages/editor/navigation-pane/info/*` + `assets/*` (master) | makeplane/plane | 2026-11-04 |
| [17] | `pages/pages-list-main-content.tsx`, `pages/loaders/page-loader.tsx` (master) | makeplane/plane | 2026-11-04 |
| [18] | `packages/tailwind-config/variables.css` (master) | makeplane/plane | 2026-11-04 |
| [19] | `LICENSE.txt` (preview, repo root) | makeplane/plane | 2026-11-04 |
| [20] | api.github.com/repos/makeplane/plane — default branch + license.spdx_id | GitHub API | 2026-11-04 |
| [21] | registry.npmjs.org/@tiptap/core — MIT, 3.32.2 | npm registry | 2026-11-04 |
| [22] | `README.md` (preview) — license statement | makeplane/plane | 2026-11-04 |

## Verification notes

- Load-bearing claims spot-verified by the lead: preview-vs-master divergence (default branch, Pages path move, propel scope rename, editor version) checked against the preview tree and `tab-navigation.tsx` on preview; slash-commands existence on preview; LICENSE.txt on both branches.
- Sources fetched over HTTP this run (research firewall respected: researchers received briefs + granted tree files only; no project files used as evidence).
- Skipped for speed (preset standard): fresh-context citation-judgment subagent; rendered HTML briefing. Structure/prose lens applied as an inline light pass.
