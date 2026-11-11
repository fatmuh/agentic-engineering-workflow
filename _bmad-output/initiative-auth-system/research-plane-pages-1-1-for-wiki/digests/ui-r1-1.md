# Digest — Pages UI blueprint (round 1)
Agent: general-purpose, 12 tool calls, 2026-11-04. Sources: raw.githubusercontent.com makeplane/plane (master) + /tmp/plane-tree.json.
(Lead note: on preview the prefix apps/web/core/components/pages is apps/web/components/pages — structure identical, verified by lead against preview tree + tab-navigation.tsx.)

## Claims
1. Pages tabs = Public / Private / Archived only (URL ?type=); no All/Recent/Favorites tabs. [list/tab-navigation.tsx, high, structure]
2. List header Header SECONDARY: left tabs; right search + order-by + filters; TERNARY row of applied-filter chips only when filters applied. [header/root.tsx, high, structure]
3. pages/header/root.tsx is the LIST header (PagesListHeaderRoot). [high]
4. Row = shared ListItem min-h-52px bottom border → link(icon+title) + right cluster (owner avatar, public/private icon, divider, info tooltip, favorite star, overflow menu). [core/list/list-item.tsx + list/block.tsx + block-item-action.tsx, high, structure]
5. Row has NO label chips, NO visible updated-time text; dates in tooltips ("Created on {date}"). [block-item-action.tsx, high, ux-behavior]
6. Favorites = boolean filter in filters dropdown + FavoriteStar per row. [filters/root.tsx, block-item-action.tsx, high, structure]
7. Sort: Name / Date created / Date modified, each Asc/Desc; search collapses to icon, expands to 256px (placeholder "Search pages", ESC clears-then-closes). [order-by.tsx, search-input.tsx, high, ux-behavior]
8. Detail = main column (version overlay, editor toolbar root w/ pane toggle, content-limit banner, editor body) + right navigation pane flex sibling. [editor/page-root.tsx, high, structure]
9. Detail header actions order: ArchivedBadge, OfflineBadge, LockControl, CopyLinkControl, FavoriteControl, PageOptionsDropdown — gap-1. [header/actions.tsx, high, structure]
10. editor/header/root.tsx = title/emoji area (48px, hover-revealed "Icon" picker), not an actions bar. [high]
11. Lock control 3 states: neutral icon btn; locked pill (accent bg, "Locked"); transient "Unlocked" pill 600ms. [lock-control.tsx, high, ux-behavior]
12. Nav pane: fixed 294px aside, closes by negative right margin slide (not unmount); tabs outline / info / assets via ?paneTab (default outline). [navigation-pane/root.tsx + index.ts, high, structure]
13. Version selection via ?version; accent-headed timeline. [navigation-pane/root.tsx, version-history.tsx, high, ux-behavior]
14. Info panel = 2x2 stat cards (words/characters/paragraphs/read-time) + Edited-by/Created-by rows + version history timeline. [info/*, high, structure]
15. Empty states EmptyStateDetailed assetKey "page" (create CTA role-gated; PRIVATE if tab=private else PUBLIC on create) / "search"; init loader = header skeleton + 10 rows random-width title bars. [pages-list-main-content.tsx, loaders/page-loader.tsx, high, structure]
16. Tokens: Tailwind v4 @theme CSS vars in @plane/tailwind-config (variables.css @theme at 692/727/979, @theme inline label scales; dark via [data-theme*="dark"]). [packages/tailwind-config/*, high, styling]
17. Pane extension system: INavigationPaneExtension triggerParam + width replaces tabs. [navigation-pane/types, high, structure]

## UI blueprint
LIST VIEW:
PagesListView → PagesListHeaderRoot (if pages exist) → Header SECONDARY [Left: PageTabNavigation (Link per tab, px-4 text-13 font-medium, active text-accent-primary + rounded-t border-t-2 border-accent-strong — underline-on-top) | Right: PageSearchInput (collapsed IconButton ghost SearchIcon → expands w-64 rounded-md border-subtle px-2.5 py-1.5, SearchIcon+input+CloseIcon), PageOrderByDropdown (secondary lg, ArrowUp/DownWideNarrow + key label; menu Name|Date created|Date modified + hr + Ascending|Descending, CheckIcon on active), FiltersDropdown(ListFilter h-3, "Filters") → search box + Favorites toggle + Created date + Created by] → [filters applied: Header TERNARY chips + clear-all] → PagesListMainContent → PageLoader | EmptyStateDetailed | ListLayout (Row HUGGING, vertical-scrollbar-lg, h-full overflow-y-auto) → PageListBlock rows.
ROW (block.tsx → list-item.tsx → block-item-action.tsx):
- Row: group flex min-h-[52px] w-full border-b border-subtle py-4 hover:bg-layer-transparent-hover (desktop flex-row gap-5 py-0; mobile stacks)
- ControlLink whole-left: prepend PageIcon h-4 w-4 text-tertiary (or Logo 16 if in_use) + title span.truncate.text-13 with Tooltip
- Right cluster flex gap-4: owner Avatar (Tooltip "Owned by {name}") · Earth/Lock icon (Tooltip Public/Private, text-tertiary) · Minus rotated-90 divider (text-placeholder) · Info icon Tooltip "Created on {date}" · FavoriteStar · PageActions dropdown optionsOrder [open-in-new-tab, copy-link, make-a-copy, toggle-lock, toggle-access, archive-restore, delete]
DETAIL (page-root.tsx):
- main column: PageVersionsOverlay? → PageEditorToolbarRoot (pane toggle + fixed editor toolbar live here) → ContentLimitBanner? → PageEditorBody (collab tiptap)
- Title area (editor/header/root.tsx, inside body region): div h-[48px] items-end + hover-revealed EmojiPicker btn (SmilePlus + "Icon", text-13, hover:bg-layer-1; always visible when title empty; disabled when locked) + logo-picker
- Top-bar actions (header/actions.tsx, div.flex.items-center.gap-1): ArchivedBadge? · OfflineBadge? · LockControl (neutral: Tooltip Lock + size-6 grid icon btn LockKeyhole 3.5 text-secondary hover:bg-layer-1; locked: pill bg-accent-primary/20 px-2 text-accent-primary + "Locked" text-11 animate; unlocked 600ms transient animate-fade-out) · CopyLinkControl (Tooltip Copy link/Copied!, IconButton ghost lg, LinkIcon→CheckIcon 1s, text-success-primary when copied) · FavoriteControl (IconButton ghost lg Star, aria Add to favorites/Remove favorite, yellow fill) · PageOptionsDropdown
NAVIGATION PANE (navigation-pane/root.tsx):
- aside h-full shrink-0 border-l border-subtle bg-surface-1 pt-3.5, width 294px, marginRight 0/-294px slide, transition-all duration-300 ease-out
- close btn: ArrowRightCircle size-3.5 text-secondary hover:text-primary (mb-3.5 px-3.5)
- animate-slide-in-right wrapper → Tabs value=?paneTab default outline: TabsList mx-3.5 Triggers [outline, info, assets] + Tabs.Indicator; Content flex-1 py-2
  - OUTLINE: ScrollArea hover → PageContentBrowser (H2/H3 tree from editor); empty state exists
  - INFO (px-4, scroll): DocumentInfo grid-cols-2 gap-2 → 4 cards rounded-sm bg-layer-2 p-2 (value h6 text-14 semibold; label text-13 text-tertiary) = Words, Characters, Paragraphs, Read time (<60s | Nm) · ActorsInfo: "Edited by" avatar+name+timeAgoShort+" ago"; "Created by" avatar+name+formattedDate (labels text-11 text-tertiary) · divider h-px bg-layer-1 · VersionHistory: label text-11 text-secondary; timeline (w-px bg-layer-3 line, size-6 nodes; current = accent ring + dot; version nodes → Link ?version={id} date+time over avatar+author; active row bg-layer-transparent-selected)
  - ASSETS (mt-5 space-y-4 px-4): per image asset: a.h-12.rounded-sm.border-subtle hover:bg-layer-1 [48x44 thumb bg-cover + name text-13 truncate + hover Download icon size-3 text-11]; empty state exists

## Styling tokens observed
Surfaces: bg-surface-1/2 · bg-layer-1/2/3 · bg-layer-transparent(-hover/-selected). Borders: border-subtle(-1). Text: text-primary/secondary/tertiary/placeholder · text-accent-primary. Accent: border-accent-strong · bg-accent-primary/20,/30,/40. Status: text-success-primary · --color-label-yellow-icon. Type: text-11/13/14. Misc: px-page-x, rounded-sm/md/t, vertical-scrollbar scrollbar-sm/lg, animate-slide-in-right / lock-icon / text-slide-in / fade-out, transition-all duration-300 ease-out|ease-in-out. Dark: @custom-variant dark ([data-theme*="dark"]). Primitives: Header+Left/RightItem (SECONDARY/TERNARY), Row HUGGING, ControlLink, Avatar, FavoriteStar, Loader/Loader.Item, Tabs+Indicator, ScrollArea, Tooltip, IconButton ghost/secondary lg, EmptyStateDetailed, CustomMenu, EmojiPicker/Logo, PageIcon.

## Leads
editor/toolbar/root.tsx (pane toggle + fixed toolbar); summary/content-browser.tsx outline rendering; dropdowns/actions.tsx; variables.css 692-727/979+ exact OKLCH; usePagesPaneExtensions; version/* overlay UI.

## Not found
Contradicts brief hypothesis: NO All/Recent/Favorites tabs; no label chips; no plain-text updated time in rows. api.github.com rate-limited (worked around via tree). Unfetched (budget): logo-picker.tsx, archived/offline/syncing badges, empty-state/*.
