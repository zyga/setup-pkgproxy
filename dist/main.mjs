import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);
import {
  CACHE_DIR,
  HttpClient,
  State,
  __toESM,
  configureHost,
  cp,
  debug,
  exec,
  getBooleanInput,
  getInput,
  group,
  info,
  isDebug,
  mkdirP,
  require_semver,
  restoreCache,
  rmRF,
  saveCache,
  saveState,
  setFailed,
  setOutput,
  snapshot,
  start,
  sudo,
  warning
} from "./chunks/chunk-HLYXLDP2.mjs";

// src/main.ts
import { randomBytes } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join as join3 } from "node:path";

// src/go.ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join as join2 } from "node:path";

// node_modules/@actions/tool-cache/lib/tool-cache.js
import * as crypto from "crypto";
import * as fs from "fs";

// node_modules/@actions/tool-cache/lib/manifest.js
var semver = __toESM(require_semver(), 1);

// node_modules/@actions/tool-cache/lib/tool-cache.js
import * as os from "os";
import * as path from "path";
var semver2 = __toESM(require_semver(), 1);
import * as stream from "stream";
import * as util from "util";
import { ok } from "assert";

// node_modules/@actions/tool-cache/lib/retry-helper.js
var __awaiter = function(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
};
var RetryHelper = class {
  constructor(maxAttempts, minSeconds, maxSeconds) {
    if (maxAttempts < 1) {
      throw new Error("max attempts should be greater than or equal to 1");
    }
    this.maxAttempts = maxAttempts;
    this.minSeconds = Math.floor(minSeconds);
    this.maxSeconds = Math.floor(maxSeconds);
    if (this.minSeconds > this.maxSeconds) {
      throw new Error("min seconds should be less than or equal to max seconds");
    }
  }
  execute(action, isRetryable) {
    return __awaiter(this, void 0, void 0, function* () {
      let attempt = 1;
      while (attempt < this.maxAttempts) {
        try {
          return yield action();
        } catch (err) {
          if (isRetryable && !isRetryable(err)) {
            throw err;
          }
          info(err.message);
        }
        const seconds = this.getSleepAmount();
        info(`Waiting ${seconds} seconds before trying again`);
        yield this.sleep(seconds);
        attempt++;
      }
      return yield action();
    });
  }
  getSleepAmount() {
    return Math.floor(Math.random() * (this.maxSeconds - this.minSeconds + 1)) + this.minSeconds;
  }
  sleep(seconds) {
    return __awaiter(this, void 0, void 0, function* () {
      return new Promise((resolve) => setTimeout(resolve, seconds * 1e3));
    });
  }
};

// node_modules/@actions/tool-cache/lib/tool-cache.js
var __awaiter2 = function(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
};
var HTTPError = class extends Error {
  constructor(httpStatusCode) {
    super(`Unexpected HTTP response: ${httpStatusCode}`);
    this.httpStatusCode = httpStatusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var IS_WINDOWS = process.platform === "win32";
var IS_MAC = process.platform === "darwin";
var userAgent = "actions/tool-cache";
function downloadTool(url, dest, auth, headers) {
  return __awaiter2(this, void 0, void 0, function* () {
    dest = dest || path.join(_getTempDirectory(), crypto.randomUUID());
    yield mkdirP(path.dirname(dest));
    debug(`Downloading ${url}`);
    debug(`Destination ${dest}`);
    const maxAttempts = 3;
    const minSeconds = _getGlobal("TEST_DOWNLOAD_TOOL_RETRY_MIN_SECONDS", 10);
    const maxSeconds = _getGlobal("TEST_DOWNLOAD_TOOL_RETRY_MAX_SECONDS", 20);
    const retryHelper = new RetryHelper(maxAttempts, minSeconds, maxSeconds);
    return yield retryHelper.execute(() => __awaiter2(this, void 0, void 0, function* () {
      return yield downloadToolAttempt(url, dest || "", auth, headers);
    }), (err) => {
      if (err instanceof HTTPError && err.httpStatusCode) {
        if (err.httpStatusCode < 500 && err.httpStatusCode !== 408 && err.httpStatusCode !== 429) {
          return false;
        }
      }
      return true;
    });
  });
}
function downloadToolAttempt(url, dest, auth, headers) {
  return __awaiter2(this, void 0, void 0, function* () {
    if (fs.existsSync(dest)) {
      throw new Error(`Destination file path ${dest} already exists`);
    }
    const http = new HttpClient(userAgent, [], {
      allowRetries: false
    });
    if (auth) {
      debug("set auth");
      if (headers === void 0) {
        headers = {};
      }
      headers.authorization = auth;
    }
    const response = yield http.get(url, headers);
    if (response.message.statusCode !== 200) {
      const err = new HTTPError(response.message.statusCode);
      debug(`Failed to download from "${url}". Code(${response.message.statusCode}) Message(${response.message.statusMessage})`);
      throw err;
    }
    const pipeline2 = util.promisify(stream.pipeline);
    const responseMessageFactory = _getGlobal("TEST_DOWNLOAD_TOOL_RESPONSE_MESSAGE_FACTORY", () => response.message);
    const readStream = responseMessageFactory();
    let succeeded = false;
    try {
      yield pipeline2(readStream, fs.createWriteStream(dest));
      debug("download complete");
      succeeded = true;
      return dest;
    } finally {
      if (!succeeded) {
        debug("download failed");
        try {
          yield rmRF(dest);
        } catch (err) {
          debug(`Failed to delete '${dest}'. ${err.message}`);
        }
      }
    }
  });
}
function extractTar(file_1, dest_1) {
  return __awaiter2(this, arguments, void 0, function* (file, dest, flags = "xz") {
    if (!file) {
      throw new Error("parameter 'file' is required");
    }
    dest = yield _createExtractFolder(dest);
    debug("Checking tar --version");
    let versionOutput = "";
    yield exec("tar --version", [], {
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data) => versionOutput += data.toString(),
        stderr: (data) => versionOutput += data.toString()
      }
    });
    debug(versionOutput.trim());
    const isGnuTar = versionOutput.toUpperCase().includes("GNU TAR");
    let args;
    if (flags instanceof Array) {
      args = flags;
    } else {
      args = [flags];
    }
    if (isDebug() && !flags.includes("v")) {
      args.push("-v");
    }
    let destArg = dest;
    let fileArg = file;
    if (IS_WINDOWS && isGnuTar) {
      args.push("--force-local");
      destArg = dest.replace(/\\/g, "/");
      fileArg = file.replace(/\\/g, "/");
    }
    if (isGnuTar) {
      args.push("--warning=no-unknown-keyword");
      args.push("--overwrite");
    }
    args.push("-C", destArg, "-f", fileArg);
    yield exec(`tar`, args);
    return dest;
  });
}
function cacheDir(sourceDir, tool, version, arch2) {
  return __awaiter2(this, void 0, void 0, function* () {
    version = semver2.clean(version) || version;
    arch2 = arch2 || os.arch();
    debug(`Caching tool ${tool} ${version} ${arch2}`);
    debug(`source dir: ${sourceDir}`);
    if (!fs.statSync(sourceDir).isDirectory()) {
      throw new Error("sourceDir is not a directory");
    }
    const destPath = yield _createToolPath(tool, version, arch2);
    for (const itemName of fs.readdirSync(sourceDir)) {
      const s = path.join(sourceDir, itemName);
      yield cp(s, destPath, { recursive: true });
    }
    _completeToolPath(tool, version, arch2);
    return destPath;
  });
}
function find(toolName, versionSpec, arch2) {
  if (!toolName) {
    throw new Error("toolName parameter is required");
  }
  if (!versionSpec) {
    throw new Error("versionSpec parameter is required");
  }
  arch2 = arch2 || os.arch();
  if (!isExplicitVersion(versionSpec)) {
    const localVersions = findAllVersions(toolName, arch2);
    const match = evaluateVersions(localVersions, versionSpec);
    versionSpec = match;
  }
  let toolPath = "";
  if (versionSpec) {
    versionSpec = semver2.clean(versionSpec) || "";
    const cachePath = path.join(_getCacheDirectory(), toolName, versionSpec, arch2);
    debug(`checking cache: ${cachePath}`);
    if (fs.existsSync(cachePath) && fs.existsSync(`${cachePath}.complete`)) {
      debug(`Found tool in cache ${toolName} ${versionSpec} ${arch2}`);
      toolPath = cachePath;
    } else {
      debug("not found");
    }
  }
  return toolPath;
}
function findAllVersions(toolName, arch2) {
  const versions = [];
  arch2 = arch2 || os.arch();
  const toolPath = path.join(_getCacheDirectory(), toolName);
  if (fs.existsSync(toolPath)) {
    const children = fs.readdirSync(toolPath);
    for (const child of children) {
      if (isExplicitVersion(child)) {
        const fullPath = path.join(toolPath, child, arch2 || "");
        if (fs.existsSync(fullPath) && fs.existsSync(`${fullPath}.complete`)) {
          versions.push(child);
        }
      }
    }
  }
  return versions;
}
function _createExtractFolder(dest) {
  return __awaiter2(this, void 0, void 0, function* () {
    if (!dest) {
      dest = path.join(_getTempDirectory(), crypto.randomUUID());
    }
    yield mkdirP(dest);
    return dest;
  });
}
function _createToolPath(tool, version, arch2) {
  return __awaiter2(this, void 0, void 0, function* () {
    const folderPath = path.join(_getCacheDirectory(), tool, semver2.clean(version) || version, arch2 || "");
    debug(`destination ${folderPath}`);
    const markerPath = `${folderPath}.complete`;
    yield rmRF(folderPath);
    yield rmRF(markerPath);
    yield mkdirP(folderPath);
    return folderPath;
  });
}
function _completeToolPath(tool, version, arch2) {
  const folderPath = path.join(_getCacheDirectory(), tool, semver2.clean(version) || version, arch2 || "");
  const markerPath = `${folderPath}.complete`;
  fs.writeFileSync(markerPath, "");
  debug("finished caching tool");
}
function isExplicitVersion(versionSpec) {
  const c = semver2.clean(versionSpec) || "";
  debug(`isExplicit: ${c}`);
  const valid2 = semver2.valid(c) != null;
  debug(`explicit? ${valid2}`);
  return valid2;
}
function evaluateVersions(versions, versionSpec) {
  let version = "";
  debug(`evaluating ${versions.length} versions`);
  versions = versions.sort((a, b) => {
    if (semver2.gt(a, b)) {
      return 1;
    }
    return -1;
  });
  for (let i = versions.length - 1; i >= 0; i--) {
    const potential = versions[i];
    const satisfied = semver2.satisfies(potential, versionSpec);
    if (satisfied) {
      version = potential;
      break;
    }
  }
  if (version) {
    debug(`matched: ${version}`);
  } else {
    debug("match not found");
  }
  return version;
}
function _getCacheDirectory() {
  const cacheDirectory = process.env["RUNNER_TOOL_CACHE"] || "";
  ok(cacheDirectory, "Expected RUNNER_TOOL_CACHE to be defined");
  return cacheDirectory;
}
function _getTempDirectory() {
  const tempDirectory = process.env["RUNNER_TEMP"] || "";
  ok(tempDirectory, "Expected RUNNER_TEMP to be defined");
  return tempDirectory;
}
function _getGlobal(key, defaultValue) {
  const value = global[key];
  return value !== void 0 ? value : defaultValue;
}

// src/go.ts
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
async function sha256File(path2) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path2)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
async function ensureGo(version) {
  const cached = find("go", version);
  if (cached) {
    info(`Using Go ${version} from the tool cache: ${cached}`);
    return join2(cached, "bin");
  }
  const filename = `go${version}.linux-${goArch(process.arch)}.tar.gz`;
  info(`Downloading ${GO_DL}${filename}`);
  const [archive, want] = await Promise.all([downloadTool(`${GO_DL}${filename}`), publishedSha256(filename)]);
  const got = await sha256File(archive);
  if (got !== want) {
    throw new Error(`${filename} has SHA-256 ${got}, but go.dev publishes ${want}`);
  }
  const extracted = await extractTar(archive);
  const dir = await cacheDir(join2(extracted, "go"), "go", version);
  return join2(dir, "bin");
}

// src/keys.ts
function binaryCacheKey(prefix, version, goVersion, arch2) {
  return `${prefix}-${version}-go${goVersion}-${arch2}`;
}
function packageCacheKeys(prefix, arch2, id) {
  const restorePrefix = `${prefix}-${arch2}-`;
  return {
    save: `${restorePrefix}${id.runId}-${id.runAttempt}-${sanitize(id.job)}-${id.nonce}`,
    restorePrefix
  };
}
function sanitize(s) {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64) || "job";
}

// src/main.ts
function env(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is not set: this action must run in GitHub Actions`);
  }
  return v;
}
async function exists(path2) {
  try {
    await access(path2);
    return true;
  } catch {
    return false;
  }
}
async function pkgproxyBinary(version, goVersion, prefix, arch2) {
  const binDir = join3(env("RUNNER_TEMP"), "setup-pkgproxy", "bin");
  const binary = join3(binDir, "pkgproxy");
  const key = binaryCacheKey(prefix, version, goVersion, arch2);
  const hit = await restoreCache([binDir], key);
  if (hit && await exists(binary)) {
    info(`Restored pkgproxy ${version} from cache ${hit}`);
    return binary;
  }
  const goBin = await ensureGo(goVersion);
  await mkdir(binDir, { recursive: true });
  await exec(join3(goBin, "go"), ["install", `gitlab.com/zygoon/pkgproxy/cmd/pkgproxy@${version}`], {
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
    await saveCache([binDir], key);
  } catch (err) {
    warning(`Cannot cache the pkgproxy binary: ${err instanceof Error ? err.message : String(err)}`);
  }
  return binary;
}
async function run() {
  const version = getInput("version", { required: true });
  const goVersion = getInput("go-version", { required: true });
  const addr = getInput("addr", { required: true });
  const configure = getBooleanInput("configure-host");
  const arch2 = env("RUNNER_ARCH");
  const binary = await group(
    "Build or restore pkgproxy",
    () => pkgproxyBinary(version, goVersion, getInput("binary-cache-key", { required: true }), arch2)
  );
  await sudo(["install", "-m", "0755", binary, "/usr/local/bin/pkgproxy"]);
  await sudo(["ln", "-sf", "pkgproxy", "/usr/local/bin/pkgproxyctl"]);
  const keys = packageCacheKeys(getInput("package-cache-key", { required: true }), arch2, {
    runId: env("GITHUB_RUN_ID"),
    runAttempt: env("GITHUB_RUN_ATTEMPT"),
    job: env("GITHUB_JOB"),
    nonce: randomBytes(3).toString("hex")
  });
  const restored = await group("Restore the package cache", async () => {
    await sudo(["mkdir", "-p", CACHE_DIR]);
    await sudo(["chown", "-R", `${process.getuid?.()}:${process.getgid?.()}`, CACHE_DIR]);
    const key = await restoreCache([CACHE_DIR], keys.save, [keys.restorePrefix]) ?? "";
    info(key ? `Restored the package cache from ${key}` : `No package cache under ${keys.restorePrefix} yet`);
    const manifest = await snapshot(CACHE_DIR);
    const manifestPath = join3(env("RUNNER_TEMP"), `setup-pkgproxy-manifest-${keys.save}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest));
    info(`${Object.keys(manifest).length} files in the package cache`);
    saveState(State.manifestPath, manifestPath);
    saveState(State.restoredKey, key);
    saveState(State.saveKey, keys.save);
    return key;
  });
  await group("Start pkgproxy", () => start(addr));
  if (configure) {
    await group("Point apt and snapd at pkgproxy", () => configureHost(addr));
  }
  setOutput("addr", addr);
  setOutput("cache-dir", CACHE_DIR);
  setOutput("package-cache-restored-key", restored);
  setOutput("package-cache-key", keys.save);
}
run().catch((err) => {
  setFailed(err instanceof Error ? err.message : String(err));
});
