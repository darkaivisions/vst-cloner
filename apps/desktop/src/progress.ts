import { h } from "./dom.ts";

export class Progress {
  readonly element: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly label: HTMLElement;

  constructor() {
    this.bar = h("div.progress-bar");
    this.label = h("div.progress-label");
    this.element = h("div.progress.hidden", {}, h("div.progress-track", {}, this.bar), this.label);
  }

  set(done: number, total: number, label = ""): void {
    this.element.classList.remove("hidden", "indeterminate");
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    this.bar.style.width = `${pct}%`;
    this.label.textContent = label || `${done} / ${total}`;
  }

  busy(label: string): void {
    this.element.classList.remove("hidden");
    this.element.classList.add("indeterminate");
    this.bar.style.width = "35%";
    this.label.textContent = label;
  }

  hide(): void {
    this.element.classList.add("hidden");
  }
}
