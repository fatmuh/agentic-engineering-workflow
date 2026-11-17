"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy } from "@/components/icons";
import { Button } from "@/components/ui/button-clean";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { toProject, useActiveProject, type WorkspaceProject } from "./project-context";

/** What the user reads when the API refuses. A 409 names the remote or path
 *  that already belongs to a workspace, in words for this screen: the API's own
 *  message points at an endpoint, which means nothing here. */
function errorMessage(status: number, data: unknown): string {
  const body = (typeof data === "object" && data !== null ? data : {}) as { error?: unknown; conflict?: unknown };
  if (status === 409) {
    const what = body.conflict === "git remote" ? "git remote" : "path";
    return `A workspace with this ${what} already exists. Pick it from the list, or leave the ${what} empty to create a new workspace.`;
  }
  if (typeof body.error === "string" && body.error) return body.error;
  return "Couldn't create the workspace. Try again.";
}

/**
 * Create a workspace (a `bmad_projects` row) from the dashboard.
 *
 * Until now a project could only be born from `awm_project_init`, so a machine
 * whose identity the API rejected had no way in. Here the remote and the path
 * are optional: a project with neither is still linkable, because the CLI can
 * attach a folder to it by id (`awm_project_init` with `projectId`). That id is
 * what the success view hands over.
 */
export function CreateProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { addProject } = useActiveProject();
  const [name, setName] = useState("");
  const [gitRemoteUrl, setGitRemoteUrl] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<WorkspaceProject | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setName("");
    setGitRemoteUrl("");
    setWorkspacePath("");
    setError(null);
    setCreated(null);
    setCopied(false);
  }

  function handleOpenChange(value: boolean) {
    if (!value) reset();
    onOpenChange(value);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          gitRemoteUrl: gitRemoteUrl.trim() || null,
          workspacePath: workspacePath.trim() || null,
        }),
      });
      const data: unknown = await res.json().catch(() => ({}));
      const project = res.ok ? toProject(data) : null;
      if (!project) {
        setError(errorMessage(res.status, data));
        return;
      }
      addProject(project);
      setCreated(project);
      toast.success(`Workspace ${project.name} created`);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function copyId() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.id);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy. Copy the ID manually.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        {created ? (
          <div key="done" className="contents">
            <DialogHeader>
              <DialogTitle>Workspace created</DialogTitle>
              <DialogDescription>{created.name} is now the active workspace.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <span id="created-project-id-label" className="text-xs font-medium text-muted-foreground">Project ID</span>
              <div className="flex min-w-0 items-center gap-2">
                <code aria-labelledby="created-project-id-label" className="min-w-0 flex-1 rounded-md bg-muted px-2.5 py-1.5 font-mono text-sm [overflow-wrap:anywhere]">{created.id}</code>
                <Button type="button" variant="secondary" size="md" onClick={copyId} icon={copied ? <Check /> : <Copy />}>{copied ? "Copied" : "Copy"}</Button>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {created.gitRemoteUrl || created.workspacePath
                ? "A repo with this git remote or path links itself when an agent runs awm_project_init. Any other repo can be linked with the ID above."
                : "In the repo you want to link, ask the agent to run awm_project_init with the projectId above."}
            </p>
            <DialogFooter>
              <Button type="button" size="lg" onClick={() => handleOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div key="form" className="contents">
            <DialogHeader>
              <DialogTitle>Create workspace</DialogTitle>
              <DialogDescription>One workspace per repo. Remote and path are optional; a repo can still be linked by its project ID.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="grid gap-4">
              <div className="grid gap-1.5">
                <label htmlFor="create-project-name" className="text-xs font-medium text-muted-foreground">Name</label>
                <Input id="create-project-name" name="name" value={name} onChange={event => setName(event.target.value)} placeholder="Uji Workflow" required maxLength={200} autoComplete="off" />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="create-project-remote" className="text-xs font-medium text-muted-foreground">Git remote (optional)</label>
                <Input id="create-project-remote" name="gitRemoteUrl" value={gitRemoteUrl} onChange={event => setGitRemoteUrl(event.target.value)} placeholder="https://github.com/org/repo.git" autoComplete="off" spellCheck={false} />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="create-project-path" className="text-xs font-medium text-muted-foreground">Folder path (optional)</label>
                <Input id="create-project-path" name="workspacePath" value={workspacePath} onChange={event => setWorkspacePath(event.target.value)} placeholder="/home/you/repo or C:\Users\you\repo" aria-describedby="create-project-path-hint" autoComplete="off" spellCheck={false} />
                <p id="create-project-path-hint" className="text-xs text-muted-foreground">Only used when the repo has no remote.</p>
              </div>
              {error && <p role="alert" className="rounded-md bg-destructive/10 px-2.5 py-2 text-sm text-destructive [overflow-wrap:anywhere]">{error}</p>}
              <DialogFooter>
                <Button type="button" size="lg" variant="secondary" onClick={() => handleOpenChange(false)}>Cancel</Button>
                <Button type="submit" size="lg" loading={saving}>Create workspace</Button>
              </DialogFooter>
            </form>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
