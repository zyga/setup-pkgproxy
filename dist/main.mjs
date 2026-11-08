import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/main.ts
import { randomBytes } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join as join3 } from "node:path";
import { cache, core as core3, exec as exec2 } from "#vendor";

// src/daemon.ts
import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { core, exec } from "#vendor";

// pkgproxy.service
var pkgproxy_default = "# SPDX-License-Identifier: Apache-2.0\n# SPDX-FileCopyrightText: Zygmunt Krynicki\n#\n# pkgproxy caching proxy daemon. Installed to /etc/systemd/system/ by the\n# setup-pkgproxy action. RuntimeDirectory=/CacheDirectory= make systemd create\n# /run/pkgproxy and /var/cache/pkgproxy (recursively chowning the latter to root\n# at start, since the unit runs as root), so no manual mkdir/chown is needed.\n[Unit]\nDescription=pkgproxy caching proxy (apt, snap, go modules, LXD images)\nDocumentation=https://gitlab.com/zygoon/pkgproxy\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nRestart=no\nRuntimeDirectory=pkgproxy\nCacheDirectory=pkgproxy\n# $RUNTIME_DIRECTORY/$CACHE_DIRECTORY are set by systemd from the directives\n# above, so the paths stay in one place (the directives), not repeated here.\n# @ADDR@ is substituted by the action's main step (src/daemon.ts) with the listen\n# address.\nExecStart=/usr/local/bin/pkgproxy \\\n    -addr @ADDR@ \\\n    -cache-dir ${CACHE_DIRECTORY} \\\n    -stats-socket-path ${RUNTIME_DIRECTORY}/stats.sock \\\n    -admin-socket-path ${RUNTIME_DIRECTORY}/admin.sock\n\n[Install]\nWantedBy=multi-user.target\n";

// src/daemon.ts
var UNIT = "pkgproxy.service";
var CACHE_DIR = "/var/cache/pkgproxy";
var RUNTIME_DIR = "/run/pkgproxy";
var SOCKETS = [`${RUNTIME_DIR}/stats.sock`, `${RUNTIME_DIR}/admin.sock`];
function renderUnit(template, addr) {
  return template.replaceAll("@ADDR@", addr);
}
async function sudo(args, options = {}) {
  return exec.exec("sudo", args, options);
}
async function start(addr) {
  await sudo(["mkdir", "-p", "/etc/systemd/system"]);
  await sudo(["tee", `/etc/systemd/system/${UNIT}`], {
    input: Buffer.from(renderUnit(pkgproxy_default, addr)),
    silent: true
  });
  await sudo(["systemctl", "daemon-reload"]);
  await sudo(["systemctl", "start", UNIT]);
  for (let i = 0; i < 100; i++) {
    if (await allSockets()) {
      return;
    }
    await sleep(100);
  }
  await dumpStatus();
  throw new Error("pkgproxy did not create its control sockets in time");
}
async function allSockets() {
  for (const path of SOCKETS) {
    try {
      if (!(await stat(path)).isSocket()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}
async function dumpStatus() {
  await sudo(["systemctl", "status", UNIT, "--no-pager"], { ignoreReturnCode: true });
  await sudo(["journalctl", "-u", UNIT, "--no-pager", "-n", "100"], { ignoreReturnCode: true });
}
async function configureHost(addr) {
  for (const client of ["apt", "snap"]) {
    await exec.exec("bash", ["-c", `set -o pipefail; pkgproxyctl setup ${client} -addr "$ADDR" | sudo sh`], {
      env: { ...process.env, ADDR: addr }
    });
  }
}

// src/go.ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { core as core2, tc } from "#vendor";
var GO_DL = "https://go.dev/dl/";
function goArch(nodeArch) {
  switch (nodeArch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    default:
      throw new Error(`unsupported runner CPU arch for Go: ${nodeArch}`);
  }
}
async function publishedSha256(filename) {
  const res = await fetch(`${GO_DL}?mode=json&include=all`);
  if (!res.ok) {
    throw new Error(`cannot list Go releases: ${GO_DL} answered HTTP ${res.status}`);
  }
  const releases = await res.json();
  for (const r of releases) {
    for (const f of r.files) {
      if (f.filename === filename) {
        return f.sha256;
      }
    }
  }
  throw new Error(`go.dev lists no ${filename}: is the go-version input a real Go release?`);
}
async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
async function ensureGo(version) {
  const cached = tc.find("go", version);
  if (cached) {
    core2.info(`Using Go ${version} from the tool cache: ${cached}`);
    return join(cached, "bin");
  }
  const filename = `go${version}.linux-${goArch(process.arch)}.tar.gz`;
  core2.info(`Downloading ${GO_DL}${filename}`);
  const [archive, want] = await Promise.all([tc.downloadTool(`${GO_DL}${filename}`), publishedSha256(filename)]);
  const got = await sha256File(archive);
  if (got !== want) {
    throw new Error(`${filename} has SHA-256 ${got}, but go.dev publishes ${want}`);
  }
  const extracted = await tc.extractTar(archive);
  const dir = await tc.cacheDir(join(extracted, "go"), "go", version);
  return join(dir, "bin");
}

// src/keys.ts
function binaryCacheKey(prefix, version, goVersion, arch) {
  return `${prefix}-${version}-go${goVersion}-${arch}`;
}
function packageCacheKeys(prefix, arch, id) {
  const restorePrefix = `${prefix}-${arch}-`;
  return {
    save: `${restorePrefix}${id.runId}-${id.runAttempt}-${sanitize(id.job)}-${id.nonce}`,
    restorePrefix
  };
}
function sanitize(s) {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64) || "job";
}

// src/manifest.ts
import { readdir, lstat } from "node:fs/promises";
import { join as join2, relative } from "node:path";
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
    const path = join2(dir, entry);
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

// src/state.ts
var State = {
  /** The key the post step saves the package cache under. */
  saveKey: "save-key",
  /** The key the package cache was restored from, or "". */
  restoredKey: "restored-key",
  /** A JSON file with the cache's manifest right after restore. */
  manifestPath: "manifest-path"
};

// src/main.ts
function env(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is not set: this action must run in GitHub Actions`);
  }
  return v;
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function pkgproxyBinary(version, goVersion, prefix, arch) {
  const binDir = join3(env("RUNNER_TEMP"), "setup-pkgproxy", "bin");
  const binary = join3(binDir, "pkgproxy");
  const key = binaryCacheKey(prefix, version, goVersion, arch);
  const hit = await cache.restoreCache([binDir], key);
  if (hit && await exists(binary)) {
    core3.info(`Restored pkgproxy ${version} from cache ${hit}`);
    return binary;
  }
  const goBin = await ensureGo(goVersion);
  await mkdir(binDir, { recursive: true });
  await exec2.exec(join3(goBin, "go"), ["install", `gitlab.com/zygoon/pkgproxy/cmd/pkgproxy@${version}`], {
    env: {
      ...process.env,
      GOBIN: binDir,
      // Build with exactly the toolchain asked for, never a newer one
      // that go.mod's toolchain line could pull in.
      GOTOOLCHAIN: "local",
      PATH: `${goBin}:${process.env.PATH ?? ""}`
    }
  });
  try {
    await cache.saveCache([binDir], key);
  } catch (err) {
    core3.warning(`Cannot cache the pkgproxy binary: ${err instanceof Error ? err.message : String(err)}`);
  }
  return binary;
}
async function run() {
  const version = core3.getInput("version", { required: true });
  const goVersion = core3.getInput("go-version", { required: true });
  const addr = core3.getInput("addr", { required: true });
  const configure = core3.getBooleanInput("configure-host");
  const arch = env("RUNNER_ARCH");
  const binary = await core3.group(
    "Build or restore pkgproxy",
    () => pkgproxyBinary(version, goVersion, core3.getInput("binary-cache-key", { required: true }), arch)
  );
  await sudo(["install", "-m", "0755", binary, "/usr/local/bin/pkgproxy"]);
  await sudo(["ln", "-sf", "pkgproxy", "/usr/local/bin/pkgproxyctl"]);
  const keys = packageCacheKeys(core3.getInput("package-cache-key", { required: true }), arch, {
    runId: env("GITHUB_RUN_ID"),
    runAttempt: env("GITHUB_RUN_ATTEMPT"),
    job: env("GITHUB_JOB"),
    nonce: randomBytes(3).toString("hex")
  });
  const restored = await core3.group("Restore the package cache", async () => {
    await sudo(["mkdir", "-p", CACHE_DIR]);
    await sudo(["chown", "-R", `${process.getuid?.()}:${process.getgid?.()}`, CACHE_DIR]);
    const key = await cache.restoreCache([CACHE_DIR], keys.save, [keys.restorePrefix]) ?? "";
    core3.info(key ? `Restored the package cache from ${key}` : `No package cache under ${keys.restorePrefix} yet`);
    const manifest = await snapshot(CACHE_DIR);
    const manifestPath = join3(env("RUNNER_TEMP"), `setup-pkgproxy-manifest-${keys.save}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest));
    core3.info(`${Object.keys(manifest).length} files in the package cache`);
    core3.saveState(State.manifestPath, manifestPath);
    core3.saveState(State.restoredKey, key);
    core3.saveState(State.saveKey, keys.save);
    return key;
  });
  await core3.group("Start pkgproxy", () => start(addr));
  if (configure) {
    await core3.group("Point apt and snapd at pkgproxy", () => configureHost(addr));
  }
  core3.setOutput("addr", addr);
  core3.setOutput("cache-dir", CACHE_DIR);
  core3.setOutput("package-cache-restored-key", restored);
  core3.setOutput("package-cache-key", keys.save);
}
run().catch((err) => {
  core3.setFailed(err instanceof Error ? err.message : String(err));
});
