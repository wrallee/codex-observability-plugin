import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = new URL("../plugins/tracing/dist/index.mjs", import.meta.url);
let previous;
try {
  previous = readFileSync(bundle);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.error("Missing marketplace bundle. Run pnpm run build and commit dist/index.mjs.");
  process.exit(1);
}
const build = spawnSync(
  process.execPath,
  ["node_modules/tsdown/dist/run.mjs", "--config", "plugins/tracing/tsdown.config.ts"],
  {
    cwd: root,
    stdio: "inherit",
  },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
if (!previous.equals(readFileSync(bundle))) {
  console.error("Stale marketplace bundle. Commit the rebuilt plugins/tracing/dist/index.mjs.");
  process.exit(1);
}
