/**
 * Live view: what a long job is doing right now, for the app's side panel (training error, the rebuilt editor …).
 * Code anywhere in the pipeline calls `emitLive`; the app's bridge sets one receiver for the process and tells the
 * jobs apart. Without a receiver nothing happens, so the CLI pays nothing for it.
 */
export type LiveEvent =
  /** a training step of the network: error on the batch */
  | { type: "training"; step: number; seconds: number; budget: number; loss: number }
  /** error on the held-back settings (validation), now and then during training */
  | { type: "validation"; step: number; seconds: number; esr: number }
  /** the rebuilt editor as SVG, as soon as the original's editor is analysed */
  | { type: "editor"; svg: string };

export const liveEvents: { listener?: (event: LiveEvent) => void } = {};

export function emitLive(event: LiveEvent): void {
  liveEvents.listener?.(event);
}
