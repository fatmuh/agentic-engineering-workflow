"use client";

import { useState } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { toast } from "sonner";
import { ChevronDown, Copy, Plus, Search } from "@/components/icons";
import { Button } from "@/components/ui/button-clean";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BrightdeskMark } from "./icons";
import type { ProjectStatus } from "./project-context";
import { switcherCopy } from "./workspace-switcher-state";

interface WorkspaceSwitcherProps {
  workspaces: { id: string; name: string; plan: string }[];
  /** Active workspace's project id (names are labels and need not be unique). */
  value: string;
  onChange: (id: string) => void;
  /** The project list's own state (`useActiveProject().status`). The trigger
   *  reports it instead of rendering as an empty chip while `/api/projects` is
   *  pending or failed; the menu's group label says the same thing. */
  status: ProjectStatus;
  /** Re-fetch the list after a failure. Rendered as a menu item only when the
   *  list actually failed, so recovery never needs a full page reload. */
  onRetry?: () => void;
  /** Open the create-workspace dialog. Without it the item stays disabled. */
  onCreate?: () => void;
  collapsed?: boolean;
}

export function WorkspaceSwitcher({
  workspaces,
  value,
  onChange,
  status,
  onRetry,
  onCreate,
  collapsed = false,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const activeName = workspaces.find(workspace => workspace.id === value)?.name ?? "";
  const copy = switcherCopy(status, workspaces.length, activeName);
  // The group label carries the state note as well as the heading: Base UI
  // renders `DropdownMenuLabel` as `aria-hidden` div and names the group with
  // it (`aria-labelledby`), and a `<p>` is not valid content inside a menu
  // group. One string keeps the visual note and the accessible name in step.
  const groupLabel = copy.note ? `Switch workspace · ${copy.note}` : "Switch workspace";
  // Up to this many rows the whole list fits; beyond it the list scrolls and
  // a search field appears, so the menu never grows past the screen.
  const searchable = workspaces.length > VISIBLE_ROWS;
  const copyActiveId = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Project ID copied");
    } catch {
      toast.error(`Couldn't copy. Project ID: ${value}`);
    }
  };
  const radios = (
    <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
      {workspaces.map(workspace => (
        <DropdownMenuRadioItem key={workspace.id} value={workspace.id} label={workspace.name} closeOnClick onClick={() => setOpen(false)}>
          <span className="workspace-switcher-mark" aria-hidden="true">{workspace.name.slice(0, 1)}</span>
          <span className="workspace-switcher-details"><span>{workspace.name}</span><span className="workspace-switcher-plan">{workspace.plan}</span></span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
  const menu = (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <style href="workspace-switcher-clean" precedence="default">{css}</style>
      {/* Never disabled: the menu still opens while the list loads or after it
          failed, so a stale-but-usable entry stays reachable and the retry
          item is reachable too. */}
      <DropdownMenuTrigger render={<Button variant="ghost" size="md" className="workspace-switcher-trigger" aria-label={copy.label} icon={<BrightdeskMark />} iconRight={collapsed ? undefined : <ChevronDown />} />}>
        {collapsed ? null : copy.trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="workspace-switcher-menu">
        {searchable && (
          <label className="workspace-switcher-search">
            <Search aria-hidden="true" />
            <MenuPrimitive.Input placeholder="Search workspaces…" aria-label="Search workspaces" autoComplete="off" spellCheck={false} />
          </label>
        )}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="workspace-switcher-label" data-state-note={copy.note ? "" : undefined}>
            {groupLabel}
          </DropdownMenuLabel>
          {/* List and Empty belong to Base UI's filter, which is only mounted
              with the search field; a short list is a plain scroll box. */}
          {searchable ? (
            <MenuPrimitive.List className="workspace-switcher-list custom-scrollbar">{radios}</MenuPrimitive.List>
          ) : (
            <div className="workspace-switcher-list custom-scrollbar">{radios}</div>
          )}
          {searchable && <MenuPrimitive.Empty className="workspace-switcher-empty">No matching workspaces.</MenuPrimitive.Empty>}
        </DropdownMenuGroup>
        {(status === "error" && onRetry) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onRetry}>Try again</DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {value && (
            <DropdownMenuItem onClick={copyActiveId} title={value}>
              <Copy data-icon="inline-start" /><span>Copy project ID</span><span className="workspace-switcher-id">{value}</span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={!onCreate} onClick={onCreate}><Plus data-icon="inline-start" /><span>Create workspace</span></DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  // Filtering only where the search field is shown: Base UI expects a
  // filterable menu to have its <Menu.Input>.
  return searchable ? <MenuPrimitive.FilterProvider autoHighlight>{menu}</MenuPrimitive.FilterProvider> : menu;
}

/** Rows shown before the list scrolls; more than this also shows search. */
const VISIBLE_ROWS = 5;

const css = /* css */ `
.workspace-switcher-trigger.ui-buttonc { max-width: 100%; padding-inline: 4px; gap: 8px; }
.workspace-switcher-trigger .ui-buttonc__icon:first-child { width: 20px; height: 20px; }
.workspace-switcher-trigger .ui-buttonc__icon:first-child svg { width: 20px; height: 20px; border-radius: 5px; }
.workspace-switcher-trigger .ui-buttonc__icon:last-child svg { width: 12px; height: 12px; }
.workspace-switcher-menu[data-slot="dropdown-menu-content"] {
  width: min(248px, calc(100vw - 32px)); padding: 4px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--popover); color: var(--popover-foreground); box-shadow: none;
  font-family: inherit; font-size: .8125rem; line-height: 1.5; --tw-ring-shadow: 0 0 #0000;
  overscroll-behavior: contain;
}
.workspace-switcher-menu [data-slot="dropdown-menu-label"] {
  padding: 6px 8px; font-size: .75rem; line-height: 1.5; font-weight: 500; color: var(--muted-foreground);
}
/* The state note is part of the label text; it is the only thing that may wrap
   onto a second line, so it keeps the group heading's weight and colour. */
.workspace-switcher-label[data-state-note] { font-weight: 400; overflow-wrap: anywhere; }
.workspace-switcher-menu [data-slot="dropdown-menu-radio-item"] {
  min-height: 42px; padding-block: 5px; padding-inline: 8px 28px; gap: 8px;
  font-size: .8125rem; line-height: 1.4; cursor: pointer; color: var(--popover-foreground);
}
.workspace-switcher-menu [data-slot="dropdown-menu-item"] {
  min-height: 32px; padding: 6px 8px; gap: 8px; font-size: .8125rem; line-height: 1.5;
}
.workspace-switcher-menu [data-slot="dropdown-menu-radio-item"]:is(:focus, [data-highlighted]) {
  background: var(--accent); color: var(--accent-foreground);
}
.workspace-switcher-menu [data-slot="dropdown-menu-radio-item"]:focus-visible {
  outline: 2px solid var(--popover-foreground); outline-offset: -2px;
}
.workspace-switcher-mark {
  display: grid; place-items: center; flex: none; width: 24px; height: 24px; border-radius: 5px;
  background: var(--muted); color: var(--muted-foreground); font-size: .75rem; font-weight: 500;
}
.workspace-switcher-details { display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }
.workspace-switcher-plan { font-size: .75rem; color: var(--muted-foreground); }
.workspace-switcher-menu [data-slot="dropdown-menu-radio-item"]:is(:focus, [data-highlighted]) .workspace-switcher-plan { color: var(--accent-foreground); }
.workspace-switcher-menu [data-slot="dropdown-menu-separator"] { margin: 4px 0; background: var(--border); }
/* Five 42px rows, then scroll. The thumb is the app's floating pill
   (.custom-scrollbar in globals.css); no scrollbar-width here, since Chromium
   ignores ::-webkit-scrollbar styles on an element that sets it. */
.workspace-switcher-list { max-height: calc(${VISIBLE_ROWS} * 42px); overflow-y: auto; overscroll-behavior: contain; }
.workspace-switcher-search {
  display: flex; align-items: center; gap: 6px; margin: 0 0 4px; padding: 0 8px; height: 32px;
  border: 1px solid var(--border); border-radius: 7px; color: var(--muted-foreground); cursor: text;
}
.workspace-switcher-search:focus-within { border-color: var(--ring); }
.workspace-switcher-search svg { width: 14px; height: 14px; flex: none; }
.workspace-switcher-search input {
  flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent;
  color: var(--popover-foreground); font: inherit;
}
.workspace-switcher-search input::placeholder { color: var(--muted-foreground); }
.workspace-switcher-empty { padding: 10px 8px; font-size: .8125rem; color: var(--muted-foreground); }
.workspace-switcher-id {
  margin-inline-start: auto; min-width: 0; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--font-mono, ui-monospace, monospace); font-size: .6875rem; color: var(--muted-foreground);
}
.workspace-switcher-menu [data-slot="dropdown-menu-radio-item-indicator"] { inset-inline-end: 8px; inset-inline-start: auto; }
@media (hover: hover) {
  .workspace-switcher-menu [data-slot="dropdown-menu-radio-item"]:hover { background: var(--accent); color: var(--accent-foreground); }
  .workspace-switcher-menu [data-slot="dropdown-menu-radio-item"]:hover .workspace-switcher-plan { color: var(--accent-foreground); }
}
@media (hover: none) and (pointer: coarse) { .workspace-switcher-menu [data-slot="dropdown-menu-radio-item"], .workspace-switcher-menu [data-slot="dropdown-menu-item"] { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .workspace-switcher-menu { animation: none !important; transition: none !important; } }
`;
