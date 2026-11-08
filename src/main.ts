// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

// The action's main step: build or restore the pkgproxy binary, restore the
// package cache, start pkgproxy and (optionally) point apt and snapd at it.
// The post step (post.ts) saves the package cache at the end of the job.

import { randomBytes } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as exec from "@actions/exec";

import { CACHE_DIR, configureHost, start, sudo } from "./daemon.ts";
import { ensureGo } from "./go.ts";
import { binaryCacheKey, packageCacheKeys } from "./keys.ts";
import { snapshot } from "./manifest.ts";
import { State } from "./state.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is not set: this action must run in GitHub Actions`);
  }
  return v;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restores the pkgproxy binary built for this version, Go and arch, or
 * builds it with go install and caches it. Returns the binary's path.
 */
async function pkgproxyBinary(version: string, goVersion: string, prefix: string, arch: string): Promise<string> {
  // Under RUNNER_TEMP, not the workspace: the caller's checkout stays clean.
  const binDir = join(env("RUNNER_TEMP"), "setup-pkgproxy", "bin");
  const binary = join(binDir, "pkgproxy");
  const key = binaryCacheKey(prefix, version, goVersion, arch);
  const hit = await cache.restoreCache([binDir], key);
  if (hit && (await exists(binary))) {
    core.info(`Restored pkgproxy ${version} from cache ${hit}`);
    return binary;
  }
  const goBin = await ensureGo(goVersion);
  await mkdir(binDir, { recursive: true });
  await exec.exec(join(goBin, "go"), ["install", `gitlab.com/zygoon/pkgproxy/cmd/pkgproxy@${version}`], {
    env: {
      ...process.env,
      GOBIN: binDir,
      // Build with exactly the toolchain asked for, never a newer one
      // that go.mod's toolchain line could pull in.
      GOTOOLCHAIN: "local",
      PATH: `${goBin}:${process.env.PATH ?? ""}`,
    } as Record<string, string>,
  });
  try {
    await cache.saveCache([binDir], key);
  } catch (err) {
    core.warning(`Cannot cache the pkgproxy binary: ${err instanceof Error ? err.message : String(err)}`);
  }
  return binary;
}

async function run(): Promise<void> {
  const version = core.getInput("version", { required: true });
  const goVersion = core.getInput("go-version", { required: true });
  const addr = core.getInput("addr", { required: true });
  const configure = core.getBooleanInput("configure-host");
  const arch = env("RUNNER_ARCH");

  const binary = await core.group("Build or restore pkgproxy", () =>
    pkgproxyBinary(version, goVersion, core.getInput("binary-cache-key", { required: true }), arch),
  );

  // A stable path the unit's ExecStart names, already on every later
  // step's PATH. The binary dispatches on argv[0], so it is linked under
  // both of its names.
  await sudo(["install", "-m", "0755", binary, "/usr/local/bin/pkgproxy"]);
  await sudo(["ln", "-sf", "pkgproxy", "/usr/local/bin/pkgproxyctl"]);

  const keys = packageCacheKeys(core.getInput("package-cache-key", { required: true }), arch, {
    runId: env("GITHUB_RUN_ID"),
    runAttempt: env("GITHUB_RUN_ATTEMPT"),
    job: env("GITHUB_JOB"),
    nonce: randomBytes(3).toString("hex"),
  });

  const restored = await core.group("Restore the package cache", async () => {
    // actions/cache restores as the runner user. Once the unit starts, its
    // CacheDirectory= hands the directory to root.
    await sudo(["mkdir", "-p", CACHE_DIR]);
    await sudo(["chown", "-R", `${process.getuid?.()}:${process.getgid?.()}`, CACHE_DIR]);
    const key = (await cache.restoreCache([CACHE_DIR], keys.save, [keys.restorePrefix])) ?? "";
    core.info(key ? `Restored the package cache from ${key}` : `No package cache under ${keys.restorePrefix} yet`);

    const manifest = await snapshot(CACHE_DIR);
    const manifestPath = join(env("RUNNER_TEMP"), `setup-pkgproxy-manifest-${keys.save}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest));
    core.info(`${Object.keys(manifest).length} files in the package cache`);

    core.saveState(State.manifestPath, manifestPath);
    core.saveState(State.restoredKey, key);
    // Set last: the post step saves only once all of the above happened.
    core.saveState(State.saveKey, keys.save);
    return key;
  });

  await core.group("Start pkgproxy", () => start(addr));
  if (configure) {
    await core.group("Point apt and snapd at pkgproxy", () => configureHost(addr));
  }

  core.setOutput("addr", addr);
  core.setOutput("cache-dir", CACHE_DIR);
  core.setOutput("package-cache-restored-key", restored);
  core.setOutput("package-cache-key", keys.save);
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
