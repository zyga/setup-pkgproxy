// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

// pkgproxy as a systemd service on the runner.

import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import * as core from "@actions/core";
import * as exec from "@actions/exec";

// Embedded by esbuild (--loader:.service=text), so the bundle needs no
// file next to it at runtime.
import unitTemplate from "../pkgproxy.service";

export const UNIT = "pkgproxy.service";
export const CACHE_DIR = "/var/cache/pkgproxy";
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

/**
 * Stops pkgproxy, which flushes its statistics, and hands the cache to the
 * runner user: the service runs as root, and actions/cache reads the cache
 * as the runner user.
 */
export async function stopAndReleaseCache(): Promise<void> {
  await sudo(["systemctl", "stop", UNIT], { ignoreReturnCode: true });
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("cannot tell the runner user's uid and gid");
  }
  await sudo(["chown", "-R", `${uid}:${gid}`, CACHE_DIR]);
}

export function warnOnError(what: string): (err: unknown) => void {
  return (err) => core.warning(`${what}: ${err instanceof Error ? err.message : String(err)}`);
}
