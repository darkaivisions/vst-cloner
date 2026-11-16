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
  local: "local, no key needed",
  keychain: "key in the system keychain",
  env: "key from an environment variable",
  none: "no key",
  error: "keychain not reachable",
};

const ROLE_TITLES: Record<string, string> = { analyst: "Analysis", builder: "Clone code" };
const ROLE_DESCRIPTIONS: Record<string, string> = {
  analyst: "Evaluates plugin metadata with REA and writes the functional description",
  builder: "Writes the DSP code of the clone – sees only the description and the measurements",
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
        h("header.step-header", {}, h("h2", {}, "Providers"), h("div.spacer"), h("button.ghost.small", { onclick: () => this.refresh() }, "Refresh")),
        h("p.hint", {}, "Local models (Ollama, LM Studio, …) and cloud services. Keys are kept in the system keychain, never in a file."),
        this.providers, this.addBox),
      h("section.card", {},
        h("header.step-header", {}, h("h2", {}, "Roles")),
        h("p.hint", {}, "Which model does which job. Needed for upcoming effect types – EQ clones work without AI."),
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
    if (s.providers.length === 0) this.providers.appendChild(h("div.empty", {}, "No provider set up yet."));
    for (const p of s.providers) {
      const keyInput = h("input.key-input", { type: "password", placeholder: "Paste API key", autocomplete: "off" });
      const keyRow = h("div.key-row.hidden", {}, keyInput,
        h("button.primary.small", { onclick: async () => {
          try {
            const r = await call<{ models: number }>("llm.setKey", { provider: p.id, key: keyInput.value });
            toast(`Key saved – ${r.models} models available`);
            keyInput.value = "";
            await this.refresh();
          } catch (error) {
            toast((error as Error).message, "error");
          }
        } }, "Save"));
      const ok = p.key === "local" || p.key === "keychain" || p.key === "env";
      this.providers.appendChild(
        h("div.provider-row", {},
          h("span.status-dot", { class: ok ? "good" : "warn" }),
          h("div.provider-main", {}, h("strong", {}, p.name), h("span.muted", {}, ` · ${p.id}${p.baseURL ? ` · ${p.baseURL}` : ""}`),
            h("div.muted.small", {}, KEY_LABELS[p.key] ?? p.key)),
          h("div.provider-actions", {},
            !p.local && h("button.ghost.small", { onclick: () => keyRow.classList.toggle("hidden") }, "Key …"),
            h("button.ghost.small.danger-text", { onclick: async () => {
              if (!confirm(`Remove the provider "${p.name}"?`)) return;
              await call("llm.remove", { provider: p.id }).catch((e) => toast((e as Error).message, "error"));
              this.models.delete(p.id);
              await this.refresh();
            } }, "Remove")),
          keyRow),
      );
    }
    const local = s.discovered.filter((d) => d.local && d.available && !s.providers.some((p) => p.id === d.preset));
    for (const d of local) {
      this.providers.appendChild(
        h("div.provider-row.suggestion", {},
          h("span.status-dot.good"),
          h("div.provider-main", {}, h("strong", {}, d.name), h("span.muted", {}, ` · running (${d.detail})`)),
          h("div.provider-actions", {}, h("button.primary.small", { onclick: () => this.add(d.preset) }, "Add"))),
      );
    }
  }

  private renderAdd() {
    const s = this.status!;
    clear(this.addBox);
    const select = h("select", {}, ...s.presets.map((p) => h("option", { value: p.id }, `${p.name} – ${p.description}`)));
    const url = h("input.hidden", { type: "url", placeholder: "Base URL, e.g. https://api.groq.com/openai/v1" });
    select.addEventListener("change", () => url.classList.toggle("hidden", !s.presets.find((p) => p.id === select.value)?.needsBaseURL));
    this.addBox.append(h("span.muted", {}, "Add a provider:"), select, url,
      h("button.ghost.small", { onclick: () => this.add(select.value, url.value) }, "Add"));
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
          const price = m.cost?.input === 0 && m.cost?.output === 0 ? "free" : m.cost?.input !== undefined ? `$${Number(m.cost.input.toPrecision(3))}/$${Number((m.cost.output ?? 0).toPrecision(3))} per 1M` : "";
          options.push({ value: `${p.id}/${m.id}`, label: `${p.name}: ${m.name ?? m.id} (${tokens(m.contextLength)}${price ? ` · ${price}` : ""})` });
        }
      } catch {
        // provider unreachable – shown in the provider list
      }
    }

    for (const r of s.roles) {
      const select = h("select", {}, h("option", { value: "" }, "– not set –"),
        ...options.map((o) => h("option", { value: o.value, selected: o.value === r.model }, o.label)));
      if (r.model && !options.some((o) => o.value === r.model)) select.appendChild(h("option", { value: r.model, selected: true }, r.model));
      select.addEventListener("change", async () => {
        await call("llm.setRole", { role: r.role, model: select.value || null }).catch((e) => toast((e as Error).message, "error"));
      });
      const testButton = h("button.ghost.small", {}, "Test");
      testButton.addEventListener("click", async () => {
        if (!select.value) return toast("Choose a model first", "error");
        testButton.disabled = true;
        testButton.textContent = "Testing …";
        try {
          const job = await startJob<{ results: { ok: boolean }[] }>("llm.test", { model: select.value });
          const report = await job.result;
          const passed = report.results.filter((x) => x.ok).length;
          toast(`${passed} of ${report.results.length} checks passed – details in the log`, passed === report.results.length ? "info" : "error");
        } catch (error) {
          toast((error as Error).message, "error");
        } finally {
          testButton.disabled = false;
          testButton.textContent = "Test";
        }
      });
      this.roles.appendChild(
        h("div.role-row", {},
          h("div.role-main", {}, h("strong", {}, ROLE_TITLES[r.role] ?? r.role), h("div.muted.small", {}, ROLE_DESCRIPTIONS[r.role] ?? r.description)),
          select, testButton),
      );
    }
    if (options.length === 0) this.roles.appendChild(h("p.hint", {}, "Once a provider is set up, its models appear here."));
  }
}
