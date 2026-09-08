import * as fs from "node:fs/promises";

/**
 * Per-rollout dedup ledger.
 *
 * The `Stop` hook fires after every Codex turn and re-reads the whole rollout
 * file, so completed turns would be re-uploaded each time. We record uploaded
 * turn ids in a sidecar file (`<rolloutFile>.langfuse`) and skip them on
 * subsequent invocations. A matching Stop hook also finalizes its turn before
 * task_complete is persisted. Other unfinished turns are deferred.
 */
export async function loadUploadedTurnIds(rolloutFile: string): Promise<Set<string>> {
  try {
    const data = await fs.readFile(`${rolloutFile}.langfuse`, "utf-8");
    return new Set(data.split("\n").filter(Boolean));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

export async function markTurnUploaded(rolloutFile: string, turnId: string): Promise<void> {
  try {
    await fs.appendFile(`${rolloutFile}.langfuse`, `${turnId}\n`, "utf-8");
  } catch {
    // Best-effort: a failed write only risks a duplicate upload next time.
  }
}
