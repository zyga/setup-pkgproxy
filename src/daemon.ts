// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

// pkgproxy as a systemd service on the runner.

import { rm, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { exec } from "#vendor";

// Embedded by esbuild (--loader:.service=text), so the bundle needs no
// file next to it at runtime.
import unitTemplate from "../pkgproxy.service";

export const UNIT = "pkgproxy.service";
export const CACHE_DIR = "/var/cache/pkgproxy";
/**
 * What actions/cache restores and saves: an archive of CACHE_DIR, extended
 * attributes included, which the unit's ExecStopPost= writes when pkgproxy
 * stops. pkgproxy 0.12 keeps each cached file's metadata in an extended
 * attribute, and actions/cache's own tar drops them: a file that lost its
 * attribute is downloaded again, so the cache would never help.
 */
export const ARCHIVE_DIR = "/var/cache/pkgproxy-archive";
export const ARCHIVE = `${ARCHIVE_DIR}/cache.tar`;
const TAR_XATTRS = ["--xattrs", "--xattrs-include=user.*"];
export const RUNTIME_DIR = "/run/pkgproxy";
const SOCKETS = [`${RUNTIME_DIR}/stats.sock`, `${RUNTIME_DIR}/admin.sock`];

/** The unit file, from the template shipped next to action.yaml. */
export function renderUnit(template: string, addr: string): string {
  return template.replaceAll("@ADDR@", addr);
}

export async function sudo(args: string[], options: exec.ExecOptions = {}): Promise<number> {
  return exec.exec("sudo", args, options);
}

/** Installs the unit, starts it and waits for its control sockets. */
export async function start(addr: string): Promise<void> {
  await sudo(["mkdir", "-p", "/etc/systemd/system"]);
  await sudo(["tee", `/etc/systemd/system/${UNIT}`], {
    input: Buffer.from(renderUnit(unitTemplate, addr)),
    silent: true,
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

async function allSockets(): Promise<boolean> {
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

/** Writes the unit's status and recent journal to the log. */
export async function dumpStatus(): Promise<void> {
  await sudo(["systemctl", "status", UNIT, "--no-pager"], { ignoreReturnCode: true });
  await sudo(["journalctl", "-u", UNIT, "--no-pager", "-n", "100"], { ignoreReturnCode: true });
}

/** Points the runner's apt and snapd at pkgproxy. */
export async function configureHost(addr: string): Promise<void> {
  for (const client of ["apt", "snap"]) {
    await exec.exec("bash", ["-c", `set -o pipefail; pkgproxyctl setup ${client} -addr "$ADDR" | sudo sh`], {
      env: { ...process.env, ADDR: addr } as Record<string, string>,
    });
  }
}

/** pkgproxyctl stats, for the job summary. Empty if pkgproxy is not up. */
export async function stats(): Promise<string> {
  const out = await exec.getExecOutput("pkgproxyctl", ["stats"], { ignoreReturnCode: true, silent: true });
  return out.exitCode === 0 ? out.stdout.trim() : "";
}

/** The runner user, as chown takes it. */
export function runnerOwner(): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("cannot tell the runner user's uid and gid");
  }
  return `${uid}:${gid}`;
}

/**
 * Makes CACHE_DIR and ARCHIVE_DIR the runner user's, as actions/cache runs
 * as that user. Once the unit starts, its CacheDirectory= hands CACHE_DIR
 * back to root.
 */
export async function releaseDirs(): Promise<void> {
  await sudo(["mkdir", "-p", CACHE_DIR, ARCHIVE_DIR]);
  await sudo(["chown", "-R", runnerOwner(), CACHE_DIR, ARCHIVE_DIR]);
}

/**
 * Unpacks a restored archive into CACHE_DIR, extended attributes included,
 * then removes it: a snap build's cache is several hundred MB, and the
 * unit writes a new archive when pkgproxy stops.
 */
export async function extractArchive(): Promise<void> {
  await exec.exec("tar", [...TAR_XATTRS, "-xf", ARCHIVE, "-C", CACHE_DIR]);
  await rm(ARCHIVE, { force: true });
}

/**
 * Stops pkgproxy, which flushes its statistics and, through the unit's
 * ExecStopPost=, archives the cache, then hands both to the runner user.
 * Returns whether the archive is there to save.
 */
export async function stopAndReleaseCache(): Promise<boolean> {
  await sudo(["systemctl", "stop", UNIT], { ignoreReturnCode: true });
  await releaseDirs();
  try {
    return (await stat(ARCHIVE)).isFile();
  } catch {
    await dumpStatus();
    return false;
  }
}
