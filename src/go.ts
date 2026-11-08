// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

// The Go toolchain pkgproxy is built with, on a binary-cache miss. Like
// actions/setup-go, it is taken from the runner's tool cache when there
// (GitHub-hosted images carry several versions) and otherwise downloaded
// from go.dev and checked against the published SHA-256.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { core, tc } from "#vendor";

const GO_DL = "https://go.dev/dl/";

/** Go's name for the CPU arch, from Node's. */
export function goArch(nodeArch: string): string {
  switch (nodeArch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    default:
      throw new Error(`unsupported runner CPU arch for Go: ${nodeArch}`);
  }
}

interface GoRelease {
  version: string;
  files: { filename: string; os: string; arch: string; sha256: string; kind: string }[];
}

/** The SHA-256 go.dev publishes for one release archive. */
async function publishedSha256(filename: string): Promise<string> {
  const res = await fetch(`${GO_DL}?mode=json&include=all`);
  if (!res.ok) {
    throw new Error(`cannot list Go releases: ${GO_DL} answered HTTP ${res.status}`);
  }
  const releases = (await res.json()) as GoRelease[];
  for (const r of releases) {
    for (const f of r.files) {
      if (f.filename === filename) {
        return f.sha256;
      }
    }
  }
  throw new Error(`go.dev lists no ${filename}: is the go-version input a real Go release?`);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Returns the bin directory of Go `version` (such as "1.27.1"). */
export async function ensureGo(version: string): Promise<string> {
  const cached = tc.find("go", version);
  if (cached) {
    core.info(`Using Go ${version} from the tool cache: ${cached}`);
    return join(cached, "bin");
  }
  const filename = `go${version}.linux-${goArch(process.arch)}.tar.gz`;
  core.info(`Downloading ${GO_DL}${filename}`);
  const [archive, want] = await Promise.all([tc.downloadTool(`${GO_DL}${filename}`), publishedSha256(filename)]);
  const got = await sha256File(archive);
  if (got !== want) {
    throw new Error(`${filename} has SHA-256 ${got}, but go.dev publishes ${want}`);
  }
  const extracted = await tc.extractTar(archive);
  const dir = await tc.cacheDir(join(extracted, "go"), "go", version);
  return join(dir, "bin");
}
