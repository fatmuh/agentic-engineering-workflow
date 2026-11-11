"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  EditorContent,
  useEditor,
  type ChainedCommands,
  type Editor,
  type JSONContent,
  type Range,
} from "@tiptap/react";
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import { BubbleMenu } from "@tiptap/react/menus";
import { WikiBlockControls } from "./wiki-block-controls";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extensions";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TextStyleKit } from "@tiptap/extension-text-style";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { common, createLowlight } from "lowlight";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { TextAlignLeftIcon, TextAlignCenterIcon, TextAlignRightIcon, TextUnderlineIcon, TextStrikethroughIcon, Table01Icon, SmilePlusIcon, LeftToRightListNumberIcon, LeftToRightListBulletIcon, CheckListIcon } from "@hugeicons/core-free-icons";
import {
  Check,
  CodeIcon,
  ImageIcon,
  Link02,
  Paperclip,
  RefreshCw,
  RotateCcw,
  MoreHorizontal,
  BoldIcon,
  ItalicIcon,
} from "@/components/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover } from "@base-ui/react/popover";
import { Button } from "@/components/ui/button-clean";
import { Input } from "@/components/ui/input";
import "./wiki.css";

/**
 * One component, two modes: the editing surface (toolbar + editable ProseMirror
 * document) and the read-only renderer (the same document with `editable:
 * false`).
 *
 * Rendering through an editor instance rather than `dangerouslySetInnerHTML`
 * is the XSS story: ProseMirror builds the DOM from its own schema, so a
 * hand-edited `content` JSONB blob cannot smuggle a script in — unknown node
 * and mark types are dropped instead of rendered.
 *
 * The extension set is the Plane Pages capability list re-implemented on stock
 * tiptap v3 packages (see _bmad-output/.../research-plane-pages-1-1-for-wiki):
 * to-do lists, callouts, text/background colors and syntax-highlighted code.
 * Nothing here is derived from Plane's source — the names follow the observed
 * behavior only.
 */

export interface WikiEditorProps {
  /** The stored tiptap document; null for a page that has never been saved. */
  content: JSONContent | null;
  /** false renders the read-only variant (no toolbar, no handlers). */
  editable?: boolean;
  /** Fired on every document change with the full JSON. */
  onChange?: (doc: JSONContent) => void;
  /** Upload an image and return its `/api/wiki/files/{id}` src. */
  onInsertImage?: (file: File) => Promise<string | null>;
  /** Upload a generic file and return its URL (inserted as a link). */
  onAttachFile?: (file: File) => Promise<string | null>;
  /** False disables uploads and explains why in each control's label/title. */
  storageReady?: boolean;
  uploadHint?: string;
  placeholder?: string;
  /** Document title, placed beneath formatting controls in both modes. */
  documentHeader?: React.ReactNode;
  /** Details toggle, separate from the contextual formatting toolbar. */
  toolbarStart?: React.ReactNode;
}

// Stored in the existing document JSON, so icons and alignment survive saving.
const DocumentPresentation = Extension.create({
  name: "documentPresentation",
  addGlobalAttributes() {
    return [
      { types: ["doc"], attributes: { pageIcon: { default: null, rendered: false } } },
      { types: ["paragraph", "heading"], attributes: { textAlign: {
        default: null,
        parseHTML: element => ["left", "center", "right"].includes(element.style.textAlign) ? element.style.textAlign : null,
        renderHTML: attributes => ["left", "center", "right"].includes(attributes.textAlign) ? { style: `text-align: ${attributes.textAlign}` } : {},
      } } },
    ];
  },
});

// --- callout -----------------------------------------------------------------

/**
 * Tinted block with a leading emoji — Plane's callout, hand-written as a
 * single-attribute node. Wrapping arbitrary block content, so it composes with
 * lists and code inside it.
 */
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      emoji: {
        default: "💡",
        parseHTML: (element) => element.getAttribute("data-emoji") ?? "💡",
        renderHTML: (attributes) => ({ "data-emoji": attributes.emoji }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-callout": "", class: "wiki-callout" }),
      ["span", { class: "wiki-callout-emoji", contenteditable: "false" }, node.attrs.emoji],
      ["div", { class: "wiki-callout-content" }, 0],
    ];
  },
});

// --- slash menu --------------------------------------------------------------

interface SlashItem {
  id: string;
  glyph: string;
  title: string;
  description: string;
  keywords: string[];
  command: (props: { editor: Editor; range: Range }) => void;
}

/** "/" opens the block menu; filtered by title + keywords as you type. */
const SLASH_ITEMS: SlashItem[] = [
  { id: "text", glyph: "¶", title: "Text", description: "Plain paragraph", keywords: ["text", "paragraph", "plain"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).clearNodes().setParagraph().run() },
  { id: "heading1", glyph: "H1", title: "Heading 1", description: "Section title", keywords: ["heading", "title", "h1"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).clearNodes().setHeading({ level: 1 }).run() },
  { id: "heading2", glyph: "H2", title: "Heading 2", description: "Subsection title", keywords: ["heading", "subtitle", "h2"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).clearNodes().setHeading({ level: 2 }).run() },
  { id: "heading3", glyph: "H3", title: "Heading 3", description: "Minor heading", keywords: ["heading", "h3"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).clearNodes().setHeading({ level: 3 }).run() },
  ...([4, 5, 6] as const).map(level => ({
    id: `heading${level}`, glyph: `H${level}`, title: `Heading ${level}`, description: "", keywords: ["heading", `h${level}`],
    command: ({ editor, range }: { editor: Editor; range: Range }) => editor.chain().focus().deleteRange(range).clearNodes().setHeading({ level }).run(),
  })),
  { id: "numbered", glyph: "1.", title: "Numbered list", description: "Ordered list", keywords: ["number", "ordered", "list"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run() },
  { id: "bullet", glyph: "•", title: "Bulleted list", description: "Unordered list", keywords: ["bullet", "list", "unordered"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run() },
  { id: "todo", glyph: "☑", title: "To-do list", description: "Track tasks with checkboxes", keywords: ["todo", "task", "check", "checkbox"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run() },
  { id: "quote", glyph: "❝", title: "Quote", description: "Captured quotation", keywords: ["quote", "blockquote", "citation"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run() },
  { id: "callout", glyph: "💡", title: "Callout", description: "Highlight with an emoji accent", keywords: ["callout", "info", "note", "highlight", "emoji"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleWrap("callout").run() },
  { id: "code", glyph: "{ }", title: "Code", description: "Syntax-highlighted block", keywords: ["code", "snippet", "codeblock"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run() },
  { id: "divider", glyph: "—", title: "Divider", description: "Horizontal rule", keywords: ["divider", "rule", "hr", "line"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run() },
  { id: "table", glyph: "▦", title: "Table", description: "3×3 grid with a header row", keywords: ["table", "grid", "rows"],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
];

interface SlashMenuState {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  rect: { left: number; top: number; bottom: number } | null;
  /** Highlighted row — ArrowUp/Down and hover move it, Enter runs it. */
  index: number;
}

/**
 * The suggestion plugin owns the menu: its render() closure is the single
 * source of truth (items, highlighted row, rect), and React only mirrors what
 * it publishes. That keeps keys, clicks and renders from racing each other —
 * there is no second copy of the state to go stale.
 */
const SlashCommands = Extension.create({
  name: "slashCommands",

  addOptions() {
    return {
      onStateChange: () => {},
    };
  },

  addProseMirrorPlugins() {
    const { onStateChange } = this.options;
    const editor = this.editor;
    return [
      Suggestion({
        editor: this.editor,
        char: "/",
        items: ({ query }) => {
          const needle = query.toLowerCase();
          if (!needle) return SLASH_ITEMS;
          return SLASH_ITEMS.filter((item) =>
            item.title.toLowerCase().includes(needle) || item.keywords.some((keyword) => keyword.includes(needle))
          );
        },
        // Selection is driven here (Enter/click); the plugin-level `command`
        // option is intentionally left unset — v3 would otherwise pick
        // items[0] on any key this renderer does not claim.
        render: () => {
          let current: SlashMenuState | null = null;
          const build = (props: SuggestionProps<SlashItem>, fallbackRect: SlashMenuState["rect"]): SlashMenuState => {
            const rect = props.clientRect?.() ?? fallbackRect;
            return {
              items: props.items as SlashItem[],
              command: (item) => item.command({ editor: props.editor, range: props.range }),
              rect: rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null,
              index: 0,
            };
          };
          return {
            onStart: (props) => {
              current = build(props, null);
              onStateChange(current);
            },
            onUpdate: (props) => {
              current = build(props, current?.rect ?? null);
              onStateChange(current);
            },
            onExit: () => {
              current = null;
              onStateChange(null);
            },
            onKeyDown: ({ event }) => {
              if (event.isComposing || (event as unknown as { keyCode: number }).keyCode === 229) {
                return false;
              }
              if (!current || current.items.length === 0) return false;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                current = { ...current, index: (current.index + 1) % current.items.length };
                onStateChange(current);
                return true;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                current = { ...current, index: (current.index - 1 + current.items.length) % current.items.length };
                onStateChange(current);
                return true;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const state = current;
                current = null;
                onStateChange(null);
                state.command(state.items[state.index] ?? state.items[0]);
                return true;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                current = null;
                onStateChange(null);
                editor.commands.focus();
                return true;
              }
              return false;
            },
          };
        },
      }),
    ];
  },
});

// --- editor ------------------------------------------------------------------

export function WikiEditor({
  content,
  editable = false,
  onChange,
  onInsertImage,
  onAttachFile,
  storageReady = false,
  uploadHint = "Storage is not configured",
  placeholder = "Write something, or attach a file…",
  documentHeader,
  toolbarStart,
}: WikiEditorProps) {
  // Toolbar active-states must follow the selection. shouldRerenderOnTransaction
  // is flagged for removal upstream, so this bumps a counter on the same events
  // instead — same effect, no deprecated option.
  const [, bump] = useReducer((count: number) => count + 1, 0);
  const [uploading, setUploading] = useState(false);
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  // Keep the popover outside both toolbars so it survives selection-toolbar blur.
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuContainer = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => { menuContainer.current?.remove(); menuContainer.current = null; }, []);
  function getMenuContainer() {
    if (!menuContainer.current) {
      menuContainer.current = document.createElement("div");
      document.body.append(menuContainer.current);
    }
    return menuContainer.current;
  }

  // Built ONCE: useEditor re-instantiates the whole editor when its deps
  // change, and an inline array (new identities every render) would recreate
  // ProseMirror on every parent render — which fires an update, which re-renders
  // the parent, which… #185 maximum update depth. The deps array stays EMPTY:
  // content is read at creation (mode flips remount via `key` upstream) and
  // editable is applied by the effect below. setSlashMenu is a stable setter,
  // safe to close over.
  const extensions = useMemo(
    () => [
      // link and codeBlock are switched off here and registered explicitly
      // below, so StarterKit's copy is not registered twice under the same name.
      StarterKit.configure({ link: false, codeBlock: false }),
      Link.configure({ openOnClick: false, autolink: true }),
      Image,
      Placeholder.configure({ placeholder, showOnlyCurrent: true, includeChildren: true }),
      TableKit.configure({ table: { resizable: true } }),
      TaskList,
      TaskItem.configure({
        nested: true,
        onReadOnlyChecked: () => false,
      }),
      TextStyleKit,
      DocumentPresentation,
      CodeBlockLowlight.configure({ lowlight: createLowlight(common) }),
      Callout,
      SlashCommands.configure({ onStateChange: setSlashMenu }),
    ],
    [placeholder]
  );

  const editor = useEditor({
    extensions,
    content: content ?? undefined,
    editable,
    // SSR safety: ProseMirror measures the DOM at construction, which would
    // otherwise differ between server and client markup.
    immediatelyRender: false,
    editorProps: {
      handleKeyDown: (view, event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          const { state } = view;
          const { $from } = state.selection;
          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d);
            if (node.type.name === "taskItem") {
              event.preventDefault();
              const pos = $from.before(d);
              view.dispatch(
                state.tr.setNodeMarkup(pos, undefined, {
                  ...node.attrs,
                  checked: !node.attrs.checked,
                })
              );
              return true;
            }
          }
        }
        if (event.altKey && event.key === "F10") {
          const control = document.querySelector<HTMLSelectElement>(".wiki-selection-toolbar select") ?? document.querySelector<HTMLSelectElement>(".wiki-editor-topbar select");
          if (control && control.getBoundingClientRect().width) {
            event.preventDefault();
            control.focus();
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor: current }) => {
      onChange?.(current.getJSON());
      bump();
    },
    onSelectionUpdate: bump,
  });

  // `editable` is read once at construction, so a mode flip has to be applied.
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  /** Shared upload path: hand the file to the caller, then insert the URL. */
  async function upload(
    file: File,
    send: (file: File) => Promise<string | null>,
    insert: (url: string) => void
  ): Promise<void> {
    if (!storageReady) return;
    setUploading(true);
    try {
      const url = await send(file);
      if (url) insert(url);
    } finally {
      setUploading(false);
    }
  }

  function pickImage(): void {
    imageInput.current?.click();
  }

  function pickFile(): void {
    fileInput.current?.click();
  }

  if (!editable) {
    return (
      <div className="wiki-prose" data-readonly="true">
        {/* Plane keeps the toolbar root mounted in view mode too — the pane
            toggle stays reachable while reading. */}
        <div className="wiki-editor-topbar" data-readonly="true">
          <div className="wiki-editor-topbar-side">{toolbarStart}</div>
        </div>
        <div className="wiki-document-body">
          {editor?.state.doc.attrs.pageIcon && <div className="wiki-page-icon-display">{editor.state.doc.attrs.pageIcon}</div>}
          {documentHeader}
          <EditorContent editor={editor} />
        </div>
      </div>
    );
  }

  const blockTools = (<>
        <ToolbarButton editor={editor} label="Ordered list" active={(e) => e.isActive("orderedList")} disabled={!editor?.can().toggleOrderedList()} onClick={(chain) => chain.toggleOrderedList().run()} icon={<HugeiconsIcon icon={LeftToRightListNumberIcon} size={14} />} />
        <ToolbarButton editor={editor} label="Bullet list" active={(e) => e.isActive("bulletList")} disabled={!editor?.can().toggleBulletList()} onClick={(chain) => chain.toggleBulletList().run()} icon={<HugeiconsIcon icon={LeftToRightListBulletIcon} size={14} />} />
        <ToolbarButton editor={editor} label="To-do list" active={(e) => e.isActive("taskList")} disabled={!editor?.can().toggleTaskList()} onClick={(chain) => chain.toggleTaskList().run()} icon={<HugeiconsIcon icon={CheckListIcon} size={14} />} />
        <ToolbarButton editor={editor} label="Quote" active={(e) => e.isActive("blockquote")} disabled={!editor?.can().toggleBlockquote()} onClick={(chain) => chain.toggleBlockquote().run()} text="❝" />
        <ToolbarButton editor={editor} label="Code block" active={(e) => e.isActive("codeBlock")} disabled={!editor?.can().toggleCodeBlock()} onClick={(chain) => chain.toggleCodeBlock().run()} icon={<CodeIcon className="size-3.5" />} />
        <ToolbarButton
          editor={editor}
          label="Insert table"
          disabled={!editor?.can().insertTable({ rows: 3, cols: 3, withHeaderRow: true })}
          onClick={(chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          icon={<HugeiconsIcon icon={Table01Icon} size={14} />}
        />
        <ToolbarButton
          editor={editor}
          label={uploadButtonLabel("Insert image", storageReady, uploading)}
          icon={<ImageIcon className="size-3.5" />}
          disabled={!storageReady || uploading}
          title={storageReady ? undefined : uploadHint}
          onClick={pickImage}
        />

  </>);

  const renderFormattingToolbar = (contextual = false) => {
    const isMoreActive = editor
      ? Boolean(
          editor.isActive("code") ||
          editor.isActive("callout") ||
          (contextual && (
            editor.isActive("orderedList") ||
            editor.isActive("bulletList") ||
            editor.isActive("taskList") ||
            editor.isActive("blockquote") ||
            editor.isActive("codeBlock")
          ))
        )
      : false;

    return (
      <div
        className="wiki-formatting-toolbar"
        role="group"
        aria-label={contextual ? "Selection formatting" : "Formatting"}
      >
        {!contextual && (
          <>
            <ToolbarButton
              editor={editor}
              label="Undo"
              disabled={!editor?.can().undo()}
              onClick={(chain) => chain.undo().run()}
              icon={<RotateCcw className="size-3.5" />}
            />
            <ToolbarButton
              editor={editor}
              label="Redo"
              disabled={!editor?.can().redo()}
              onClick={(chain) => chain.redo().run()}
              icon={<RefreshCw className="size-3.5" />}
            />
            <ToolbarDivider />
          </>
        )}
        <select
          className="wiki-block-select"
          aria-label="Text style"
          disabled={!editor}
          value={getBlockType(editor)}
          onChange={(event) => {
            if (!editor) return;
            setBlockStyle(editor, event.target.value);
          }}
        >
          <option value="text">Text</option>
          <option value="1">Heading 1</option>
          <option value="2">Heading 2</option>
          <option value="3">Heading 3</option>
          <option value="4">Heading 4</option>
          <option value="5">Heading 5</option>
          <option value="6">Heading 6</option>
          <option value="bulletList">Bullet list</option>
          <option value="orderedList">Numbered list</option>
          <option value="taskList">To-do list</option>
          <option value="blockquote">Quote</option>
          <option value="codeBlock">Code block</option>
          <option value="callout">Callout</option>
        </select>
        <ToolbarDivider />
        <LinkButton editor={editor} expanded={linkDraft !== null} onOpen={anchor => {
          if (!editor) return;
          const { from, to } = editor.state.selection;
          // Capture the visible trigger rect: the contextual toolbar hides on
          // input focus, so anchoring to its live DOM would jump off-screen.
          const rect = anchor.getBoundingClientRect();
          setLinkDraft({
            url: (editor.getAttributes("link").href as string | undefined) ?? "https://",
            range: { from, to },
            existing: editor.isActive("link"),
            anchor: contextual ? { getBoundingClientRect: () => rect } : anchor,
          });
        }} />
        <ToolbarDivider />
        <ColorControl editor={editor} kind="text" />
        <ColorControl editor={editor} kind="background" />
        <ToolbarDivider />
        <ToolbarButton
          editor={editor}
          label="Bold"
          active={(e) => e.isActive("bold")}
          disabled={!editor?.can().toggleBold()}
          onClick={(chain) => chain.toggleBold().run()}
          icon={<BoldIcon className="size-3.5" />}
        />
        <ToolbarButton
          editor={editor}
          label="Italic"
          active={(e) => e.isActive("italic")}
          disabled={!editor?.can().toggleItalic()}
          onClick={(chain) => chain.toggleItalic().run()}
          icon={<ItalicIcon className="size-3.5" />}
        />
        <ToolbarButton
          editor={editor}
          label="Underline"
          active={(e) => e.isActive("underline")}
          disabled={!editor?.can().toggleUnderline()}
          onClick={(chain) => chain.toggleUnderline().run()}
          icon={<HugeiconsIcon icon={TextUnderlineIcon} size={14} />}
        />
        <ToolbarButton
          editor={editor}
          label="Strikethrough"
          active={(e) => e.isActive("strike")}
          disabled={!editor?.can().toggleStrike()}
          onClick={(chain) => chain.toggleStrike().run()}
          icon={<HugeiconsIcon icon={TextStrikethroughIcon} size={14} />}
        />
        <ToolbarDivider />
        {(["left", "center", "right"] as const).map((align, index) => (
          <ToolbarButton
            key={align}
            editor={editor}
            label={`Align ${align}`}
            active={(e) => e.isActive({ textAlign: align })}
            onClick={(chain) => {
              chain
                .command(({ state, tr }) => {
                  const { from, to } = state.selection;
                  state.doc.nodesBetween(from, to, (node, pos) => {
                    if (node.type.name === "paragraph" || node.type.name === "heading") {
                      tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: align });
                    }
                  });
                  return true;
                })
                .run();
            }}
            icon={
              <HugeiconsIcon
                icon={[TextAlignLeftIcon, TextAlignCenterIcon, TextAlignRightIcon][index]}
                size={14}
              />
            }
          />
        ))}
        {!contextual && (
          <>
            <ToolbarDivider />
            {blockTools}
          </>
        )}
        <details className="wiki-toolbar-more" data-has-active={isMoreActive ? "true" : undefined}>
          <summary
            aria-label="More formatting options"
            title="More formatting options"
            className="wiki-toolbar-button"
            data-active={isMoreActive ? "true" : undefined}
          >
            <MoreHorizontal className="size-3.5" />
            {isMoreActive && <span className="wiki-toolbar-more-dot" aria-hidden="true" />}
          </summary>
          <div className="wiki-toolbar-extra" role="group" aria-label="More formatting">
            {contextual && blockTools}
            {contextual && (
              <div className="flex items-center gap-1 border-b border-border pb-1 mb-1">
                <ToolbarButton
                  editor={editor}
                  label="Undo"
                  disabled={!editor?.can().undo()}
                  onClick={(chain) => chain.undo().run()}
                  icon={<RotateCcw className="size-3.5" />}
                />
                <ToolbarButton
                  editor={editor}
                  label="Redo"
                  disabled={!editor?.can().redo()}
                  onClick={(chain) => chain.redo().run()}
                  icon={<RefreshCw className="size-3.5" />}
                />
              </div>
            )}
            <ToolbarMenuOption
              editor={editor}
              label="Inline code"
              active={(e) => e.isActive("code")}
              disabled={!editor?.can().toggleCode()}
              onClick={(chain) => chain.toggleCode().run()}
              icon={<span className="font-mono text-xs">&lt;/&gt;</span>}
            />
            <ToolbarMenuOption
              editor={editor}
              label="Callout"
              active={(e) => e.isActive("callout")}
              disabled={!editor?.can().toggleWrap("callout")}
              onClick={(chain) => chain.toggleWrap("callout").run()}
              icon={<span className="text-sm leading-none">💡</span>}
            />
            <ToolbarMenuOption
              editor={editor}
              label={uploadButtonLabel("Attach file", storageReady, uploading)}
              disabled={!storageReady || uploading}
              title={storageReady ? undefined : uploadHint}
              onClick={pickFile}
              icon={<Paperclip className="size-3.5" />}
            />
          </div>
        </details>
      </div>
    );
  };

  return (
    <div className="wiki-prose" data-readonly="false">
      <div className="wiki-editor-topbar">
        {renderFormattingToolbar()}
        <div className="wiki-editor-topbar-side">{toolbarStart}</div>
      </div>
      {editor && <BubbleMenu editor={editor} appendTo={getMenuContainer} updateDelay={0}
        options={{ placement: "top", strategy: "fixed", offset: 10, flip: true, shift: { padding: 8 } }}
        className="wiki-selection-toolbar"
      >
        {renderFormattingToolbar(true)}
      </BubbleMenu>}

      <div className="wiki-document-body">
        <PageIconControl editor={editor} />
        {documentHeader}
        <WikiBlockControls editor={editor}><EditorContent editor={editor} /></WikiBlockControls>
      </div>

      <SlashMenuView state={slashMenu} />
      {linkDraft && editor && (
        <LinkPopover editor={editor} draft={linkDraft} onClose={() => setLinkDraft(null)} />
      )}

      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file && onInsertImage) {
            void upload(file, onInsertImage, (url) =>
              editor?.chain().focus().setImage({ src: url }).run()
            );
          }
        }}
      />
      <input
        ref={fileInput}
        type="file"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file && onAttachFile) {
            void upload(file, onAttachFile, (url) =>
              editor
                ?.chain()
                .focus()
                .insertContent({
                  type: "text",
                  text: file.name,
                  marks: [{ type: "link", attrs: { href: url } }],
                })
                .run()
            );
          }
        }}
      />
    </div>
  );
}

function SlashMenuView({ state }: { state: SlashMenuState | null }) {
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const caret = state?.rect;
    if (!menu || !caret) return;
    const position = () => {
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const gap = 6;
      const inset = 8;
      const below = Math.max(0, top + height - inset - caret.bottom - gap);
      const above = Math.max(0, caret.top - gap - top - inset);
      const desired = Math.min(320, menu.scrollHeight + 2);
      const upward = below < desired && above > below;
      menu.style.maxHeight = `${Math.min(320, upward ? above : below)}px`;
      const rect = menu.getBoundingClientRect();
      const rtl = getComputedStyle(document.documentElement).direction === "rtl";
      const preferredLeft = rtl ? caret.left - rect.width : caret.left;
      menu.style.left = `${Math.max(left + inset, Math.min(preferredLeft, left + width - inset - rect.width))}px`;
      menu.style.top = `${Math.max(top + inset, Math.min(upward ? caret.top - gap - rect.height : caret.bottom + gap, top + height - inset - rect.height))}px`;
    };
    position();
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [state]);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const selected = menu?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!menu || !selected) return;
    const row = selected.getBoundingClientRect();
    const viewport = menu.getBoundingClientRect();
    if (row.top < viewport.top + 4) menu.scrollTop -= viewport.top + 4 - row.top;
    else if (row.bottom > viewport.bottom - 4) menu.scrollTop += row.bottom - viewport.bottom + 4;
  }, [state?.index]);
  if (!state || state.items.length === 0 || !state.rect) return null;
  const index = state.index;
  // Portaled to body: the workspace sets container-type (layout containment),
  // which would otherwise turn it into the containing block for position:fixed
  // and offset viewport-relative caret coordinates. State only exists after
  // client-side typing, so the portal never runs during SSR.
  return createPortal(
    <div ref={menuRef} className="wiki-slash-menu custom-scrollbar" role="listbox" aria-label="Insert blocks">
      {state.items.map((item, position) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={position === index}
          className="wiki-slash-item"
          // Clicks run the same command Enter would; keyboard focus stays in
          // the editor either way.
          onMouseDown={event => event.preventDefault()}
          onClick={() => state.command(item)}
        >
          <span className="wiki-slash-glyph" aria-hidden="true">{item.glyph}</span>
          <span className="wiki-slash-text">
            <span className="wiki-slash-title">{item.title}</span>
          </span>
        </button>
      ))}
    </div>,
    document.body
  );
}

function uploadButtonLabel(base: string, storageReady: boolean, uploading: boolean): string {
  if (!storageReady) return `${base} (storage not configured)`;
  return uploading ? `${base} (uploading…)` : base;
}

const PAGE_ICONS = ["📄", "📚", "📝", "💡", "🚀", "🎯", "📌", "✨", "🛠️", "📊", "🗂️", "🌱"];

function PageIconControl({ editor }: { editor: Editor | null }) {
  const icon = editor?.state.doc.attrs.pageIcon as string | null;
  const setIcon = (value: string | null) => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setDocAttribute("pageIcon", value));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<button type="button" className="wiki-page-icon-control" aria-label="Choose page icon" disabled={!editor} />}>
        {icon ? <span className="wiki-page-icon-display">{icon}</span> : <><HugeiconsIcon icon={SmilePlusIcon} size={16} /> Icon</>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <div className="wiki-page-icon-grid" role="group" aria-label="Page icons">
          {PAGE_ICONS.map(value => <button key={value} type="button" aria-label={`Use ${value} icon`} aria-pressed={icon === value} onClick={() => setIcon(value)}>{value}</button>)}
        </div>
        {icon && <button type="button" className="wiki-color-default" onClick={() => setIcon(null)}>Remove icon</button>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- toolbar -----------------------------------------------------------------

function getBlockType(editor: Editor | null): string {
  if (!editor) return "text";
  for (const level of [1, 2, 3, 4, 5, 6] as const) {
    if (editor.isActive("heading", { level })) return String(level);
  }
  if (editor.isActive("bulletList")) return "bulletList";
  if (editor.isActive("orderedList")) return "orderedList";
  if (editor.isActive("taskList")) return "taskList";
  if (editor.isActive("blockquote")) return "blockquote";
  if (editor.isActive("codeBlock")) return "codeBlock";
  if (editor.isActive("callout")) return "callout";
  return "text";
}

function setBlockStyle(editor: Editor, value: string) {
  const chain = editor.chain().focus();
  if (value === "text") {
    chain.clearNodes().setParagraph().run();
  } else if (["1", "2", "3", "4", "5", "6"].includes(value)) {
    chain.clearNodes().setHeading({ level: Number(value) as 1 | 2 | 3 | 4 | 5 | 6 }).run();
  } else if (value === "bulletList") {
    chain.toggleBulletList().run();
  } else if (value === "orderedList") {
    chain.toggleOrderedList().run();
  } else if (value === "taskList") {
    chain.toggleTaskList().run();
  } else if (value === "blockquote") {
    chain.toggleBlockquote().run();
  } else if (value === "codeBlock") {
    chain.toggleCodeBlock().run();
  } else if (value === "callout") {
    chain.toggleWrap("callout").run();
  }
}

function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (/^(javascript|vbscript|data):/i.test(trimmed)) return false;
  if (/^(\/|\.\/|\.\.\/|#|\?)/.test(trimmed)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return /^(https?:|mailto:|tel:)/i.test(trimmed);
  }
  return true;
}

interface ToolbarButtonProps {
  editor: Editor | null;
  label: string;
  /** Receives an already-focused chain, so every button body is one .run(). */
  onClick: (chain: ChainedCommands) => void;
  active?: (editor: Editor) => boolean;
  icon?: React.ReactNode;
  text?: string;
  bold?: boolean;
  italic?: boolean;
  struck?: boolean;
  mono?: boolean;
  disabled?: boolean;
  title?: string;
}

function ToolbarButton({
  editor,
  label,
  onClick,
  active,
  icon,
  text,
  bold,
  italic,
  struck,
  mono,
  disabled,
  title,
}: ToolbarButtonProps) {
  const isActive = editor ? Boolean(active?.(editor)) : false;
  const buttonDisabled = disabled || !editor;
  return (
    <button
      type="button"
      className="wiki-toolbar-button inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      aria-label={label}
      title={title ?? label}
      aria-pressed={active ? isActive : undefined}
      data-active={isActive ? "true" : "false"}
      disabled={buttonDisabled}
      onMouseDown={event => event.preventDefault()}
      onClick={() => {
        if (editor) onClick(editor.chain().focus());
      }}
    >
      {icon ?? (
        <span
          className={
            mono
              ? "font-mono"
              : bold
                ? "font-bold"
                : italic
                  ? "italic"
                  : struck
                    ? "line-through"
                    : undefined
          }
        >
          {text}
        </span>
      )}
    </button>
  );
}

interface ToolbarMenuOptionProps {
  editor: Editor | null;
  label: string;
  onClick: (chain: ChainedCommands) => void;
  active?: (editor: Editor) => boolean;
  icon?: React.ReactNode;
  disabled?: boolean;
  title?: string;
}

function ToolbarMenuOption({
  editor,
  label,
  onClick,
  active,
  icon,
  disabled,
  title,
}: ToolbarMenuOptionProps) {
  const isActive = editor ? Boolean(active?.(editor)) : false;
  const buttonDisabled = disabled || !editor;
  return (
    <button
      type="button"
      className="wiki-toolbar-menu-option"
      aria-label={label}
      title={title ?? label}
      aria-pressed={active ? isActive : undefined}
      data-active={isActive ? "true" : "false"}
      disabled={buttonDisabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (editor) onClick(editor.chain().focus());
      }}
    >
      <span className="wiki-toolbar-menu-option-left">
        <span className="wiki-toolbar-menu-option-icon">{icon}</span>
        <span className="wiki-toolbar-menu-option-label">{label}</span>
      </span>
      {isActive && <Check className="wiki-toolbar-menu-option-check size-3.5" />}
    </button>
  );
}

/** Notion/Plane-style swatch set; values chosen to read on tinted surfaces. */
const COLOR_SWATCHES = [
  { name: "Gray", value: "#6b7280" },
  { name: "Brown", value: "#92400e" },
  { name: "Orange", value: "#c2410c" },
  { name: "Yellow", value: "#a16207" },
  { name: "Green", value: "#15803d" },
  { name: "Blue", value: "#1d4ed8" },
  { name: "Purple", value: "#7e22ce" },
  { name: "Red", value: "#b91c1c" },
];

function ColorControl({ editor, kind }: { editor: Editor | null; kind: "text" | "background" }) {
  const [open, setOpen] = useState(false);
  const attrs = editor?.getAttributes("textStyle") ?? {};
  const current =
    kind === "text"
      ? (attrs.color as string | undefined) ?? null
      : (attrs.backgroundColor as string | undefined) ?? null;
  const label = kind === "text" ? "Text color" : "Background color";
  const savedSelection = useRef<{ from: number; to: number } | null>(null);

  const saveSelection = () => {
    if (editor) {
      savedSelection.current = {
        from: editor.state.selection.from,
        to: editor.state.selection.to,
      };
    }
  };

  const restoreSelection = () => {
    if (editor && savedSelection.current) {
      const { from, to } = savedSelection.current;
      const maxPos = editor.state.doc.content.size;
      const safeFrom = Math.max(0, Math.min(from, maxPos));
      const safeTo = Math.max(0, Math.min(to, maxPos));
      editor.commands.setTextSelection({ from: safeFrom, to: safeTo });
      editor.commands.focus();
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      saveSelection();
    } else {
      restoreSelection();
    }
    setOpen(nextOpen);
  };

  const applyColor = (color: string | null) => {
    if (!editor) return;
    restoreSelection();
    if (color) {
      (kind === "text"
        ? editor.chain().focus().setColor(color)
        : editor.chain().focus().setBackgroundColor(color)
      ).run();
    } else {
      (kind === "text"
        ? editor.chain().focus().unsetColor()
        : editor.chain().focus().unsetBackgroundColor()
      ).run();
    }
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        onMouseDown={(e) => {
          e.preventDefault();
          saveSelection();
        }}
        render={
          <button
            type="button"
            className="wiki-toolbar-button inline-flex h-7 items-center justify-center rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            aria-label={label}
            aria-haspopup="true"
            aria-pressed={Boolean(current)}
            data-active={current ? "true" : "false"}
            disabled={!editor}
          />
        }
      >
        {kind === "text" ? <span>Color</span> : <span className="wiki-color-glyph" aria-hidden="true">Aₐ</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="wiki-color-menu"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            restoreSelection();
            setOpen(false);
          }
        }}
      >
        <button
          type="button"
          className="wiki-color-default"
          aria-pressed={!current}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => applyColor(null)}
        >
          Default
        </button>
        <div className="wiki-color-grid" role="group" aria-label={`${label} swatches`}>
          {COLOR_SWATCHES.map((swatch) => (
            <button
              key={swatch.value}
              type="button"
              className="wiki-swatch"
              style={{ background: swatch.value }}
              aria-label={`${label}: ${swatch.name}`}
              aria-pressed={current === swatch.value}
              data-active={current === swatch.value ? "true" : "false"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyColor(swatch.value)}
            />
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface LinkDraft {
  url: string;
  range: Range;
  existing: boolean;
  anchor: HTMLElement | { getBoundingClientRect: () => DOMRect };
}

function LinkPopover({ editor, draft, onClose }: {
  editor: Editor;
  draft: LinkDraft;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(draft.url);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  function save(remove = false) {
    if (editor.isDestroyed || !editor.isEditable) return;
    const trimmed = url.trim();
    if (!remove && !isSafeUrl(trimmed)) {
      setError("Enter a link using http://, https://, mailto:, tel:, or a relative path.");
      return;
    }
    const chain = editor.chain().setTextSelection(draft.range);
    if (remove) {
      chain.extendMarkRange("link").unsetLink().run();
    } else if (draft.range.from === draft.range.to && !draft.existing) {
      chain.insertContent({
        type: "text", text: trimmed,
        marks: [{ type: "link", attrs: { href: trimmed } }],
      }).run();
    } else {
      chain.extendMarkRange("link").setLink({ href: trimmed }).run();
    }
    onClose();
  }

  return (
    <Popover.Root open modal={false} onOpenChange={open => { if (!open) onClose(); }}>
      <Popover.Portal>
        <Popover.Positioner anchor={draft.anchor} side="bottom" align="start" sideOffset={6}
          collisionPadding={8} className="z-50">
          <Popover.Popup className="w-80 max-w-[calc(100vw-1rem)] rounded-lg bg-popover p-3 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
            initialFocus={input} finalFocus={() => editor.isDestroyed ? false : editor.view.dom}>
            <Popover.Title className="sr-only">{draft.existing ? "Edit link" : "Add link"}</Popover.Title>
            <form className="grid gap-3" noValidate onSubmit={event => { event.preventDefault(); save(); }}>
              <div className="grid gap-2">
                <label htmlFor={id} className="text-xs font-medium">Link URL</label>
                <Input ref={input} id={id} value={url} type="text" inputMode="url"
                  autoComplete="off" autoCapitalize="none" spellCheck={false}
                  placeholder="https://example.com"
                  aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
                  onChange={event => { setUrl(event.target.value); setError(null); }} />
                {error && <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{error}</p>}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {draft.existing && <Button size="sm" type="button" variant="ghost" onClick={() => save(true)}>Remove link</Button>}
                <Button size="sm" type="button" variant="secondary" onClick={onClose}>Cancel</Button>
                <Button size="sm" type="submit">Save link</Button>
              </div>
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function LinkButton({ editor, expanded, onOpen }: { editor: Editor | null; expanded: boolean; onOpen: (anchor: HTMLButtonElement) => void }) {
  const isActive = editor?.isActive("link") ?? false;
  return (
    <>
      <button
        type="button"
        className="wiki-toolbar-button inline-flex h-7 items-center justify-center rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        aria-label="Add link"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-pressed={isActive}
        data-active={isActive ? "true" : "false"}
        disabled={!editor}
        onMouseDown={(e) => e.preventDefault()}
        onClick={event => onOpen(event.currentTarget)}
      >
        <span>Link</span><Link02 className="size-3.5" />
      </button>
      {isActive && (
        <button
          type="button"
          className="wiki-toolbar-button inline-flex h-7 items-center rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Remove link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editor?.chain().focus().extendMarkRange("link").unsetLink().run()}
        >
          <Link02 className="size-3.5 opacity-40" />
        </button>
      )}
    </>
  );
}

function ToolbarDivider() {
  return <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />;
}
