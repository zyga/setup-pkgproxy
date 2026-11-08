// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

import { test } from "node:test";
import assert from "node:assert/strict";

import { binaryCacheKey, packageCacheKeys } from "./keys.ts";

test("binary key includes version, Go and arch", () => {
  assert.equal(binaryCacheKey("pkgproxy-bin", "v0.11.0", "1.27.1", "X64"), "pkgproxy-bin-v0.11.0-go1.27.1-X64");
});

test("package keys: unique save key under the restore prefix", () => {
  const keys = packageCacheKeys("pkgproxy-cache-v3", "ARM64", {
    runId: "42",
    runAttempt: "2",
    job: "build",
    nonce: "abc123",
  });
  assert.equal(keys.restorePrefix, "pkgproxy-cache-v3-ARM64-");
  assert.equal(keys.save, "pkgproxy-cache-v3-ARM64-42-2-build-abc123");
  assert.ok(keys.save.startsWith(keys.restorePrefix));
});

test("package keys: v1 keys match the v2 restore prefix", () => {
  const { restorePrefix } = packageCacheKeys("pkgproxy-cache-v3", "X64", {
    runId: "1",
    runAttempt: "1",
    job: "j",
    nonce: "n",
  });
  assert.ok("pkgproxy-cache-v3-X64-success".startsWith(restorePrefix));
  assert.ok("pkgproxy-cache-v3-X64-partial".startsWith(restorePrefix));
});

test("package keys: job ids are made safe for cache keys", () => {
  const { save } = packageCacheKeys("p", "X64", { runId: "1", runAttempt: "1", job: "a,b c", nonce: "n" });
  assert.equal(save, "p-X64-1-1-a_b_c-n");
  assert.ok(!save.includes(","));
});
