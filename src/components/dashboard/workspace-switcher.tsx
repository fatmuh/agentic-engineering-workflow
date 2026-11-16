"use client";

import { useState } from "react";
import { ChevronDown, Plus } from "@/components/icons";
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
  collapsed?: boolean;
}

export function WorkspaceSwitcher({
  workspaces,
  value,
  onChange,
  status,
  onRetry,
  collapsed = false,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const activeName = workspaces.find(workspace => workspace.id === value)?.name ?? "";
  const copy = switcherCopy(status, workspaces.length, activeName);
  // The group label carries the state note as well as the heading: Base UI
  // renders `DropdownMenuLabel` as `aria-hidden` div and names the group with
  // it (`aria-labelledby`), and a `<p>` is not valid content inside a menu
  // group. One string keeps the visual note and the accessible name in step.
  const groupLabel = copy.note ? `Ganti workspace · ${copy.note}` : "Ganti workspace";
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <style href="workspace-switcher-clean" precedence="default">{css}</style>
      {/* Never disabled: the menu still opens while the list loads or after it
          failed, so a stale-but-usable entry stays reachable and the retry
          item is reachable too. */}
      <DropdownMenuTrigger render={<Button variant="ghost" size="md" className="workspace-switcher-trigger" aria-label={copy.label} icon={<BrightdeskMark />} iconRight={collapsed ? undefined : <ChevronDown />} />}>
        {collapsed ? null : copy.trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="workspace-switcher-menu">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="workspace-switcher-label" data-state-note={copy.note ? "" : undefined}>
            {groupLabel}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
            {workspaces.map(workspace => (
              <DropdownMenuRadioItem key={workspace.id} value={workspace.id} closeOnClick onClick={() => setOpen(false)}>
                <span className="workspace-switcher-mark" aria-hidden="true">{workspace.name.slice(0, 1)}</span>
                <span className="workspace-switcher-details"><span>{workspace.name}</span><span className="workspace-switcher-plan">{workspace.plan}</span></span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {(status === "error" && onRetry) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onRetry}>Coba lagi</DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {/* Disabled, so it needs no callback: the item is the message, and
              "Demo" is the visible half of the same sentence as its title. */}
          <DropdownMenuItem disabled title="Pembuatan workspace belum tersedia di demo ini"><Plus data-icon="inline-start" /><span>Buat workspace</span><span className="workspace-switcher-unavailable">Demo</span></DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
.workspace-switcher-menu [data-slot="dropdown-menu-radio-item-indicator"] { inset-inline-end: 8px; inset-inline-start: auto; }
.workspace-switcher-unavailable { margin-inline-start: auto; font-size: .75rem; color: var(--muted-foreground); }
@media (hover: hover) {
  .workspace-switcher-menu [data-slot="dropdown-menu-radio-item"]:hover { background: var(--accent); color: var(--accent-foreground); }
  .workspace-switcher-menu [data-slot="dropdown-menu-radio-item"]:hover .workspace-switcher-plan { color: var(--accent-foreground); }
}
@media (hover: none) and (pointer: coarse) { .workspace-switcher-menu [data-slot="dropdown-menu-radio-item"], .workspace-switcher-menu [data-slot="dropdown-menu-item"] { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .workspace-switcher-menu { animation: none !important; transition: none !important; } }
`;
