import { call, startJob } from "../bridge.ts";
import { clear, h, toast } from "../dom.ts";

interface Status {
  providers: { id: string; name: string; local: boolean; baseURL?: string; key: string }[];
  roles: { role: string; description: string; model: string | null }[];
  discovered: { preset: string; name: string; local: boolean; available: boolean; detail: string }[];
  presets: { id: string; name: string; description: string; local: boolean; needsBaseURL: boolean }[];
}

interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
  toolCall?: boolean;
  cost?: { input?: number; output?: number };
}

const KEY_LABELS: Record<string, string> = {
  local: "lokal, kein Schlüssel nötig",
  keychain: "Schlüssel im Schlüsselbund",
  env: "Schlüssel aus Umgebungsvariable",
  none: "kein Schlüssel",
  error: "Schlüsselbund nicht erreichbar",
};

const ROLE_TITLES: Record<string, string> = { analyst: "Analyse", builder: "Klon-Code" };
const ROLE_DESCRIPTIONS: Record<string, string> = {
  analyst: "Wertet Plugin-Metadaten mit REA aus und schreibt die funktionale Beschreibung",
  builder: "Schreibt den DSP-Code des Klons – sieht nur Beschreibung und Messdaten",
};

const tokens = (n?: number) => (n === undefined ? "?" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M` : `${Math.round(n / 1000)}k`);

/** Language model providers, API keys and role assignment. */
export class AiView {
  readonly element: HTMLElement;
  private readonly providers = h("div.provider-list");
  private readonly roles = h("div.role-list");
  private readonly addBox = h("div.add-provider");
  private status?: Status;
  private models = new Map<string, ModelInfo[]>();

  constructor() {
    this.element = h("div.view.ai-view", {},
      h("section.card", {},
        h("header.step-header", {}, h("h2", {}, "Anbieter"), h("div.spacer"), h("button.ghost.small", { onclick: () => this.refresh() }, "Aktualisieren")),
        h("p.hint", {}, "Lokale Modelle (Ollama, LM Studio, …) und Cloud-Dienste. Schlüssel liegen im System-Schlüsselbund, nie in einer Datei."),
        this.providers, this.addBox),
      h("section.card", {},
        h("header.step-header", {}, h("h2", {}, "Rollen")),
        h("p.hint", {}, "Welches Modell welche Aufgabe übernimmt. Wird für kommende Effektarten gebraucht – EQ-Klone funktionieren ohne KI."),
        this.roles));
  }

  async refresh(): Promise<void> {
    try {
      this.status = await call<Status>("llm.status");
    } catch (error) {
      toast((error as Error).message, "error");
      return;
    }
    this.renderProviders();
    this.renderAdd();
    await this.renderRoles();
  }

  private renderProviders() {
    const s = this.status!;
    clear(this.providers);
    if (s.providers.length === 0) this.providers.appendChild(h("div.empty", {}, "Noch kein Anbieter eingerichtet."));
    for (const p of s.providers) {
      const keyInput = h("input.key-input", { type: "password", placeholder: "API-Schlüssel einfügen", autocomplete: "off" });
      const keyRow = h("div.key-row.hidden", {}, keyInput,
        h("button.primary.small", { onclick: async () => {
          try {
            const r = await call<{ models: number }>("llm.setKey", { provider: p.id, key: keyInput.value });
            toast(`Schlüssel gespeichert – ${r.models} Modelle verfügbar`);
            keyInput.value = "";
            await this.refresh();
          } catch (error) {
            toast((error as Error).message, "error");
          }
        } }, "Speichern"));
      const ok = p.key === "local" || p.key === "keychain" || p.key === "env";
      this.providers.appendChild(
        h("div.provider-row", {},
          h("span.status-dot", { class: ok ? "good" : "warn" }),
          h("div.provider-main", {}, h("strong", {}, p.name), h("span.muted", {}, ` · ${p.id}${p.baseURL ? ` · ${p.baseURL}` : ""}`),
            h("div.muted.small", {}, KEY_LABELS[p.key] ?? p.key)),
          h("div.provider-actions", {},
            !p.local && h("button.ghost.small", { onclick: () => keyRow.classList.toggle("hidden") }, "Schlüssel …"),
            h("button.ghost.small.danger-text", { onclick: async () => {
              if (!confirm(`Anbieter „${p.name}“ entfernen?`)) return;
              await call("llm.remove", { provider: p.id }).catch((e) => toast((e as Error).message, "error"));
              this.models.delete(p.id);
              await this.refresh();
            } }, "Entfernen")),
          keyRow),
      );
    }
    const local = s.discovered.filter((d) => d.local && d.available && !s.providers.some((p) => p.id === d.preset));
    for (const d of local) {
      this.providers.appendChild(
        h("div.provider-row.suggestion", {},
          h("span.status-dot.good"),
          h("div.provider-main", {}, h("strong", {}, d.name), h("span.muted", {}, ` · läuft (${d.detail})`)),
          h("div.provider-actions", {}, h("button.primary.small", { onclick: () => this.add(d.preset) }, "Hinzufügen"))),
      );
    }
  }

  private renderAdd() {
    const s = this.status!;
    clear(this.addBox);
    const select = h("select", {}, ...s.presets.map((p) => h("option", { value: p.id }, `${p.name} – ${p.description}`)));
    const url = h("input.hidden", { type: "url", placeholder: "Basis-URL, z. B. https://api.groq.com/openai/v1" });
    select.addEventListener("change", () => url.classList.toggle("hidden", !s.presets.find((p) => p.id === select.value)?.needsBaseURL));
    this.addBox.append(h("span.muted", {}, "Anbieter hinzufügen:"), select, url,
      h("button.ghost.small", { onclick: () => this.add(select.value, url.value) }, "Hinzufügen"));
  }

  private async add(preset: string, baseURL = "") {
    try {
      await call("llm.add", { preset, ...(baseURL ? { baseURL } : {}) });
      await this.refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  private async loadModels(provider: string): Promise<ModelInfo[]> {
    const cached = this.models.get(provider);
    if (cached) return cached;
    const models = await call<ModelInfo[]>("llm.models", { provider });
    this.models.set(provider, models);
    return models;
  }

  private async renderRoles() {
    const s = this.status!;
    clear(this.roles);
    const usable = s.providers.filter((p) => p.key !== "none" && p.key !== "error");
    const options: { value: string; label: string }[] = [];
    for (const p of usable) {
      try {
        for (const m of await this.loadModels(p.id)) {
          if (m.toolCall === false) continue;
          const price = m.cost?.input === 0 && m.cost?.output === 0 ? "kostenlos" : m.cost?.input !== undefined ? `$${Number(m.cost.input.toPrecision(3))}/$${Number((m.cost.output ?? 0).toPrecision(3))} pro 1M` : "";
          options.push({ value: `${p.id}/${m.id}`, label: `${p.name}: ${m.name ?? m.id} (${tokens(m.contextLength)}${price ? ` · ${price}` : ""})` });
        }
      } catch {
        // provider unreachable – shown in the provider list
      }
    }

    for (const r of s.roles) {
      const select = h("select", {}, h("option", { value: "" }, "– nicht gesetzt –"),
        ...options.map((o) => h("option", { value: o.value, selected: o.value === r.model }, o.label)));
      if (r.model && !options.some((o) => o.value === r.model)) select.appendChild(h("option", { value: r.model, selected: true }, r.model));
      select.addEventListener("change", async () => {
        await call("llm.setRole", { role: r.role, model: select.value || null }).catch((e) => toast((e as Error).message, "error"));
      });
      const testButton = h("button.ghost.small", {}, "Testen");
      testButton.addEventListener("click", async () => {
        if (!select.value) return toast("Erst ein Modell wählen", "error");
        testButton.disabled = true;
        testButton.textContent = "Teste …";
        try {
          const job = await startJob<{ results: { ok: boolean }[] }>("llm.test", { model: select.value });
          const report = await job.result;
          const passed = report.results.filter((x) => x.ok).length;
          toast(`${passed} von ${report.results.length} Prüfungen bestanden – Details im Protokoll`, passed === report.results.length ? "info" : "error");
        } catch (error) {
          toast((error as Error).message, "error");
        } finally {
          testButton.disabled = false;
          testButton.textContent = "Testen";
        }
      });
      this.roles.appendChild(
        h("div.role-row", {},
          h("div.role-main", {}, h("strong", {}, ROLE_TITLES[r.role] ?? r.role), h("div.muted.small", {}, ROLE_DESCRIPTIONS[r.role] ?? r.description)),
          select, testButton),
      );
    }
    if (options.length === 0) this.roles.appendChild(h("p.hint", {}, "Sobald ein Anbieter eingerichtet ist, erscheinen hier seine Modelle."));
  }
}
