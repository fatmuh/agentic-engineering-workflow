"use client";

import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button-clean";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import "./roles-view.css";

/** Shared floating shell, motion, scrolling and pinned actions for role forms. */
export function RoleSheet({
  title,
  description,
  children,
  actionLabel,
  saving,
  disabled,
  error,
  showCancel = false,
  onSubmit,
  onClose,
}: {
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
  actionLabel: string;
  saving: boolean;
  disabled: boolean;
  error: string | null;
  showCancel?: boolean;
  /** Return true to close after a successful create; edits stay open. */
  onSubmit: () => Promise<boolean | void>;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => { if (!isOpen) onClose(); }}
    >
      <SheetContent side="right" className="roles-edit-drawer t-panel-slide">
        <SheetHeader className="roles-edit-header">
          <SheetTitle className="flex flex-wrap items-center gap-2">{title}</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {description}
          </SheetDescription>
        </SheetHeader>
        <form
          className="roles-edit-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (disabled || saving) return;
            if (await onSubmit()) setOpen(false);
          }}
        >
          <div className="roles-edit-body">{children}</div>
          <footer className="roles-edit-footer">
            {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
            <div className="roles-edit-actions">
              {showCancel && (
                <Button size="lg" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              )}
              <Button
                type="submit"
                size="lg"
                variant="primary"
                loading={saving}
                disabled={disabled || saving}
              >
                {actionLabel}
              </Button>
            </div>
          </footer>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** Both role modes use the same labels, spacing and form controls. */
export function RoleDetailsFields({
  name,
  description,
  onNameChange,
  onDescriptionChange,
  readOnly = false,
  hint,
}: {
  name: string;
  description: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  readOnly?: boolean;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="grid gap-3" aria-label="Role details">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Details</h3>
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-name`} className="text-xs font-medium text-muted-foreground">Name</label>
        <Input
          id={`${id}-name`}
          name="name"
          value={name}
          disabled={readOnly}
          onChange={(event) => onNameChange(event.target.value)}
          required
        />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-description`} className="text-xs font-medium text-muted-foreground">Description</label>
        <Textarea
          id={`${id}-description`}
          name="description"
          value={description}
          disabled={readOnly}
          rows={2}
          onChange={(event) => onDescriptionChange(event.target.value)}
        />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </section>
  );
}
