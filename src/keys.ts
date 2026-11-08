// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

// Cache keys. Everything here is pure, so that it can be unit tested
// without a runner.

/**
 * The actions/cache key of the built pkgproxy binary. The pinned version,
 * Go toolchain and CPU arch are all part of it: amd64 and arm64 runners
 * share the Linux OS label, and GitHub isolates caches by OS only, so
 * bumping any of them busts the cache with no manual key edit.
 */
export function binaryCacheKey(prefix: string, version: string, goVersion: string, arch: string): string {
  return `${prefix}-${version}-go${goVersion}-${arch}`;
}

export interface PackageCacheKeys {
  /** The key the post step saves under: unique to this job. */
  save: string;
  /** The prefix restore looks under: the newest matching cache wins. */
  restorePrefix: string;
}

export interface JobIdentity {
  runId: string;
  runAttempt: string;
  /** GITHUB_JOB: the job's id in the workflow, not its display name. */
  job: string;
  /** Tells apart matrix jobs and repeated uses of the action in one job. */
  nonce: string;
}

/**
 * The package cache keys. Caches are immutable, so each job saves under a
 * key of its own and restore picks the newest cache under the prefix.
 * Keys from v1.2 and later (<prefix>-<arch>-success and -partial), which
 * save the same archive, match the same prefix, so their cache warms the
 * first v2 run.
 */
export function packageCacheKeys(prefix: string, arch: string, id: JobIdentity): PackageCacheKeys {
  const restorePrefix = `${prefix}-${arch}-`;
  return {
    save: `${restorePrefix}${id.runId}-${id.runAttempt}-${sanitize(id.job)}-${id.nonce}`,
    restorePrefix,
  };
}

/** Cache keys cannot hold commas, and short plain keys read better in logs. */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64) || "job";
}
