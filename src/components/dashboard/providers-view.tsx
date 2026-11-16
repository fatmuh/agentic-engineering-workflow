"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, TriangleAlert } from "@/components/icons";
import { usePermission } from "@/components/dashboard/permission-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button-clean";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";

/**
 * /providers — the registry behind the `awm_provider_*` MCP tools.
 *
 * Why a page at all: until now the only surface was `GET /api/llm-providers`,
 * which (a) seeded two fabricated providers with invented API keys on first
 * read and (b) had no way to register a real one, so `awm_provider_select`
 * could only ever answer with sample data. This is the missing write path.
 *
 * The API returns the stored key in clear text (the Go client turns it into
 * `ANTHROPIC_API_KEY`, so it cannot be masked on the wire). Here it is shown
 * masked by default behind an explicit reveal, so a shared screen does not leak
 * it by accident.
 */

export interface ProviderView {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  isTeamShared: boolean;
  registeredBy: string;
}

const EMPTY_FORM = {
  id: "",
  name: "",
  providerType: "anthropic",
  baseUrl: "",
  apiKey: "",
  modelId: "",
  isTeamShared: false,
};

type Form = typeof EMPTY_FORM;

/** Never render a full key: enough to recognise it, not enough to use it. */
function maskKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

export function ProvidersView({ initialProviders }: { initialProviders: ProviderView[] }) {
  const { can } = usePermission();
  const canManage = can("providers.manage");
  const [providers, setProviders] = useState<ProviderView[]>(initialProviders);
  const [status, setStatus] = useState<"ready" | "loading" | "error">("ready");
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      const response = await apiFetch("/api/llm-providers", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) throw new Error("Unexpected payload");
      setProviders(payload as ProviderView[]);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memuat daftar provider.");
      setStatus("error");
    }
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canManage) return;
    setSaving(true);
    const body: Record<string, unknown> = {
      name: form.name,
      providerType: form.providerType,
      baseUrl: form.baseUrl,
      modelId: form.modelId,
      isTeamShared: form.isTeamShared,
    };
    if (form.id.trim()) body.id = form.id.trim();
    // Empty means "keep the stored key" on an update, and is rejected for a
    // new provider by the API — the same masked-form rule /storage uses.
    if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();

    try {
      const response = await apiFetch("/api/llm-providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `HTTP ${response.status}`);
      }
      toast.success("Provider disimpan.");
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Gagal menyimpan provider.");
    } finally {
      setSaving(false);
    }
  };

  const edit = (provider: ProviderView) => {
    if (!canManage) return;
    setForm({
      id: provider.id,
      name: provider.name,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl,
      apiKey: "",
      modelId: provider.modelId,
      isTeamShared: provider.isTeamShared,
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">LLM Providers</h1>
          <p className="text-xs text-muted-foreground">
            Registry provider yang dipakai tool <code>awm_provider_list</code> dan{" "}
            <code>awm_provider_select</code>.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void load()} icon={<RefreshCw />}>
          Muat ulang
        </Button>
      </div>

      {status === "error" && (
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-muted/50 px-3 py-3 text-xs">
          <TriangleAlert aria-hidden="true" />
          <span role="status">Gagal memuat daftar provider. {error}</span>
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Coba lagi
          </Button>
        </div>
      )}

      {status !== "error" && providers.length === 0 && (
        <p role="status" className="rounded-[10px] bg-muted/50 px-3 py-6 text-center text-xs text-muted-foreground">
          Belum ada provider terdaftar. Tool <code>awm_provider_select</code> akan kosong sampai satu
          provider ditambahkan.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {providers.map((provider) => {
          const isRevealed = revealed.has(provider.id);
          return (
            <li key={provider.id} className="rounded-[10px] border border-border px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{provider.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {provider.providerType} · {provider.baseUrl} · {provider.modelId}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {provider.isTeamShared && <Badge variant="secondary">Team</Badge>}
                  <Badge variant="outline">{provider.id}</Badge>
                  {canManage && (
                    <Button size="sm" variant="ghost" onClick={() => edit(provider)}>
                      Ubah
                    </Button>
                  )}
                </div>
              </div>
              <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">API key</span>
                <code className="font-mono">{isRevealed ? provider.apiKey : maskKey(provider.apiKey)}</code>
                <button
                  type="button"
                  className="cursor-pointer underline"
                  aria-pressed={isRevealed}
                  onClick={() =>
                    setRevealed((current) => {
                      const next = new Set(current);
                      if (next.has(provider.id)) next.delete(provider.id);
                      else next.add(provider.id);
                      return next;
                    })
                  }
                >
                  {isRevealed ? "Sembunyikan" : "Tampilkan"}
                </button>
              </p>
            </li>
          );
        })}
      </ul>

      {canManage ? (
        <form onSubmit={submit} className="flex flex-col gap-2 rounded-[10px] border border-border px-3 py-4">
          <h2 className="text-sm font-medium">{form.id ? `Ubah ${form.id}` : "Tambah provider"}</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Nama</span>
              <Input value={form.name} required onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Tipe</span>
              <select
                className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                value={form.providerType}
                onChange={(event) => setForm({ ...form, providerType: event.target.value })}
              >
                <option value="anthropic">anthropic</option>
                <option value="openai_compatible">openai_compatible</option>
                <option value="proxy">proxy</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Base URL</span>
              <Input value={form.baseUrl} required onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Model ID</span>
              <Input value={form.modelId} required onChange={(event) => setForm({ ...form, modelId: event.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs sm:col-span-2">
              <span className="text-muted-foreground">
                API key {form.id && <span className="opacity-75">(kosongkan untuk mempertahankan yang tersimpan)</span>}
              </span>
              <Input
                type="password"
                autoComplete="off"
                value={form.apiKey}
                required={!form.id}
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={form.isTeamShared}
              onChange={(event) => setForm({ ...form, isTeamShared: event.target.checked })}
            />
            <span>Dibagikan ke tim</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={saving}>
              Simpan
            </Button>
            {form.id && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setForm(EMPTY_FORM)}>
                Batal
              </Button>
            )}
          </div>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">
          Anda hanya dapat melihat provider. Peran dengan izin <code>providers.manage</code> dapat menambah atau mengubahnya.
        </p>
      )}
    </div>
  );
}
