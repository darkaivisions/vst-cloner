import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type LogLevel = "info" | "detail" | "warn" | "error" | "success";

export type JobEvent =
  | { kind: "log"; level: LogLevel; message: string; time: number; job: string }
  | { kind: "stage"; stage: string; title: string; time: number; job: string }
  | { kind: "progress"; done: number; total: number; label?: string; time: number; job: string }
  | { kind: "done"; result: unknown; time: number; job: string }
  | { kind: "failed"; error: string; cancelled: boolean; time: number; job: string };

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const pending = new Map<number, Pending>();
const jobHandlers = new Map<string, (event: JobEvent) => void>();
const earlyEvents = new Map<string, JobEvent[]>();
const globalListeners = new Set<(event: JobEvent) => void>();
const statusListeners = new Set<(status: BridgeStatus) => void>();
let nextId = 1;

export type BridgeStatus = { state: "starting" | "ready" | "stopped" | "error"; message?: string };
let status: BridgeStatus = { state: "starting" };

function setStatus(next: BridgeStatus) {
  status = next;
  for (const listener of statusListeners) listener(status);
}

export function onStatus(listener: (status: BridgeStatus) => void): void {
  statusListeners.add(listener);
  listener(status);
}

/** Receives the events of every job (used by the log panel). */
export function onJobEvent(listener: (event: JobEvent) => void): void {
  globalListeners.add(listener);
}

function dispatch(event: JobEvent) {
  for (const listener of globalListeners) listener(event);
  const handler = jobHandlers.get(event.job);
  if (handler) handler(event);
  else earlyEvents.set(event.job, [...(earlyEvents.get(event.job) ?? []), event]);
}

export async function initBridge(): Promise<void> {
  await listen<string>("bridge", ({ payload }) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(payload);
    } catch {
      return;
    }
    if (message.type === "ready") setStatus({ state: "ready" });
    else if (message.type === "response") {
      const request = pending.get(message.id as number);
      if (!request) return;
      pending.delete(message.id as number);
      if (message.ok) request.resolve(message.result);
      else request.reject(new Error(String(message.error)));
    } else if (message.type === "event") {
      dispatch(message as unknown as JobEvent);
    }
  });
  await listen("bridge-exit", () => {
    setStatus({ state: "stopped", message: "Der Hintergrundprozess wurde beendet" });
    for (const request of pending.values()) request.reject(new Error("Hintergrundprozess beendet"));
    pending.clear();
  });
  await listen<string>("bridge-error", ({ payload }) => setStatus({ state: "error", message: payload }));
  await listen<string>("bridge-stderr", ({ payload }) => console.debug("[bridge]", payload));
  await waitUntilReady();
}

/** The bridge may have announced "ready" before the page started listening – ask actively. */
async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 50 && status.state === "starting"; attempt++) {
    const ok = await Promise.race([
      call("ping").then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 400)),
    ]);
    if (ok) {
      setStatus({ state: "ready" });
      return;
    }
  }
}

export async function restartBridge(): Promise<void> {
  setStatus({ state: "starting" });
  try {
    await invoke("bridge_restart");
  } catch (error) {
    setStatus({ state: "error", message: String(error) });
    return;
  }
  await waitUntilReady();
}

export function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    invoke("bridge_send", { line: JSON.stringify({ id, method, params }) }).catch((error) => {
      pending.delete(id);
      reject(new Error(String(error)));
    });
  });
}

export interface JobHandle<T> {
  id: string;
  result: Promise<T>;
  cancel: () => Promise<void>;
}

/** Starts a job and calls `onEvent` for its events; `result` settles when the job ends. */
export async function startJob<T>(method: string, params: Record<string, unknown>, onEvent: (event: JobEvent) => void = () => {}): Promise<JobHandle<T>> {
  const { job } = await call<{ job: string }>(method, params);
  const result = new Promise<T>((resolve, reject) => {
    const handler = (event: JobEvent) => {
      onEvent(event);
      if (event.kind === "done") {
        jobHandlers.delete(job);
        resolve(event.result as T);
      } else if (event.kind === "failed") {
        jobHandlers.delete(job);
        reject(Object.assign(new Error(event.error), { cancelled: event.cancelled }));
      }
    };
    jobHandlers.set(job, handler);
    for (const event of earlyEvents.get(job) ?? []) handler(event);
    earlyEvents.delete(job);
  });
  return { id: job, result, cancel: () => call("job.cancel", { job }).then(() => undefined) };
}
