import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);
import {
  CACHE_DIR,
  State,
  changed,
  diff,
  getState,
  info,
  saveCache,
  snapshot,
  stats,
  stopAndReleaseCache,
  summary,
  warning
} from "./chunks/chunk-HLYXLDP2.mjs";

// src/post.ts
import { readFile } from "node:fs/promises";
function mib(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
async function run() {
  const saveKey = getState(State.saveKey);
  if (!saveKey) {
    info("The main step did not restore the package cache, so there is nothing to save.");
    return;
  }
  const restoredKey = getState(State.restoredKey);
  const statsText = await stats();
  await stopAndReleaseCache();
  const before = JSON.parse(await readFile(getState(State.manifestPath), "utf8"));
  const d = diff(before, await snapshot(CACHE_DIR));
  info(
    `Package cache: ${d.files} files, ${mib(d.bytes)}; ${d.added} added, ${d.removed} removed, ${d.resized} changed size since restore.`
  );
  let outcome;
  if (!changed(d)) {
    outcome = "not saved: unchanged since restore";
  } else {
    try {
      const id = await saveCache([CACHE_DIR], saveKey);
      outcome = id === -1 ? "not saved: actions/cache could not save it (see above)" : `saved as ${saveKey}`;
    } catch (err) {
      outcome = `not saved: ${err instanceof Error ? err.message : String(err)}`;
      warning(`Cannot save the package cache: ${outcome}`);
    }
  }
  info(`Package cache ${outcome}`);
  const summary2 = summary.addHeading("pkgproxy", 3).addTable([
    [
      { data: "Package cache", header: true },
      { data: "", header: true }
    ],
    ["Restored from", restoredKey || "nothing (cold start)"],
    ["Files", `${d.files} (${mib(d.bytes)})`],
    ["Since restore", `${d.added} added, ${d.removed} removed, ${d.resized} changed size`],
    ["Saved", outcome]
  ]);
  if (statsText) {
    summary2.addDetails("pkgproxyctl stats", `

\`\`\`
${statsText}
\`\`\`
`);
  }
  await summary2.write();
}
run().catch((err) => {
  warning(`setup-pkgproxy post step: ${err instanceof Error ? err.message : String(err)}`);
});
