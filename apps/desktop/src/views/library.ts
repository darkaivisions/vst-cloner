import { open, save } from "@tauri-apps/plugin-dialog";
import { call } from "../bridge.ts";
import { clear, formatBytes, formatDate, formatDb, h, openInSystem, revealInFolder, toast, verdictClass } from "../dom.ts";
import type { ProfileSummary } from "../types.ts";
import { ProfileDetailsDialog } from "./details.ts";

/** measurement types a clone can be built from */
const CLONEABLE = new Set(["eq", "dynamics", "distortion", "delay", "reverb", "neural"]);

/** Saved profiles: rebuild clones without the original, export, import, delete. */
export class LibraryView {
  readonly element: HTMLElement;
  private readonly list = h("div.profile-list");
  private profilesDir = "";
  private readonly details = new ProfileDetailsDialog();

  constructor(private readonly onBuild: (profile: ProfileSummary) => void) {
    this.element = h("div.view.library-view", {},
      h("section.card", {},
        h("header.step-header", {}, h("h2", {}, "Library"), h("div.spacer"),
          h("button.ghost.small", { onclick: () => this.importProfile() }, "Import profile …"),
          h("button.ghost.small", { onclick: () => this.profilesDir && openInSystem(this.profilesDir) }, "Open folder")),
        h("p.hint", {}, "Saved measurements (.vcprofile). A clone can be rebuilt from a profile at any time – without the original plugin."),
        this.list));
  }

  setProfilesDir(dir: string): void {
    this.profilesDir = dir;
  }

  async refresh(): Promise<void> {
    let profiles: ProfileSummary[];
    try {
      profiles = await call<ProfileSummary[]>("profiles.list");
    } catch (error) {
      toast((error as Error).message, "error");
      return;
    }
    clear(this.list);
    if (profiles.length === 0) {
      this.list.appendChild(h("div.empty", {}, "No profiles yet – measure a plugin under \"Clone\"."));
      return;
    }
    for (const p of profiles) {
      this.list.appendChild(
        h("div.profile-card", {},
          h("div.profile-main", {},
            h("div.profile-name", {}, p.name, h("span.muted", {}, p.manufacturer ? ` · ${p.manufacturer}` : "")),
            h("div.profile-meta", {},
              h("span", {}, formatDate(p.createdAt)),
              h("span", {}, `${p.renders} measurements`),
              h("span", {}, { eq: "EQ measurement", dynamics: "Dynamics measurement", distortion: "Distortion measurement", delay: "Delay measurement", reverb: "Reverb measurement", neural: "Universal measurement" }[p.planner] ?? "general"),
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
