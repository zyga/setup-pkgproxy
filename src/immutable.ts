// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

// Which of the cache's files hold immutable objects: bodies that never
// change under their key, so pkgproxy never revalidates them and they are
// the only files worth keeping between runs. What revalidates — apt's
// indexes, snap's and the other sides' lists — is small and fetched again
// anyway, while archiving it would make every run look like a change.
//
// Two ways to tell: "pkgproxyctl cache list" (pkgproxy with
// gitlab.com/zygoon/pkgproxy!250), and, for one without it, the
// .meta.json files 0.12 keeps next to each object for 0.11's sake, which
// carry the same Immutable flag (internal/store's ObjectMeta).

import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { exec } from "#vendor";

/** What the immutable files of a cache are, and how they were found. */
export interface ImmutableSet {
  /** Paths relative to the cache directory, with slashes. */
  readonly paths: ReadonlySet<string>;
  /** How the set was found, for the log. */
  readonly how: string;
}

/**
 * Parses the output of "pkgproxyctl cache list -output-format=json": one
 * JSON object per line, with path, size and immutable. Every immutable
 * object's path is returned, with the path of its .meta.json sidecar:
 * pkgproxy 0.12 writes one for going back to 0.11, and an archive meant
 * to outlive a downgrade keeps it.
 */
export function parseCacheList(stdout: string): Set<string> {
  const paths = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry: { path?: unknown; immutable?: unknown };
    try {
      entry = JSON.parse(trimmed) as { path?: unknown; immutable?: unknown };
    } catch {
      continue; // a line that is not JSON says nothing
    }
    if (typeof entry.path === "string" && entry.immutable === true) {
      paths.add(entry.path);
      paths.add(`${entry.path}.meta.json`);
    }
  }
  return paths;
}

/** The relative path of file's metadata sidecar, or null outside objects/. */
export function sidecarPath(rel: string): string | null {
  // Objects live at <side>/objects/<key>; anything else (stats.json, tmp/)
  // is not a cached object.
  const parts = rel.split("/");
  if (parts.length < 3 || parts[1] !== "objects" || rel.endsWith(".meta.json")) {
    return null;
  }
  return `${rel}.meta.json`;
}

/**
 * The Immutable flag of one object's .meta.json, as internal/store's
 * ObjectMeta marshals it. Null when the sidecar is missing, unreadable or
 * not JSON: the caller then keeps the object, as an unfiltered save
 * would.
 */
export async function sidecarImmutable(path: string): Promise<boolean | null> {
  let meta: { Immutable?: unknown };
  try {
    meta = JSON.parse(await readFile(path, "utf8")) as { Immutable?: unknown };
  } catch {
    return null;
  }
  return meta.Immutable === true;
}

/** The cache's immutable files, read from the objects' sidecars. */
export async function sidecarImmutablePaths(cacheDir: string): Promise<Set<string>> {
  const paths = new Set<string>();
  let entries: string[];
  try {
    entries = await readdir(cacheDir, { recursive: true });
  } catch {
    return paths;
  }
  for (const entry of entries) {
    const rel = relative(cacheDir, join(cacheDir, entry)).split(sep).join("/");
    const sidecar = sidecarPath(rel);
    if (sidecar === null) {
      continue;
    }
    // Directories under objects/ are no objects; neither tar nor the
    // manifest wants them.
    const st = await lstat(join(cacheDir, entry)).catch(() => null);
    if (!st?.isFile()) {
      continue;
    }
    const immutable = await sidecarImmutable(join(cacheDir, sidecar));
    if (immutable !== false) {
      paths.add(rel);
      paths.add(sidecar);
    }
  }
  return paths;
}

/**
 * The cache's immutable files: from "pkgproxyctl cache list" when the
 * pkgproxy at hand has it, from the objects' sidecars when it does not.
 * Null when neither works — the caller archives the whole cache then, as
 * before.
 */
export async function immutablePaths(cacheDir: string): Promise<ImmutableSet | null> {
  const out = await exec.getExecOutput(
    "pkgproxyctl",
    ["cache", "list", "-output-format=json", "-cache-dir", cacheDir],
    { ignoreReturnCode: true, silent: true },
  );
  if (out.exitCode === 0) {
    return { paths: parseCacheList(out.stdout), how: "pkgproxyctl cache list" };
  }
  try {
    const paths = await sidecarImmutablePaths(cacheDir);
    return { paths, how: "the objects' .meta.json sidecars" };
  } catch {
    return null;
  }
}
