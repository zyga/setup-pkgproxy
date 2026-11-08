// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

// Which runs may save the package cache (the save-package-cache input).
//
// A run can restore caches saved on its own ref, on its pull request's base
// branch, and on the default branch, never those of other branches or pull
// requests. A cache saved by a pull request therefore helps only that pull
// request's later runs, yet takes as much of the repository's cache storage
// (10 GB by default, evicted least recently used first) as one saved on the
// default branch, which every run can restore. So by default only the
// default branch saves, and everything else reads its cache.

export const POLICIES = ["default-branch", "always", "never"] as const;
export type SavePolicy = (typeof POLICIES)[number];

export function parsePolicy(value: string): SavePolicy {
  const v = value.trim() || "default-branch";
  if ((POLICIES as readonly string[]).includes(v)) {
    return v as SavePolicy;
  }
  throw new Error(`save-package-cache must be one of ${POLICIES.join(", ")}, not ${JSON.stringify(value)}`);
}

export interface SaveDecision {
  allowed: boolean;
  /** Why, in words for the log and the job summary. */
  reason: string;
}

/**
 * Whether this run may save the package cache. ref is GITHUB_REF, and
 * defaultBranch the repository's default branch, if known. Even when it
 * may, the post step saves only a cache the job added to.
 */
export function saveDecision(policy: SavePolicy, ref: string, defaultBranch: string | undefined): SaveDecision {
  switch (policy) {
    case "never":
      return { allowed: false, reason: "save-package-cache is never" };
    case "always":
      return { allowed: true, reason: "save-package-cache is always" };
    case "default-branch":
      if (!defaultBranch) {
        return { allowed: false, reason: "the repository's default branch is unknown" };
      }
      if (ref === `refs/heads/${defaultBranch}`) {
        return { allowed: true, reason: `${ref} is the default branch` };
      }
      return {
        allowed: false,
        reason: `${ref} is not the default branch (${defaultBranch}); runs here restore the default branch's cache`,
      };
  }
}
