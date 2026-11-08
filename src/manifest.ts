// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

// Whether the package cache changed during the job: the post step saves it
// only then, since a save uploads the whole cache.

import { readdir, lstat } from "node:fs/promises";
import { join, relative } from "node:path";

/** Relative path to size in bytes, for every regular file in the cache. */
export type Manifest = Record<string, number>;

/**
 * Files pkgproxy rewrites on every run without new content, which would
 * otherwise make every run look like a change. Relative to the cache dir.
 */
export const IGNORED: ReadonlySet<string> = new Set(["stats.json"]);

/** Lists the cache's files with their sizes. A missing dir is empty. */
export async function snapshot(dir: string): Promise<Manifest> {
  const out: Manifest = {};
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
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

export interface ManifestDiff {
  added: number;
  removed: number;
  resized: number;
  /** Total bytes of the files in the newer manifest. */
  bytes: number;
  files: number;
}

export function diff(before: Manifest, after: Manifest): ManifestDiff {
  let added = 0;
  let resized = 0;
  let bytes = 0;
  let files = 0;
  for (const [path, size] of Object.entries(after)) {
    files++;
    bytes += size;
    const old = before[path];
    if (old === undefined) {
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

export function changed(d: ManifestDiff): boolean {
  return d.added + d.removed + d.resized > 0;
}
