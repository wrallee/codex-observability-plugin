import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readStdin: vi.fn(),
  convertRollout: vi.fn(),
  shutdown: vi.fn(),
}));
vi.mock("../src/config.js", () => ({
  getConfig: async () => ({ enabled: true, public_key: "test", secret_key: "test" }),
}));
vi.mock("../src/utils.js", () => ({
  readStdin: mocks.readStdin,
  debugLog: vi.fn(),
  setDebug: vi.fn(),
}));
vi.mock("../src/trace.js", () => ({ convertRollout: mocks.convertRollout }));
vi.mock("../src/instrumentation.js", () => ({
  setupInstrumentation: () => ({ shutdown: mocks.shutdown }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("Stop hook turn identity", () => {
  it.each(["Stop", "SessionStart", undefined])(
    "forwards finalization only for Stop (%s)",
    async (hook_event_name) => {
      mocks.readStdin.mockResolvedValue({
        hook_event_name,
        turn_id: "turn-1",
        transcript_path: "/tmp/test-rollout.jsonl",
      });
      await import("../src/index.js");
      await vi.waitFor(() => expect(mocks.shutdown).toHaveBeenCalledOnce());
      expect(mocks.convertRollout).toHaveBeenCalledWith("/tmp/test-rollout.jsonl", {
        config: expect.any(Object),
        stopTurnId: hook_event_name === "Stop" ? "turn-1" : undefined,
      });
    },
  );
});
