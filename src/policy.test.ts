// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePolicy, saveDecision } from "./policy.ts";

test("parsePolicy accepts the three policies and defaults to default-branch", () => {
  assert.equal(parsePolicy("default-branch"), "default-branch");
  assert.equal(parsePolicy("always"), "always");
  assert.equal(parsePolicy(" never "), "never");
  assert.equal(parsePolicy(""), "default-branch");
  assert.throws(() => parsePolicy("sometimes"), /must be one of default-branch, always, never/);
});

test("default-branch saves on the default branch only", () => {
  assert.equal(saveDecision("default-branch", "refs/heads/main", "main").allowed, true);
  assert.equal(saveDecision("default-branch", "refs/heads/trunk", "trunk").allowed, true);
  for (const ref of ["refs/pull/5/merge", "refs/heads/feature", "refs/heads/releases/v1", "refs/tags/v2.0.0"]) {
    const d = saveDecision("default-branch", ref, "main");
    assert.equal(d.allowed, false, ref);
    assert.match(d.reason, /not the default branch/);
  }
});

test("default-branch does not save when the default branch is unknown", () => {
  assert.equal(saveDecision("default-branch", "refs/heads/main", undefined).allowed, false);
});

test("always and never ignore the ref", () => {
  assert.equal(saveDecision("always", "refs/pull/5/merge", "main").allowed, true);
  assert.equal(saveDecision("never", "refs/heads/main", "main").allowed, false);
});
