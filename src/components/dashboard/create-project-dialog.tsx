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
    return `Sudah ada workspace dengan ${what} ini. Pilih workspace itu dari daftar, atau kosongkan ${what} untuk membuat workspace baru.`;
  }
  if (typeof body.error === "string" && body.error) return body.error;
  return "Workspace gagal dibuat. Coba lagi.";
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
      toast.success(`Workspace ${project.name} dibuat`);
    } catch {
      setError("Koneksi gagal. Coba lagi.");
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
      toast.error("Tidak bisa menyalin. Salin ID secara manual.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        {created ? (
          <div key="done" className="contents">
            <DialogHeader>
              <DialogTitle>Workspace dibuat</DialogTitle>
              <DialogDescription>{created.name} sekarang jadi workspace aktif.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <span id="created-project-id-label" className="text-xs font-medium text-muted-foreground">ID project</span>
              <div className="flex min-w-0 items-center gap-2">
                <code aria-labelledby="created-project-id-label" className="min-w-0 flex-1 rounded-md bg-muted px-2.5 py-1.5 font-mono text-sm [overflow-wrap:anywhere]">{created.id}</code>
                <Button type="button" variant="secondary" size="md" onClick={copyId} icon={copied ? <Check /> : <Copy />}>{copied ? "Tersalin" : "Salin"}</Button>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {created.gitRemoteUrl || created.workspacePath
                ? "Repo dengan git remote atau path ini tertaut otomatis saat agent menjalankan awm_project_init. Repo lain bisa ditautkan dengan ID di atas."
                : "Di repo yang ingin ditautkan, minta agent menjalankan awm_project_init dengan projectId di atas."}
            </p>
            <DialogFooter>
              <Button type="button" size="lg" onClick={() => handleOpenChange(false)}>Selesai</Button>
            </DialogFooter>
          </div>
        ) : (
          <div key="form" className="contents">
            <DialogHeader>
              <DialogTitle>Buat workspace</DialogTitle>
              <DialogDescription>Satu workspace untuk satu repo. Remote dan path boleh dikosongkan, repo tetap bisa ditautkan lewat ID project.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="grid gap-4">
              <div className="grid gap-1.5">
                <label htmlFor="create-project-name" className="text-xs font-medium text-muted-foreground">Nama</label>
                <Input id="create-project-name" name="name" value={name} onChange={event => setName(event.target.value)} placeholder="Uji Workflow" required maxLength={200} autoComplete="off" />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="create-project-remote" className="text-xs font-medium text-muted-foreground">Git remote (opsional)</label>
                <Input id="create-project-remote" name="gitRemoteUrl" value={gitRemoteUrl} onChange={event => setGitRemoteUrl(event.target.value)} placeholder="https://github.com/org/repo.git" autoComplete="off" spellCheck={false} />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="create-project-path" className="text-xs font-medium text-muted-foreground">Path folder (opsional)</label>
                <Input id="create-project-path" name="workspacePath" value={workspacePath} onChange={event => setWorkspacePath(event.target.value)} placeholder="/home/kamu/repo atau C:\Users\kamu\repo" aria-describedby="create-project-path-hint" autoComplete="off" spellCheck={false} />
                <p id="create-project-path-hint" className="text-xs text-muted-foreground">Dipakai hanya bila repo tidak punya remote.</p>
              </div>
              {error && <p role="alert" className="rounded-md bg-destructive/10 px-2.5 py-2 text-sm text-destructive [overflow-wrap:anywhere]">{error}</p>}
              <DialogFooter>
                <Button type="button" size="lg" variant="secondary" onClick={() => handleOpenChange(false)}>Batal</Button>
                <Button type="submit" size="lg" loading={saving}>Buat workspace</Button>
              </DialogFooter>
            </form>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
