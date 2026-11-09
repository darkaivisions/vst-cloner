import { generateText, isStepCount, Output, tool } from "ai";
import { z } from "zod";
import type { ResolvedModel } from "./llm.ts";
import { ROLES, ROLE_NAMES, type RoleName } from "./roles.ts";
import type { UsageTotals } from "./usage.ts";

export type ProbeName = "text" | "tools" | "structured";

export interface ProbeResult {
  name: ProbeName;
  ok: boolean;
  milliseconds: number;
  detail: string;
}

export interface RoleFit {
  suitable: boolean;
  reasons: string[];
}

export interface CapabilityReport {
  ref: string;
  contextLength?: number;
  results: ProbeResult[];
  usage: UsageTotals;
  roles: Record<RoleName, RoleFit>;
  notes: string[];
}

const shortError = (error: unknown) => {
  const message = (error as Error)?.message ?? String(error);
  return message.length > 240 ? `${message.slice(0, 240)}…` : message;
};

async function timed(name: ProbeName, run: () => Promise<{ ok: boolean; detail: string }>): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const result = await run();
    return { name, ...result, milliseconds: Math.round(performance.now() - started) };
  } catch (error) {
    return { name, ok: false, detail: shortError(error), milliseconds: Math.round(performance.now() - started) };
  }
}

/**
 * Runs three short live checks against a model: plain text, tool calling and structured output.
 * Costs a few hundred tokens.
 */
export async function testModel(target: ResolvedModel, options: { timeoutMs?: number; only?: ProbeName[] } = {}): Promise<CapabilityReport> {
  const timeoutMs = options.timeoutMs ?? 120000;
  const common = { model: target.model, maxRetries: 1 } as const;
  const price = target.info.cost;
  const record = (usage: Parameters<typeof target.meter.add>[0]) => target.meter.add(usage, price);
  const wanted = (name: ProbeName) => !options.only || options.only.includes(name);
  const results: ProbeResult[] = [];

  if (wanted("text")) {
    results.push(
      await timed("text", async () => {
        const result = await generateText({ ...common, abortSignal: AbortSignal.timeout(timeoutMs), prompt: "Reply with exactly one word: pong" });
        record(result.totalUsage);
        const ok = /pong/i.test(result.text);
        return { ok, detail: ok ? "answered correctly" : `unexpected answer: ${JSON.stringify(result.text.slice(0, 80))}` };
      }),
    );
  }

  if (wanted("tools")) {
    results.push(
      await timed("tools", async () => {
        const calls: { a: number; b: number }[] = [];
        const result = await generateText({
          ...common,
          abortSignal: AbortSignal.timeout(timeoutMs),
          tools: {
            multiply: tool({
              description: "Multiplies two integers exactly.",
              inputSchema: z.object({ a: z.number(), b: z.number() }),
              execute: async ({ a, b }) => {
                calls.push({ a, b });
                return { product: a * b };
              },
            }),
          },
          stopWhen: isStepCount(4),
          prompt: "Use the multiply tool to compute 1234 * 5678. Then reply with only the resulting number.",
        });
        record(result.totalUsage);
        const called = calls.some((c) => (c.a === 1234 && c.b === 5678) || (c.a === 5678 && c.b === 1234));
        const answered = result.text.replace(/[^0-9]/g, "").includes("7006652");
        if (!calls.length) return { ok: false, detail: "model did not call the tool" };
        if (!called) return { ok: false, detail: `tool called with wrong arguments: ${JSON.stringify(calls)}` };
        return { ok: true, detail: answered ? "tool called, result used" : "tool called (final answer did not repeat the result)" };
      }),
    );
  }

  if (wanted("structured")) {
    results.push(
      await timed("structured", async () => {
        const result = await generateText({
          ...common,
          abortSignal: AbortSignal.timeout(timeoutMs),
          output: Output.object({
            schema: z.object({
              effectClass: z.enum(["eq", "compressor", "distortion", "delay", "reverb", "other"]),
              bandCount: z.number().int(),
              hasHighPass: z.boolean(),
            }),
          }),
          prompt: "Classify this audio plugin: 'A six-band parametric equalizer with an additional high-pass filter.'",
        });
        record(result.totalUsage);
        const out = result.output;
        const ok = out.effectClass === "eq" && out.hasHighPass;
        return { ok, detail: ok ? `valid object (${JSON.stringify(out)})` : `schema valid but wrong content: ${JSON.stringify(out)}` };
      }),
    );
  }

  const byName = new Map(results.map((r) => [r.name, r]));
  const notes: string[] = [];
  const context = target.info.contextLength;

  const roles = Object.fromEntries(
    ROLE_NAMES.map((role) => {
      const req = ROLES[role];
      const reasons: string[] = [];
      const check = (name: ProbeName, needed: boolean, label: string) => {
        const r = byName.get(name);
        if (!needed) return;
        if (!r) reasons.push(`${label} not tested`);
        else if (!r.ok) reasons.push(`${label} failed`);
      };
      check("text", true, "text");
      check("tools", req.tools, "tool calling");
      check("structured", req.structuredOutput, "structured output");
      if (context !== undefined && context < req.minContext) reasons.push(`context ${context} < ${req.minContext} tokens`);
      return [role, { suitable: reasons.length === 0, reasons }];
    }),
  ) as Record<RoleName, RoleFit>;

  if (context === undefined) notes.push("context length unknown (not in provider listing or models.dev catalogue)");
  if (target.provider.listing === "ollama") {
    notes.push("Ollama limits the context per request by default; set OLLAMA_CONTEXT_LENGTH (e.g. 32768) for long agent sessions.");
  }

  return { ref: target.ref, ...(context !== undefined ? { contextLength: context } : {}), results, usage: target.meter.get(), roles, notes };
}
