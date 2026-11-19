import { open, save } from "@tauri-apps/plugin-dialog";
import { call } from "../bridge.ts";
import { clear, formatBytes, formatDate, formatDb, h, openInSystem, revealInFolder, toast, verdictClass } from "../dom.ts";
import type { ProfileSummary } from "../types.ts";
import { filterBar, kindBadge } from "../kinds.ts";
import { ProfileDetailsDialog } from "./details.ts";

/** measurement types a clone can be built from */
const CLONEABLE = new Set(["eq", "dynamics", "distortion", "delay", "modulation", "reverb", "neural"]);

/** Saved profiles: rebuild clones without the original, export, import, delete. */
export class LibraryView {
  readonly element: HTMLElement;
  private readonly list = h("div.profile-list");
  private readonly filters = h("div.filters");
  private profiles: ProfileSummary[] = [];
  private group = "all";
  private onlyClones = false;
  private profilesDir = "";
  private readonly details = new ProfileDetailsDialog();

  constructor(private readonly onBuild: (profile: ProfileSummary) => void) {
    this.element = h("div.view.library-view", {},
      h("section.card", {},
        h("header.step-header", {}, h("h2", {}, "Library"), h("div.spacer"),
          h("button.ghost.small", { onclick: () => this.importProfile() }, "Import profile …"),
          h("button.ghost.small", { onclick: () => this.profilesDir && openInSystem(this.profilesDir) }, "Open folder")),
        h("p.hint", {}, "Saved measurements (.vcprofile). A clone can be rebuilt from a profile at any time – without the original plugin."),
        this.filters,
        this.list));
  }

  setProfilesDir(dir: string): void {
    this.profilesDir = dir;
  }

  async refresh(): Promise<void> {
    try {
      this.profiles = await call<ProfileSummary[]>("profiles.list");
    } catch (error) {
      toast((error as Error).message, "error");
      return;
    }
    this.render();
  }

  /** The profiles of the chosen effect group (and only those with a clone, if asked). */
  private render() {
    clear(this.list);
    clear(this.filters);
    const base = this.profiles.filter((p) => !this.onlyClones || p.verdict);
    const counts = new Map<string, number>();
    for (const p of base) counts.set(p.kind ?? "other", (counts.get(p.kind ?? "other") ?? 0) + 1);
    const profiles = this.group === "all" ? base : base.filter((p) => (p.kind ?? "other") === this.group);
    if (this.profiles.length > 0) {
      this.filters.append(filterBar(counts, base.length, this.group, (group) => { this.group = group; this.render(); }),
        h("div.filter-extra", {},
          h("label.check.filter-check", { title: "Only profiles a clone was built from" },
            h("input", { type: "checkbox", checked: this.onlyClones, onchange: (e: Event) => { this.onlyClones = (e.target as HTMLInputElement).checked; this.render(); } }), "Only with a clone")));
    }
    if (profiles.length === 0) {
      this.list.appendChild(h("div.empty", {}, this.profiles.length ? "No profile in this group" : "No profiles yet – measure a plugin under \"Clone\"."));
      return;
    }
    for (const p of profiles) {
      this.list.appendChild(
        h("div.profile-card", {},
          h("div.profile-main", {},
            h("div.profile-name", {}, p.name, h("span.muted", {}, p.manufacturer ? ` · ${p.manufacturer}` : ""),
              p.kind ? kindBadge({ group: p.kind, label: p.kindLabel ?? p.kind, ...(p.engine !== undefined ? { engine: p.engine } : {}) }) : ""),
            h("div.profile-meta", {},
              h("span", {}, formatDate(p.createdAt)),
              h("span", {}, `${p.renders} measurements`),
              h("span", {}, { eq: "EQ measurement", dynamics: "Dynamics measurement", distortion: "Distortion measurement", delay: "Delay measurement", modulation: "Modulation measurement", reverb: "Reverb measurement", neural: "Universal measurement" }[p.planner] ?? "general"),
              h("span", {}, formatBytes(p.bytes)))),
          p.verdict
            ? h("span.pill", { class: verdictClass(p.verdict), title: `Deviation ${p.deviation ?? formatDb(p.rmsDb ?? 0)}` }, `Clone: ${p.verdict}`)
            : h("span.pill.neutral", {}, "no clone yet"),
          h("div.profile-actions", {},
            h("button.ghost.small", { onclick: () => this.details.show(p.path) }, "Details"),
            h("button.primary.small", {
              disabled: !CLONEABLE.has(p.planner),
              title: CLONEABLE.has(p.planner) ? "" : "This profile was measured with the general plan, which no clone can be built from – measure the plugin again with the universal or a class measurement",
              onclick: () => this.onBuild(p),
            }, "Build clone"),
            h("button.ghost.small", { onclick: () => this.exportProfile(p) }, "Export …"),
            h("button.ghost.small", { onclick: () => revealInFolder(p.path) }, "Show"),
            h("button.ghost.small.danger-text", { onclick: () => this.deleteProfile(p) }, "Delete"))),
      );
    }
  }

  private async importProfile() {
    const path = await open({ title: "Import profile", filters: [{ name: "vst-cloner profile", extensions: ["vcprofile"] }] });
    if (typeof path !== "string") return;
    try {
      await call("profiles.import", { path });
      toast("Profile imported");
      await this.refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  private async exportProfile(p: ProfileSummary) {
    const target = await save({ title: "Export profile", defaultPath: p.file, filters: [{ name: "vst-cloner profile", extensions: ["vcprofile"] }] });
    if (!target) return;
    try {
      await call("profiles.export", { path: p.path, target });
      toast("Profile exported");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  private async deleteProfile(p: ProfileSummary) {
    if (!confirm(`Delete the profile "${p.name}" from ${formatDate(p.createdAt)}?`)) return;
    try {
      await call("profiles.delete", { path: p.path });
      await this.refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }
}
