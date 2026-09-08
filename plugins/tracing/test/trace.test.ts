import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { convertRollout } from "../src/trace.js";

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

const baseConfig: Config = {
  enabled: true,
  public_key: "pk-lf-test",
  secret_key: "sk-lf-test",
  base_url: "https://cloud.langfuse.com",
  max_chars: 20_000,
  debug: false,
  fail_on_error: false,
};

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/sessions");

/** Copy the fixture session tree to a fresh temp dir (isolates sidecar writes). */
function stageFixtures(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-trace-"));
  fs.cpSync(fixturesRoot, path.join(dir, "sessions"), { recursive: true });
  return path.join(dir, "sessions", "2026", "06", "03");
}

/**
 * The derivation external systems use to precompute a seeded trace id —
 * intentionally independent of the Langfuse SDK helper the plugin calls.
 */
const seededTraceId = (seed: string): string =>
  createHash("sha256").update(seed).digest("hex").slice(0, 32);

const attr = (span: ReadableSpan, key: string): string =>
  span.attributes[key] == null ? "" : String(span.attributes[key]);
const obsType = (span: ReadableSpan): string => attr(span, "langfuse.observation.type");
const startMs = (span: ReadableSpan): number => span.startTime[0] * 1000 + span.startTime[1] / 1e6;
const parentId = (span: ReadableSpan): string | undefined =>
  (span as unknown as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId ??
  (span as unknown as { parentSpanId?: string }).parentSpanId;

beforeAll(() => {
  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

describe("convertRollout", () => {
  it("does not emit a trace for session metadata events without a turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-codex-trace-"));
    const file = path.join(dir, "rollout-settings-only.jsonl");
    fs.writeFileSync(
      file,
      [
        {
          timestamp: "2026-09-08T03:39:26.314Z",
          type: "session_meta",
          payload: {
            id: "01a07f03-d9fa-7ce1-a0fc-74b152d2728c",
            cli_version: "0.153.4",
            model_provider: "openai",
          },
        },
        {
          timestamp: "2026-09-08T03:39:26.314Z",
          type: "event_msg",
          payload: { type: "thread_settings_applied" },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );

    await convertRollout(file, { config: baseConfig });

    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(fs.existsSync(`${file}.langfuse`)).toBe(false);
  });

  it("emits an agent → generation → tool tree with backdated timestamps", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "Codex Turn");
    expect(root, "expected a 'Codex Turn' root span").toBeDefined();
    expect(obsType(root!)).toBe("agent");
    expect(parentId(root!)).toBeUndefined(); // top-level turn = its own trace
    expect(attr(root!, "langfuse.observation.input")).toContain("List the files");
    expect(attr(root!, "langfuse.observation.output")).toContain("two files");

    // Backdated to the turn's task_started timestamp.
    expect(startMs(root!)).toBe(Date.parse("2026-06-03T10:00:01.000Z"));

    // Two generations, both children of the root, named "LLM" (the model name
    // lives in the model attribute, not the observation name).
    const generations = spans
      .filter((s) => obsType(s) === "generation")
      .sort((a, b) => startMs(a) - startMs(b));
    expect(generations).toHaveLength(2);
    for (const gen of generations) {
      expect(gen.name).toBe("LLM");
      expect(parentId(gen)).toBe(root!.spanContext().spanId);
      expect(attr(gen, "langfuse.observation.model.name")).toBe("gpt-5.4");
    }
    // Usage is sent in Langfuse's OpenAI-compatible shape. Langfuse then
    // normalizes the inclusive parent counts and nested detail counts.
    const usages = generations.map((generation) => {
      const usage = attr(generation, "langfuse.observation.usage_details");
      expect(usage, "expected generation usage details").not.toBe("");
      return JSON.parse(usage);
    });
    expect(usages).toEqual([
      {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
      {
        prompt_tokens: 150,
        completion_tokens: 30,
        total_tokens: 180,
        prompt_tokens_details: { cached_tokens: 50 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    ]);
    // One tool span, nested under a generation, with the captured command output.
    const tools = spans.filter((s) => obsType(s) === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("exec_command");
    expect(attr(tools[0], "langfuse.observation.metadata.codex.tool_name")).toBe("exec_command");
    expect(attr(tools[0], "langfuse.observation.output")).toContain("file1.txt");
    expect(generations.map((g) => g.spanContext().spanId)).toContain(parentId(tools[0]));
  });

  it("nests subagent turns under the spawning turn and marks errors/interruptions", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-parent.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "Codex Turn" && obsType(s) === "agent");
    const child = spans.find((s) => s.name === "Codex Subagent Turn" && obsType(s) === "agent");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(spans.filter((s) => obsType(s) === "agent")).toHaveLength(2);
    expect(parentId(parent!)).toBeUndefined();
    expect(parentId(child!)).toBeDefined();

    // The subagent turn is nested somewhere under the parent's trace.
    expect(child!.spanContext().traceId).toBe(parent!.spanContext().traceId);
    expect(attr(child!, "langfuse.observation.input")).toContain("tell a joke");

    // Subagent generations are distinguishable from main-thread ones.
    const childGeneration = spans.find(
      (s) => obsType(s) === "generation" && parentId(s) === child!.spanContext().spanId,
    );
    expect(childGeneration?.name).toBe("LLM Subagent");

    // Aborted turn is flagged on the parent root.
    expect(attr(parent!, "langfuse.observation.level")).toBe("WARNING");

    // The failing exec is recorded as an ERROR-level tool span.
    const failedTool = spans.find(
      (s) => obsType(s) === "tool" && attr(s, "langfuse.observation.level") === "ERROR",
    );
    expect(failedTool, "expected a failed tool span").toBeDefined();
    expect(attr(failedTool!, "langfuse.observation.status_message")).toContain("command failed");
  });

  it("exports only the child turn when a child rollout is converted directly", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-child-thread-child.jsonl"), {
      config: baseConfig,
    });

    const roots = exporter.getFinishedSpans().filter((span) => obsType(span) === "agent");
    expect(roots).toHaveLength(1);
    expect(roots[0].name).toBe("Codex Subagent Turn");
    expect(attr(roots[0], "langfuse.observation.metadata.codex.thread_id")).toBe("thread-child");
    expect(attr(roots[0], "langfuse.observation.input")).toContain("tell a joke");
    expect(attr(roots[0], "langfuse.observation.input")).not.toContain("copied parent prompt");
  });

  it("nests subagent turns discovered via sub_agent_activity events", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-activity-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === "Codex Turn" && obsType(s) === "agent");
    const childTurns = spans.filter(
      (s) => s.name === "Codex Subagent Turn" && obsType(s) === "agent",
    );
    expect(parent).toBeDefined();
    // Exactly one child (the kind filter itself is pinned at parse level,
    // where non-"started" activities target distinct thread ids).
    expect(childTurns).toHaveLength(1);
    const child = childTurns[0];
    expect(child.spanContext().traceId).toBe(parent!.spanContext().traceId);
    expect(attr(child, "langfuse.observation.input")).toContain("compute the answer");

    const childGeneration = spans.find(
      (s) => obsType(s) === "generation" && parentId(s) === child.spanContext().spanId,
    );
    expect(childGeneration?.name).toBe("LLM Subagent");
    expect(attr(childGeneration!, "langfuse.observation.model.name")).toBe("gpt-5.4");
  });

  it("captures web search, local shell, and MCP tool calls with specific names", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-tools-main.jsonl"), { config: baseConfig });

    const spans = exporter.getFinishedSpans();
    const toolNames = spans
      .filter((s) => obsType(s) === "tool")
      .map((s) => s.name)
      .sort();
    // Call arguments (command, query) stay out of the name — they are the input.
    expect(toolNames).toEqual(["linear.create_issue", "local_shell", "web_search"]);

    const webSearch = spans.find((s) => s.name === "web_search")!;
    expect(attr(webSearch, "langfuse.observation.input")).toContain("langfuse codex plugin");

    const shell = spans.find((s) => s.name === "local_shell")!;
    expect(attr(shell, "langfuse.observation.output")).toContain("clean");
  });

  it("records a Stop turn before task_complete and does not re-emit it", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");
    const complete = fs.readFileSync(file, "utf8");
    const pending =
      complete
        .trim()
        .split("\n")
        .filter((line) => JSON.parse(line).payload.type !== "task_complete")
        .join("\n") + "\n";
    fs.writeFileSync(file, pending);
    await convertRollout(file, { config: baseConfig, stopTurnId: "turn-1" });
    expect(exporter.getFinishedSpans().filter((s) => s.name === "Codex Turn")).toHaveLength(1);
    expect(fs.readFileSync(`${file}.langfuse`, "utf8").trim()).toBe("turn-1");
    exporter.reset();
    await convertRollout(file, { config: baseConfig, stopTurnId: "turn-1" });
    fs.writeFileSync(file, complete);
    await convertRollout(file, { config: baseConfig });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it.each([undefined, "another-turn"])(
    "defers an unfinished turn without a matching Stop id (%s)",
    async (stopTurnId) => {
      const dir = stageFixtures();
      const file = path.join(dir, "rollout-basic-main.jsonl");
      const complete = fs.readFileSync(file, "utf8");
      fs.writeFileSync(
        file,
        complete
          .trim()
          .split("\n")
          .filter((line) => JSON.parse(line).payload.type !== "task_complete")
          .join("\n") + "\n",
      );
      await convertRollout(file, { config: baseConfig, stopTurnId });
      expect(exporter.getFinishedSpans()).toHaveLength(0);
      expect(fs.existsSync(`${file}.langfuse`)).toBe(false);
      fs.writeFileSync(file, complete);
      await convertRollout(file, { config: baseConfig });
      expect(exporter.getFinishedSpans().filter((s) => s.name === "Codex Turn")).toHaveLength(1);
    },
  );

  it("never exports settings-only traces across repeated hooks", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");
    const complete = fs.readFileSync(file, "utf8");
    const settings = JSON.stringify({
      timestamp: "2026-06-03T10:00:00.000Z",
      type: "event_msg",
      payload: { type: "thread_settings_applied" },
    });
    fs.writeFileSync(file, `${settings}\n${complete}${settings}\n`);
    await convertRollout(file, { config: baseConfig });
    expect(exporter.getFinishedSpans().filter((s) => s.name === "Codex Turn")).toHaveLength(1);
    exporter.reset();
    await convertRollout(file, { config: baseConfig });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("skips turns already recorded in the sidecar (dedup)", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-basic-main.jsonl");

    await convertRollout(file, { config: baseConfig });
    const firstCount = exporter.getFinishedSpans().length;
    expect(firstCount).toBeGreaterThan(0);
    expect(fs.existsSync(`${file}.langfuse`)).toBe(true);

    exporter.reset();
    await convertRollout(file, { config: baseConfig });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("deterministic trace ids (trace_seed)", () => {
  const seed = "ci-run-42";
  const seededConfig: Config = { ...baseConfig, trace_seed: seed };

  const turnRoots = () =>
    exporter
      .getFinishedSpans()
      .filter((s) => s.name === "Codex Turn" || s.name === "Codex Subagent Turn")
      .sort((a, b) => startMs(a) - startMs(b));

  it("derives the N-th main-thread turn's trace id from `${seed}:${N}`", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-two-turns-main.jsonl"), {
      config: seededConfig,
    });

    const roots = turnRoots();
    expect(roots).toHaveLength(2);
    expect(roots[0].spanContext().traceId).toBe(seededTraceId(`${seed}:1`));
    expect(roots[1].spanContext().traceId).toBe(seededTraceId(`${seed}:2`));

    // Every span (generations included) lands in one of the two seeded traces.
    const traceIds = new Set(exporter.getFinishedSpans().map((s) => s.spanContext().traceId));
    expect([...traceIds].sort()).toEqual(
      [seededTraceId(`${seed}:1`), seededTraceId(`${seed}:2`)].sort(),
    );
  });

  it("keeps generations and tool spans in the seeded trace", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-basic-main.jsonl"), { config: seededConfig });

    const spans = exporter.getFinishedSpans();
    const expected = seededTraceId(`${seed}:1`);
    expect(spans.length).toBeGreaterThan(2); // root + generations + tool
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(expected);
    }
    // Structure is unchanged: root agent span with its generations beneath it.
    const root = spans.find((s) => s.name === "Codex Turn")!;
    expect(obsType(root)).toBe("agent");
    const generations = spans.filter((s) => obsType(s) === "generation");
    expect(generations).toHaveLength(2);
    for (const gen of generations) {
      expect(parentId(gen)).toBe(root.spanContext().spanId);
    }
  });

  it("scopes subagent-thread rollouts by thread id so they don't collide", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-child-thread-child.jsonl"), {
      config: seededConfig,
    });

    const roots = turnRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].spanContext().traceId).toBe(seededTraceId(`${seed}:thread-child:1`));
    expect(roots[0].spanContext().traceId).not.toBe(seededTraceId(`${seed}:1`));
  });

  it("nests subagent turns inside the parent's seeded trace", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-parent.jsonl"), { config: seededConfig });

    const roots = turnRoots();
    expect(roots).toHaveLength(2); // parent turn + nested subagent turn
    const expected = seededTraceId(`${seed}:1`);
    for (const root of roots) {
      expect(root.spanContext().traceId).toBe(expected);
    }
  });

  it("leaves trace ids auto-generated when the seed is unset", async () => {
    const dir = stageFixtures();
    await convertRollout(path.join(dir, "rollout-two-turns-main.jsonl"), { config: baseConfig });

    const roots = turnRoots();
    expect(roots).toHaveLength(2);
    for (const root of roots) {
      // Same shape as before the feature: true root span, random trace id.
      expect(parentId(root)).toBeUndefined();
      expect(root.spanContext().traceId).not.toBe(seededTraceId(`${seed}:1`));
      expect(root.spanContext().traceId).not.toBe(seededTraceId(`${seed}:2`));
    }
    expect(roots[0].spanContext().traceId).not.toBe(roots[1].spanContext().traceId);
  });

  it("keeps sidecar dedup working when a seed is set", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-two-turns-main.jsonl");

    await convertRollout(file, { config: seededConfig });
    expect(turnRoots()).toHaveLength(2);
    expect(fs.existsSync(`${file}.langfuse`)).toBe(true);

    exporter.reset();
    await convertRollout(file, { config: seededConfig });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("numbers turns over the full rollout even when earlier turns are deduped", async () => {
    const dir = stageFixtures();
    const file = path.join(dir, "rollout-two-turns-main.jsonl");

    // Pretend turn 1 was uploaded by a previous hook invocation.
    fs.writeFileSync(`${file}.langfuse`, "turn-a\n");
    await convertRollout(file, { config: seededConfig });

    const roots = turnRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].spanContext().traceId).toBe(seededTraceId(`${seed}:2`));
  });
});
