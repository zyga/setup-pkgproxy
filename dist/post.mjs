import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/post.ts
import { readFile } from "node:fs/promises";
import { cache, core } from "#vendor";

// src/daemon.ts
import { rm, stat } from "node:fs/promises";
import { exec } from "#vendor";
var UNIT = "pkgproxy.service";
var CACHE_DIR = "/var/cache/pkgproxy";
var ARCHIVE_DIR = "/var/cache/pkgproxy-archive";
var ARCHIVE = `${ARCHIVE_DIR}/cache.tar`;
var RUNTIME_DIR = "/run/pkgproxy";
var SOCKETS = [`${RUNTIME_DIR}/stats.sock`, `${RUNTIME_DIR}/admin.sock`];
async function sudo(args, options = {}) {
  return exec.exec("sudo", args, options);
}
async function dumpStatus() {
  await sudo(["systemctl", "status", UNIT, "--no-pager"], { ignoreReturnCode: true });
  await sudo(["journalctl", "-u", UNIT, "--no-pager", "-n", "100"], { ignoreReturnCode: true });
}
async function stats() {
  const out = await exec.getExecOutput("pkgproxyctl", ["stats"], { ignoreReturnCode: true, silent: true });
  return out.exitCode === 0 ? out.stdout.trim() : "";
}
function runnerOwner() {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === void 0 || gid === void 0) {
    throw new Error("cannot tell the runner user's uid and gid");
  }
  return `${uid}:${gid}`;
}
async function releaseDirs() {
  await sudo(["mkdir", "-p", CACHE_DIR, ARCHIVE_DIR]);
  await sudo(["chown", "-R", runnerOwner(), CACHE_DIR, ARCHIVE_DIR]);
}
async function stopAndReleaseCache() {
  await sudo(["systemctl", "stop", UNIT], { ignoreReturnCode: true });
  await releaseDirs();
  try {
    return (await stat(ARCHIVE)).isFile();
  } catch {
    await dumpStatus();
    return false;
  }
}

// src/manifest.ts
import { readdir, lstat } from "node:fs/promises";
import { join, relative } from "node:path";
var IGNORED = /* @__PURE__ */ new Set(["stats.json"]);
async function snapshot(dir) {
  const out = {};
  let entries;
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      return out;
    }
    throw err;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const st = await lstat(path);
    if (!st.isFile()) {
      continue;
    }
    const rel = relative(dir, path);
    if (!IGNORED.has(rel)) {
      out[rel] = st.size;
    }
  }
  return out;
}
function diff(before, after) {
  let added = 0;
  let resized = 0;
  let bytes = 0;
  let files = 0;
  for (const [path, size] of Object.entries(after)) {
    files++;
    bytes += size;
    const old = before[path];
    if (old === void 0) {
      added++;
    } else if (old !== size) {
      resized++;
    }
  }
  let removed = 0;
  for (const path of Object.keys(before)) {
    if (!(path in after)) {
      removed++;
    }
  }
  return { added, removed, resized, bytes, files };
}
function changed(d) {
  return d.added + d.removed + d.resized > 0;
}

// src/state.ts
var State = {
  /** The key the post step saves the package cache under. */
  saveKey: "save-key",
  /** The key the package cache was restored from, or "". */
  restoredKey: "restored-key",
  /** A JSON file with the cache's manifest right after restore. */
  manifestPath: "manifest-path",
  /** "true" when save-package-cache lets this run save the cache. */
  saveAllowed: "save-allowed",
  /** Why it may or may not, in words. */
  saveReason: "save-reason"
};

// src/post.ts
function mib(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
async function run() {
  const saveKey = core.getState(State.saveKey);
  if (!saveKey) {
    core.info("The main step did not restore the package cache, so there is nothing to save.");
    return;
  }
  const restoredKey = core.getState(State.restoredKey);
  const statsText = await stats();
  const archived = await stopAndReleaseCache();
  const before = JSON.parse(await readFile(core.getState(State.manifestPath), "utf8"));
  const d = diff(before, await snapshot(CACHE_DIR));
  core.info(
    `Package cache: ${d.files} files, ${mib(d.bytes)}; ${d.added} added, ${d.removed} removed, ${d.resized} changed size since restore.`
  );
  let outcome;
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
      { data: "", header: true }
    ],
    ["Restored from", restoredKey || "nothing (cold start)"],
    ["Files", `${d.files} (${mib(d.bytes)})`],
    ["Since restore", `${d.added} added, ${d.removed} removed, ${d.resized} changed size`],
    ["Saved", outcome]
  ]);
  if (statsText) {
    summary.addDetails("pkgproxyctl stats", `

\`\`\`
${statsText}
\`\`\`
`);
  }
  await summary.write();
}
run().catch((err) => {
  core.warning(`setup-pkgproxy post step: ${err instanceof Error ? err.message : String(err)}`);
});
