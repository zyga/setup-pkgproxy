// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

// The action's post step, run at the end of the job whether it passed or
// failed: stop pkgproxy and save the package cache, if save-package-cache
// lets this run save (by default, only on the default branch: policy.ts)
// and the job added to the cache. A failed job's cache is a valid, smaller
// cache, so it is saved too.

import { readFile } from "node:fs/promises";
import { cache, core } from "#vendor";

import { ARCHIVE_DIR, CACHE_DIR, stats, stopAndReleaseCache } from "./daemon.ts";
import { changed, diff, snapshot, type Manifest } from "./manifest.ts";
import { State } from "./state.ts";

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function run(): Promise<void> {
  const saveKey = core.getState(State.saveKey);
  if (!saveKey) {
    core.info("The main step did not restore the package cache, so there is nothing to save.");
    return;
  }
  const restoredKey = core.getState(State.restoredKey);

  // Before stopping pkgproxy, which takes its stats socket down.
  const statsText = await stats();
  const archived = await stopAndReleaseCache();

  const before = JSON.parse(await readFile(core.getState(State.manifestPath), "utf8")) as Manifest;
  const d = diff(before, await snapshot(CACHE_DIR));
  core.info(
    `Package cache: ${d.files} files, ${mib(d.bytes)}; ` +
      `${d.added} added, ${d.removed} removed, ${d.resized} changed size since restore.`,
  );

  let outcome: string;
  if (core.getState(State.saveAllowed) !== "true") {
    outcome = `not saved: ${core.getState(State.saveReason)}`;
  } else if (!changed(d)) {
    outcome = "not saved: unchanged since restore";
  } else if (!archived) {
    outcome = "not saved: pkgproxy's unit did not archive the cache when it stopped (see its status above)";
    core.warning(`Package cache ${outcome}`);
  } else {
    try {
      const id = await cache.saveCache([ARCHIVE_DIR], saveKey);
      outcome = id === -1 ? "not saved: actions/cache could not save it (see above)" : `saved as ${saveKey}`;
    } catch (err) {
      outcome = `not saved: ${err instanceof Error ? err.message : String(err)}`;
      core.warning(`Cannot save the package cache: ${outcome}`);
    }
  }
  core.info(`Package cache ${outcome}`);

  const summary = core.summary.addHeading("pkgproxy", 3).addTable([
    [
      { data: "Package cache", header: true },
      { data: "", header: true },
    ],
    ["Restored from", restoredKey || "nothing (cold start)"],
    ["Files", `${d.files} (${mib(d.bytes)})`],
    ["Since restore", `${d.added} added, ${d.removed} removed, ${d.resized} changed size`],
    ["Saved", outcome],
  ]);
  if (statsText) {
    summary.addDetails("pkgproxyctl stats", `\n\n\`\`\`\n${statsText}\n\`\`\`\n`);
  }
  await summary.write();
}

run().catch((err: unknown) => {
  // A failing save must not fail a job that otherwise passed.
  core.warning(`setup-pkgproxy post step: ${err instanceof Error ? err.message : String(err)}`);
});
