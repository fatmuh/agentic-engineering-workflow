"use client";

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";

/** One handle per top-level block. Native drag, with Alt+Arrow keyboard parity. */
export function WikiBlockControls({ editor, children }: { editor: Editor | null; children: React.ReactNode }) {
  const surface = useRef<HTMLDivElement>(null);
  const dragged = useRef<number | null>(null);
  const [active, setActive] = useState<{ pos: number; top: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (!editor || !surface.current) return;
    const host = surface.current;
    const show = (pos: number) => {
      const resolved = editor.state.doc.resolve(pos);
      const start = resolved.depth > 0 ? resolved.before(1) : pos;
      const dom = editor.view.nodeDOM(start);
      if (!(dom instanceof HTMLElement)) return;
      const newTop = dom.getBoundingClientRect().top - host.getBoundingClientRect().top;
      setActive((prev) => {
        if (prev && prev.pos === start && Math.abs(prev.top - newTop) < 1) {
          return prev;
        }
        return { pos: start, top: newTop };
      });
    };
    const selection = () => show(editor.state.selection.from);
    const hover = (event: MouseEvent) => {
      let block = event.target instanceof HTMLElement ? event.target : null;
      while (block && block.parentElement !== editor.view.dom) block = block.parentElement;
      if (block) show(editor.view.posAtDOM(block, 0));
    };
    editor.on("selectionUpdate", selection);
    editor.on("update", selection);
    host.addEventListener("mousemove", hover);
    window.addEventListener("resize", selection);
    return () => {
      editor.off("selectionUpdate", selection);
      editor.off("update", selection);
      host.removeEventListener("mousemove", hover);
      window.removeEventListener("resize", selection);
    };
  }, [editor]);

  function move(from: number, target: number) {
    if (!editor) return;
    const node = editor.state.doc.nodeAt(from);
    if (!node || (target >= from && target <= from + node.nodeSize)) return;
    const tr = editor.state.tr.delete(from, from + node.nodeSize);
    const destination = target > from ? target - node.nodeSize : target;
    tr.insert(destination, node);
    tr.setSelection(NodeSelection.create(tr.doc, destination));
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus();
    const dom = editor.view.nodeDOM(destination);
    if (dom instanceof HTMLElement && surface.current) {
      setActive({ pos: destination, top: dom.getBoundingClientRect().top - surface.current.getBoundingClientRect().top });
    }
    setAnnouncement("Block moved");
  }

  return (
    <div ref={surface} className="wiki-block-surface"
      onDragOver={event => {
        if (dragged.current === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDropCapture={event => {
        const from = dragged.current;
        dragged.current = null;
        if (from === null || !editor) return;
        event.preventDefault();
        event.stopPropagation();
        const found = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (!found) return;
        const resolved = editor.state.doc.resolve(found.pos);
        const start = resolved.depth ? resolved.before(1) : found.pos;
        const node = editor.state.doc.nodeAt(start);
        const dom = editor.view.nodeDOM(start);
        if (!node || !(dom instanceof HTMLElement)) return;
        const rect = dom.getBoundingClientRect();
        move(from, event.clientY > rect.top + rect.height / 2 ? start + node.nodeSize : start);
      }}>
      {children}
      {active && editor && (
        <button type="button" className="wiki-block-handle" style={{ top: active.top }} draggable
          aria-label="Move block" title="Drag to move · Alt+↑/↓ to reorder"
          onClick={() => { editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, active.pos))); editor.view.focus(); }}
          onDragStart={event => {
            dragged.current = active.pos;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", editor.state.doc.nodeAt(active.pos)?.textContent ?? "");
            const dom = editor.view.nodeDOM(active.pos);
            if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 0);
            editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, active.pos)));
          }}
          onDragEnd={() => { dragged.current = null; }}
          onKeyDown={event => {
            if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            const resolved = editor.state.doc.resolve(active.pos);
            const index = resolved.index(0);
            if (event.key === "ArrowUp" && index > 0) {
              move(active.pos, active.pos - editor.state.doc.child(index - 1).nodeSize);
            } else if (event.key === "ArrowDown" && index + 1 < editor.state.doc.childCount) {
              move(active.pos, active.pos + editor.state.doc.child(index).nodeSize + editor.state.doc.child(index + 1).nodeSize);
            }
            event.currentTarget.focus();
          }}>
          <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true">
            {[4, 8, 12].flatMap(y => [4, 8].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />))}
          </svg>
        </button>
      )}
      <span className="sr-only" role="status">{announcement}</span>
    </div>
  );
}
