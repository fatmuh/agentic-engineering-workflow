"use client";

import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Button } from "@/components/ui/button-clean";

export type FilterOption = { id: string; label: string };
export type FilterGroup = { id: string; label: string; options: FilterOption[]; chipPrefix?: string };
export type FilterValue = Record<string, string[]>;
export type FilterMenuProps = {
  groups: FilterGroup[];
  value?: FilterValue;
  defaultValue?: FilterValue;
  onChange?: (value: FilterValue) => void;
  defaultOpen?: string[];
  title?: string;
  hints?: boolean;
  selectionMode?: "multiple" | "single";
  className?: string;
};
type Row = { key: string; group: FilterGroup; gi: number; option?: FilterOption };
const CHIP_GAP = 4;

export function FilterMenu({ groups, value, defaultValue = {}, onChange, defaultOpen, title = "Filters", hints = true, selectionMode = "multiple", className }: FilterMenuProps) {
  const uid = useId();
  const [inner, setInner] = useState<FilterValue>(defaultValue);
  const picked = value ?? inner;
  const [open, setOpen] = useState<Set<string>>(() => new Set(defaultOpen ?? groups.slice(0, 1).map(group => group.id)));
  const [focus, setFocus] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const chipsInner = useRef<HTMLDivElement>(null);
  const chipsOuter = useSmoothHeight(chipsInner);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(Infinity);
  const pickedIn = (id: string) => Array.isArray(picked[id]) ? picked[id] : [];
  const commit = (next: FilterValue) => {
    if (value === undefined) setInner(next);
    onChange?.(next);
  };
  const toggle = (group: string, option: string) => {
    const current = pickedIn(group);
    commit({ ...picked, [group]: selectionMode === "single" ? [option] : current.includes(option) ? current.filter(id => id !== option) : [...current, option] });
  };
  const toggleGroup = (group: string) => setOpen(previous => {
    const next = new Set(previous);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  });
  const seen = new Set<string>();
  const chips = groups.flatMap(group => group.options
    .filter(option => pickedIn(group.id).includes(option.id) && !seen.has(`${group.id}\u0000${option.id}`) && !!seen.add(`${group.id}\u0000${option.id}`))
    .map(option => ({ group, option, label: `${group.chipPrefix ?? ""}${option.label}` })));
  const chipKey = JSON.stringify(chips.map(chip => [chip.group.id, chip.option.id, chip.label]));

  // Measure a hidden copy before deciding which chips fit beside the +N counter.
  useLayoutEffect(() => {
    const row = chipsInner.current;
    const list = measure.current;
    if (!row || !list) return;
    const place = () => {
      const widths = [...list.children].map(el => (el as HTMLElement).offsetWidth + CHIP_GAP);
      const more = widths.pop() ?? 0;
      const style = getComputedStyle(row);
      const room = row.clientWidth - parseFloat(style.paddingInlineStart) - parseFloat(style.paddingInlineEnd) + CHIP_GAP;
      let used = 0;
      let count = 0;
      for (; count < widths.length; count++) {
        if (used + widths[count] + (count + 1 < widths.length ? more : 0) > room) break;
        used += widths[count];
      }
      setFit(count);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(row);
    return () => observer.disconnect();
  }, [chipKey]);

  const rows: Row[] = groups.flatMap((group, gi) => [
    { key: `g:${gi}`, group, gi },
    ...(open.has(group.id) ? group.options.map((option, oi) => ({ key: `o:${gi}:${oi}`, group, gi, option })) : []),
  ]);
  const activeKey = rows.some(row => row.key === focus) ? focus : rows[0]?.key;
  const moveTo = (key: string) => {
    setFocus(key);
    const element = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    const index = rows.findIndex(row => row.key === activeKey);
    const row = rows[index];
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      moveTo(rows[next].key);
    } else if (row && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      if (event.key === "ArrowRight" && !open.has(row.group.id)) toggleGroup(row.group.id);
      if (event.key === "ArrowLeft") {
        if (open.has(row.group.id)) toggleGroup(row.group.id);
        moveTo(`g:${row.gi}`);
      }
    } else if (row && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      if (row.option) toggle(row.group.id, row.option.id); else toggleGroup(row.group.id);
    }
  };
  const hidden = chips.slice(fit);

  return (
    <div className={["ui-fmc", className].filter(Boolean).join(" ")}>
      <style href="ui-filter-menu-clean" precedence="default">{css}</style>
      <div className="ui-fmc__head">
        <span className="ui-fmc__title" dir="auto" title={title}>{title}</span>
        {selectionMode === "multiple" && <Button size="sm" variant="ghost" className="ui-fmc__clear" disabled={!chips.length} onClick={() => commit({})}>Clear all</Button>}
      </div>
      <div className="ui-fmc__chips-outer" ref={chipsOuter} hidden={selectionMode === "single"}>
        <div className="ui-fmc__chips" ref={chipsInner} data-empty={!chips.length || undefined} aria-live="polite">
          <div className="ui-fmc__measure" ref={measure} aria-hidden="true">
            {chips.map((chip, index) => <span key={index} className="ui-fmc__chip"><span className="ui-fmc__chip-label">{chip.label}</span><span className="ui-fmc__chip-x" /></span>)}
            <span className="ui-fmc__chip ui-fmc__more">+{Math.max(99, chips.length)}</span>
          </div>
          {chips.slice(0, fit).map((chip, index) => <span key={index} className="ui-fmc__chip">
            <span className="ui-fmc__chip-label" dir="auto" title={chip.label}>{chip.label}</span>
            <Button size="sm" variant="ghost" className="ui-fmc__chip-x" aria-label={`Remove ${chip.label}`} onClick={() => toggle(chip.group.id, chip.option.id)} icon={<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>} />
          </span>)}
          {hidden.length > 0 && <span className="ui-fmc__chip ui-fmc__more" tabIndex={0} title={hidden.map(chip => chip.label).join(", ")} aria-label={`${hidden.length} more: ${hidden.map(chip => chip.label).join(", ")}`}><span key={hidden.length} className="ui-fmc__roll">+{hidden.length}</span></span>}
        </div>
      </div>
      <div className="ui-fmc__groups" ref={listRef} onKeyDown={onKeyDown}>
        {groups.map((group, gi) => {
          const isOpen = open.has(group.id);
          const count = new Set(pickedIn(group.id).filter(id => group.options.some(option => option.id === id))).size;
          const groupKey = `g:${gi}`;
          return <section key={`${group.id}#${gi}`} className="ui-fmc__group" data-open={isOpen || undefined}>
            <Button variant="ghost" size="sm" className="ui-fmc__group-head" data-key={groupKey} tabIndex={activeKey === groupKey ? 0 : -1} aria-expanded={isOpen} aria-controls={`${uid}-${gi}`} onFocus={() => setFocus(groupKey)} onClick={() => toggleGroup(group.id)}>
              <svg className="ui-fmc__chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.25 8 9.75l3.5-3.5" /></svg>
              <span className="ui-fmc__group-label" dir="auto" title={group.label}>{group.label}</span>
              <span className="ui-fmc__group-count">{group.options.length.toLocaleString("en-US")}</span>
              <span className="ui-fmc__group-picked" aria-live="polite">{count > 0 && <span key={count} className="ui-fmc__roll">{count} filter{count === 1 ? "" : "s"}</span>}</span>
            </Button>
            <div className="ui-fmc__panel" id={`${uid}-${gi}`} role={selectionMode === "single" ? "radiogroup" : "group"} aria-label={group.label} inert={!isOpen} aria-hidden={!isOpen}>
              <div className="ui-fmc__panel-inner">
                {group.options.map((option, oi) => {
                  const key = `o:${gi}:${oi}`;
                  const on = pickedIn(group.id).includes(option.id);
                  return <Button key={`${option.id}#${oi}`} variant="ghost" size="sm" role={selectionMode === "single" ? "radio" : "checkbox"} aria-checked={on} className="ui-fmc__option" data-key={key} tabIndex={isOpen && activeKey === key ? 0 : -1} onFocus={() => setFocus(key)} onClick={() => toggle(group.id, option.id)}>
                    <span className="ui-fmc__box" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m4.25 8.25 2.5 2.5 5-5.5" /></svg></span>
                    <span className="ui-fmc__option-label" dir="auto" title={option.label}>{option.label}</span>
                  </Button>;
                })}
              </div>
            </div>
          </section>;
        })}
      </div>
      {hints && <div className="ui-fmc__hints" aria-hidden="true"><span className="ui-fmc__hint"><kbd>↑</kbd><kbd>↓</kbd><span>to navigate</span></span><span className="ui-fmc__hint"><kbd>↵</kbd><span>to select</span></span></div>}
    </div>
  );
}

function useSmoothHeight(inner: RefObject<HTMLElement | null>) {
  const outer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = outer.current;
    const content = inner.current;
    if (!element || !content) return;
    const sync = () => { element.style.height = `${content.offsetHeight}px`; };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(content);
    const frame = requestAnimationFrame(() => element.setAttribute("data-smooth", ""));
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [inner]);
  return outer;
}

const css = /* css */ `
.ui-fmc {
  --ui-fmc-card: #fff; --ui-fmc-ink: rgba(0,0,0,.88); --ui-fmc-text: rgba(0,0,0,.61);
  --ui-fmc-muted: rgba(0,0,0,.45); --ui-fmc-faint: rgba(0,0,0,.3); --ui-fmc-icon: rgba(0,0,0,.447);
  --ui-fmc-line: rgba(0,0,0,.06); --ui-fmc-fill: rgba(0,0,0,.06); --ui-fmc-wash: rgba(0,0,0,.03);
  --ui-fmc-box-ring: rgba(0,0,0,.22); --ui-fmc-accent: #367ddc; --ui-fmc-check: #fff; --ui-fmc-focus: #367ddc;
  --ui-fmc-shadow: 0 0 0 .5px rgba(0,0,0,.06),0 1px 1px -1px rgba(0,0,0,.1),0 1px 2px rgba(0,0,0,.05);
  --ui-fmc-ease: cubic-bezier(.22,1,.36,1);
  --ui-fmc-border: rgba(0,0,0,.07);
  width: 100%; max-width: 400px; container-type: inline-size; overflow: hidden; border-radius: 10px;
  box-sizing: border-box; border: 1px solid var(--ui-fmc-border);
  background: var(--ui-fmc-card); box-shadow: 0 1px 1px rgba(0,0,0,.03); font-family: inherit;
  font-size: .8125rem; line-height: 1.54; font-weight: 400; color: var(--ui-fmc-ink);
}
.ui-fmc *, .ui-fmc *::before, .ui-fmc *::after { box-sizing: border-box; }
.ui-fmc button:focus-visible, .ui-fmc__more:focus-visible { outline: 2px solid var(--ui-fmc-focus); outline-offset: -2px; }
.ui-fmc .ui-buttonc { font: inherit; color: inherit; box-shadow: none; border: 0; background: none; }
.ui-fmc .ui-buttonc__label { display: contents; }
.ui-fmc .ui-buttonc[data-ready] .ui-buttonc__label { animation: none; }
.ui-fmc__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 10px 8px 16px; }
.ui-fmc__title { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: .9375rem; line-height: 1.6; font-weight: 500; }
.ui-fmc .ui-fmc__clear { min-height: 28px; padding: 0 8px; border-radius: 6px; font-weight: 500; color: var(--ui-fmc-text); }
.ui-fmc .ui-fmc__clear:disabled { color: var(--ui-fmc-faint); opacity: 1; }
.ui-fmc .ui-fmc__clear:hover:not(:disabled) { background: var(--ui-fmc-wash); }
.ui-fmc__chips-outer { overflow: hidden; }
.ui-fmc__chips-outer[data-smooth] { transition: height 320ms var(--ui-fmc-ease); }
.ui-fmc__chips { position: relative; display: flex; flex-wrap: nowrap; gap: 4px; padding: 0 16px 12px; overflow: hidden; }
.ui-fmc__chips[data-empty] { padding-block-end: 0; }
.ui-fmc__measure { position: absolute; inset-block-start: 0; inset-inline-start: 0; display: flex; gap: 4px; width: max-content; visibility: hidden; pointer-events: none; }
.ui-fmc__chip { display: inline-flex; flex: none; align-items: center; gap: 2px; min-height: 24px; padding: 0 3px 0 8px; border-radius: 6px; background: var(--ui-fmc-fill); font-size: .75rem; line-height: 1.34; font-weight: 500; white-space: nowrap; animation: ui-fmc-chip-in 260ms var(--ui-fmc-ease) both; }
.ui-fmc__chip-label { min-width: 0; max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
.ui-fmc .ui-fmc__chip-x, .ui-fmc__measure .ui-fmc__chip-x { display: grid; place-items: center; flex: none; width: 18px; min-width: 18px; height: 18px; min-height: 18px; padding: 0; border-radius: 4px; color: var(--ui-fmc-icon); }
.ui-fmc .ui-fmc__chip-x:hover { background: var(--ui-fmc-fill); }
.ui-fmc__chip-x svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; }
.ui-fmc__more { padding-inline: 8px; color: var(--ui-fmc-text); font-variant-numeric: tabular-nums; }
.ui-fmc__roll { display: inline-block; animation: ui-fmc-roll 300ms var(--ui-fmc-ease) both; }
.ui-fmc__groups { display: grid; grid-template-columns: minmax(0,1fr); padding: 4px; border-block-start: .5px solid var(--ui-fmc-line); }
.ui-fmc .ui-fmc__group-head, .ui-fmc .ui-fmc__option { display: flex; justify-content: flex-start; gap: 8px; width: 100%; min-height: 32px; padding: 0 8px; border-radius: 6px; text-align: start; transition: background-color 140ms ease; }
.ui-fmc .ui-fmc__group-head:hover, .ui-fmc .ui-fmc__option:hover { background: var(--ui-fmc-wash); }
.ui-fmc__chevron { width: 16px; height: 16px; flex: none; fill: none; stroke: var(--ui-fmc-icon); stroke-width: 1.1; stroke-linecap: round; stroke-linejoin: round; transform: rotate(-90deg); transition: transform 260ms var(--ui-fmc-ease); }
.ui-fmc__group[data-open] .ui-fmc__chevron { transform: none; }
.ui-fmc__group-label, .ui-fmc__option-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-fmc__group-label { font-weight: 500; }
.ui-fmc__group-count { color: var(--ui-fmc-faint); font-size: .75rem; font-variant-numeric: tabular-nums; }
.ui-fmc__group-picked { display: inline-flex; margin-inline-start: auto; color: var(--ui-fmc-muted); font-size: .75rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ui-fmc__panel { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 320ms var(--ui-fmc-ease); }
.ui-fmc__group[data-open] .ui-fmc__panel { grid-template-rows: 1fr; }
.ui-fmc__panel-inner { display: grid; grid-template-columns: minmax(0,1fr); min-height: 0; overflow: hidden; opacity: 0; transition: opacity 220ms ease, padding 320ms var(--ui-fmc-ease); }
.ui-fmc__group[data-open] .ui-fmc__panel-inner { opacity: 1; padding-block-end: 4px; max-height: 320px; overflow-y: auto; overscroll-behavior: contain; }
.ui-fmc .ui-fmc__option { padding-inline-start: 32px; }
.ui-fmc__box { display: grid; place-items: center; flex: none; width: 14px; height: 14px; border-radius: 4px; background: var(--ui-fmc-card); box-shadow: inset 0 0 0 .5px var(--ui-fmc-box-ring); transition: background-color 160ms ease, box-shadow 160ms ease; }
.ui-fmc__box svg { width: 12px; height: 12px; fill: none; stroke: var(--ui-fmc-check); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 12; stroke-dashoffset: 12; transition: stroke-dashoffset 240ms var(--ui-fmc-ease); }
.ui-fmc__option[aria-checked="true"] .ui-fmc__box { background: var(--ui-fmc-accent); box-shadow: none; }
.ui-fmc__option[aria-checked="true"] .ui-fmc__box svg { stroke-dashoffset: 0; transition-delay: 40ms; }
.ui-fmc__hints { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 32px; padding: 4px 12px; border-block-start: .5px solid var(--ui-fmc-line); font-size: .75rem; line-height: 1.34; color: var(--ui-fmc-muted); }
.ui-fmc__hint { display: inline-flex; align-items: center; gap: 2px; white-space: nowrap; }
.ui-fmc__hint > span { margin-inline-start: 4px; }
.ui-fmc kbd { display: inline-grid; place-items: center; min-width: 16px; min-height: 16px; padding: 0 4px; border-radius: 4px; background: var(--ui-fmc-card); box-shadow: var(--ui-fmc-shadow); font-family: inherit; font-size: .625rem; line-height: 1.6; font-weight: 500; }
@keyframes ui-fmc-chip-in { from { opacity: 0; transform: scale(.9); } }
@keyframes ui-fmc-roll { from { opacity: 0; transform: translateY(60%); } to { opacity: 1; transform: none; } }
@container (max-width: 320px) { .ui-fmc__chip-label { max-width: 132px; } }
@media (hover: none) and (pointer: coarse) {
  .ui-fmc .ui-fmc__clear { min-height: 36px; } .ui-fmc__chip { min-height: 32px; }
  .ui-fmc .ui-fmc__chip-x { width: 26px; min-width: 26px; height: 26px; }
  .ui-fmc .ui-fmc__group-head, .ui-fmc .ui-fmc__option { min-height: 44px; }
  .ui-fmc__box { width: 18px; height: 18px; } .ui-fmc__hints { display: none; }
}
@media (prefers-reduced-motion: reduce) { .ui-fmc *, .ui-fmc *::before, .ui-fmc *::after { animation: none !important; transition: none !important; } }
:where(.dark, [data-theme="dark"]) .ui-fmc {
  --ui-fmc-card: #1c1c1e; --ui-fmc-ink: rgba(255,255,255,.9); --ui-fmc-text: rgba(255,255,255,.62);
  --ui-fmc-muted: rgba(255,255,255,.46); --ui-fmc-faint: rgba(255,255,255,.3); --ui-fmc-icon: rgba(255,255,255,.5);
  --ui-fmc-line: rgba(255,255,255,.08); --ui-fmc-fill: rgba(255,255,255,.08); --ui-fmc-wash: rgba(255,255,255,.04);
  --ui-fmc-border: rgba(255,255,255,.1);
  --ui-fmc-box-ring: rgba(255,255,255,.28); --ui-fmc-accent: #4d8dff; --ui-fmc-focus: #4d8dff;
  --ui-fmc-shadow: 0 0 0 .5px rgba(255,255,255,.1),0 1px 2px rgba(0,0,0,.4);
}
`;
