// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

// What the main step hands to the post step (core.saveState/getState).

export const State = {
  /** The key the post step saves the package cache under. */
  saveKey: "save-key",
  /** The key the package cache was restored from, or "". */
  restoredKey: "restored-key",
  /** A JSON file with the cache's manifest right after restore. */
  manifestPath: "manifest-path",
  /** "true" when save-package-cache lets this run save the cache. */
  saveAllowed: "save-allowed",
  /** Why it may or may not, in words. */
  saveReason: "save-reason",
} as const;
