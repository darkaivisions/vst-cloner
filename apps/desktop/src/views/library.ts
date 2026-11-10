import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { call } from "../bridge.ts";
import { clear, formatBytes, formatDate, formatDb, h, toast, verdictClass } from "../dom.ts";
import type { ProfileSummary } from "../types.ts";
import { ProfileDetailsDialog } from "./details.ts";

/** Saved profiles: rebuild clones without the original, export, import, delete. */
export class LibraryView {
  readonly element: HTMLElement;
  private readonly list = h("div.profile-list");
  private profilesDir = "";
  private readonly details = new ProfileDetailsDialog();

  constructor(private readonly onBuild: (profile: ProfileSummary) => void) {
    this.element = h("div.view.library-view", {},
      h("section.card", {},
        h("header.step-header", {}, h("h2", {}, "Bibliothek"), h("div.spacer"),
          h("button.ghost.small", { onclick: () => this.importProfile() }, "Profil importieren …"),
          h("button.ghost.small", { onclick: () => this.profilesDir && openPath(this.profilesDir) }, "Ordner öffnen")),
        h("p.hint", {}, "Gespeicherte Messungen (.vcprofile). Aus einem Profil lässt sich der Klon jederzeit neu bauen – ohne das Original-Plugin."),
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
      this.list.appendChild(h("div.empty", {}, "Noch keine Profile – unter „Klonen“ ein Plugin messen."));
      return;
    }
    for (const p of profiles) {
      this.list.appendChild(
        h("div.profile-card", {},
          h("div.profile-main", {},
            h("div.profile-name", {}, p.name, h("span.muted", {}, p.manufacturer ? ` · ${p.manufacturer}` : "")),
            h("div.profile-meta", {},
              h("span", {}, formatDate(p.createdAt)),
              h("span", {}, `${p.renders} Messungen`),
              h("span", {}, { eq: "EQ-Messung", dynamics: "Kompressor-Messung", distortion: "Distortion-Messung" }[p.planner] ?? "allgemein"),
              h("span", {}, formatBytes(p.bytes)))),
          p.verdict
            ? h("span.pill", { class: verdictClass(p.verdict), title: `Abweichung ${formatDb(p.rmsDb ?? 0)}` }, `Klon: ${p.verdict}`)
            : h("span.pill.neutral", {}, "noch kein Klon"),
          h("div.profile-actions", {},
            h("button.ghost.small", { onclick: () => this.details.show(p.path) }, "Details"),
            h("button.primary.small", {
              disabled: p.planner !== "eq" && p.planner !== "dynamics",
              title: p.planner !== "eq" && p.planner !== "dynamics" ? "Klone sind bisher nur für EQ- und Kompressor-Messungen möglich" : "",
              onclick: () => this.onBuild(p),
            }, "Klon bauen"),
            h("button.ghost.small", { onclick: () => this.exportProfile(p) }, "Exportieren …"),
            h("button.ghost.small", { onclick: () => revealItemInDir(p.path) }, "Zeigen"),
            h("button.ghost.small.danger-text", { onclick: () => this.deleteProfile(p) }, "Löschen"))),
      );
    }
  }

  private async importProfile() {
    const path = await open({ title: "Profil importieren", filters: [{ name: "vst-cloner-Profil", extensions: ["vcprofile"] }] });
    if (typeof path !== "string") return;
    try {
      await call("profiles.import", { path });
      toast("Profil importiert");
      await this.refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  private async exportProfile(p: ProfileSummary) {
    const target = await save({ title: "Profil exportieren", defaultPath: p.file, filters: [{ name: "vst-cloner-Profil", extensions: ["vcprofile"] }] });
    if (!target) return;
    try {
      await call("profiles.export", { path: p.path, target });
      toast("Profil exportiert");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  private async deleteProfile(p: ProfileSummary) {
    if (!confirm(`Profil „${p.name}“ vom ${formatDate(p.createdAt)} löschen?`)) return;
    try {
      await call("profiles.delete", { path: p.path });
      await this.refresh();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }
}
