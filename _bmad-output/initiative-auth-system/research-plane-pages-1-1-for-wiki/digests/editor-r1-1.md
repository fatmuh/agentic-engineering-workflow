# Digest — editor architecture (round 1)
Agent: general-purpose, 10 tool calls, 2026-11-04. Sources: raw.githubusercontent.com makeplane/plane (master) + registry.npmjs.org.
(Verbatim researcher return; lead note: on preview branch the app path prefix is apps/web/ not apps/web/core/, editor version 1.5.0.)

## Claims
- @plane/editor v1.4.3 (master) / v1.5.0 (preview): private workspace package, "Core Editor that powers Plane", tsc+tsdown, ESM, exports ./lib and ./styles.css. [packages/editor/package.json, high, packaging]
- Built on TipTap v2 (^2.22.3 catalog: core, react, starter-kit, pm, html, suggestion + extensions blockquote, character-count, collaboration, document, emoji, heading, image, list-item, mention, placeholder, task-item/list, text, text-align, text-style, underline). [pnpm-workspace.yaml, high, version-compat] → cannot drop into caller's tiptap v3.32; v2→v3 port needed.
- NOT on npm: registry 404 for @plane/editor. [registry.npmjs.org, high, packaging]
- Entangled with monorepo: deps @plane/constants, @plane/hooks, @plane/propel, @plane/types, @plane/ui, @plane/utils (all workspace:*); app passes EditorRefApi, TFileHandler, TServerHandler. [package.json + editor-body.tsx, high, packaging]
- AGPL-3.0 ("license": "AGPL-3.0", SPDX headers). [package.json, high, packaging]
- Pages editor is realtime-collaborative: CollaborativeDocumentEditorWithRef with realtimeConfig (wss://<LIVE>/collaboration), onStateChange sync status, user presence colors. Deps: @hocuspocus/provider 2.15.2, yjs ^13.6.20, y-prosemirror, y-protocols, y-indexeddb, @tiptap/extension-collaboration. [editor-body.tsx, pnpm-workspace.yaml, high/medium, ux-behavior]
- Title = plain TextArea: placeholder "Untitled", maxLength 255 + hover/focus char counter, autoFocus, Enter preventDefault → editorRef.setFocusAtPosition(0), readOnly renders <h6>. [apps/web/.../pages/editor/title.tsx, high, ux-behavior]
- Slash-command menu at packages/editor/src/extensions/slash-commands/ (command-menu.tsx uses @tiptap/suggestion + FloatingOverlay). Items: Text, Heading 1–6, Numbered list, Bulleted list, To-do list, Table, Quote, Code, Callout, Divider, Emoji, Colors, Background colors, Image. Gated per-workspace by disabledExtensions/flaggedExtensions. [high, ux-behavior]
- Core bundle (core-without-props.ts): CustomStarterKit, Emoji, Quote, HorizontalRule, Link, Image+CustomImage, Underline, TextStyle, TaskList/TaskItem, CodeInline, CodeBlock (custom), Table/TableHeader/TableCell/TableRow (custom), Mention, TextAlign, Callout, CustomColor; document-only: WorkItemEmbed. Extensions dir also: custom-list-keymap, enter-key, keymap, trailing-node, unique-id, typography, headings-list, placeholder, side-menu (drag handle), mentions/, emoji/, callout/, code/, custom-image/, image/, work-item-embed/. [high for bundle, medium for unread files, structure]
- Editor chrome: fixed toolbar at apps/web/.../pages/editor/toolbar/{toolbar,root,color-dropdown,options-dropdown}.tsx; TOC/content browser pane; content column max-w-[720px] (1152px full-width mode); AI menu; content-limit banner; version-history editor. [tree + editor-body.tsx, medium, ux-behavior]
- Stack tells: tippy.js ^6.3.7, @floating-ui/react, tiptap-markdown ^0.8.10, lowlight+highlight.js, prosemirror-codemark, linkifyjs, @tiptap/extension-character-count, @tiptap/extension-placeholder. [high presence, version-compat]

## Editor inventory (behavior | Plane location | stock tiptap v3 equiv)
Bold/italic/headings/lists/quote/hr/history | starter-kit.ts | StarterKit v3
To-do lists | task-list/task-item (stock) | Stock
Underline/TextStyle/TextAlign | stock | Stock (v3 StarterKit absorbs several)
Text/background colors | custom-color.ts | Mostly stock (TextStyle+Color), small custom
Slash menu | slash-commands/* | Custom UI over @tiptap/suggestion; rebuild with floating-ui/Base UI
Table | extensions/table/ custom | Stock @tiptap/extension-table v3 + small port
Code block | extensions/code/ + lowlight | Stock code-block-lowlight
Inline code | code-inline + prosemirror-codemark | Stock + custom styling
Callout block | extensions/callout/ | Custom node — hand-write (simple)
Images/upload | image/, custom-image/, TFileHandler | Stock Image + custom upload plumbing
Mentions | mentions/ + useEditorMention | Stock Mention + custom renderer + search backend
Emoji picker | emoji/ + @tiptap/extension-emoji | Stock
Placeholder | placeholder.ts | Stock
Markdown paste | tiptap-markdown dep | Community, v3 compat unverified
Drag handle/side menu | side-menu.ts | Custom (community v3 pkgs exist)
Keymaps/enter/list-keymap | keymap.ts, enter-key.ts, custom-list-keymap/ | Custom
Trailing node/unique-id/typography | trailing-node, unique-id, typography | Community/stock
Realtime collab+presence | collaboration + hocuspocus + realtimeConfig | Stock exts but needs yjs server — infrastructure
Title | title.tsx plain TextArea | Trivial
Fixed toolbar | toolbar/toolbar.tsx | Custom UI
TOC pane | summary/content-browser.tsx | Custom (walk headings)
AI menu | ai/ask-pi-menu.tsx | Custom, Plane-specific
Work-item embeds | work-item-embed/ | Custom, Plane-specific — drop

## Feasibility (cheap → expensive on tiptap v3.32 + React 19 + Next 16)
1. Cheap (stock v3): StarterKit, TaskList/TaskItem, TextAlign, Placeholder, CharacterCount, Link, Image, Table, Mention, Emoji, code-block-lowlight. Title trivial.
2. Cheap-moderate: Callout, colors, trailing-node, typography, drag handle (community).
3. Moderate (UI chrome native rebuild): slash menu, fixed toolbar Plane-style, TOC pane.
4. Moderate-expensive: upload flow plumbing, mentions backend, markdown round-trip.
5. Expensive: realtime collab (yjs + hocuspocus server + presence UI) — Plane's core architecture.
Caveats: no npm package (vendor-and-port impossible without 6 workspace stubs); v2→v3 API port; AGPL on any copied source.
Verdict: 1:1 look-and-feel single-user replica very achievable on stock v3 (1–3). 1:1 architecture incl. collab = server project.

## Leads
slash-commands/command-menu.tsx mechanics; packages/editor/src/index.ts export surface; toolbar.tsx contents; table/ + side-menu.ts; use-editor-flagging.ts; live server app; ce/ vs src/ split; packages/editor/Readme.md

## Not found
Bubble/selection floating toolbar for Pages (unverified; tippy suggests menus); keymap specifics; contents of toolbar.tsx, side-menu.ts, command-menu.tsx internals, table internals, upload handler; use-extended-editor-extensions.ts 404 (moved).
