// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { changed, diff, snapshot } from "./manifest.ts";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "manifest-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("snapshot lists files recursively with sizes, ignoring stats.json", () =>
  withDir(async (dir) => {
    await mkdir(join(dir, "apt", "pool"), { recursive: true });
    await writeFile(join(dir, "apt", "pool", "a.deb"), "12345");
    await writeFile(join(dir, "lxd-index.json"), "{}");
    await writeFile(join(dir, "stats.json"), "{\"hits\":1}");
    assert.deepEqual(await snapshot(dir), {
      [join("apt", "pool", "a.deb")]: 5,
      "lxd-index.json": 2,
    });
  }));

test("snapshot of a missing dir is empty", async () => {
  assert.deepEqual(await snapshot(join(tmpdir(), "does-not-exist-setup-pkgproxy")), {});
});

test("diff counts added, removed and resized files", () => {
  const d = diff({ a: 1, b: 2, c: 3 }, { a: 1, b: 20, d: 4 });
  assert.deepEqual(d, { added: 1, removed: 1, resized: 1, bytes: 25, files: 3 });
  assert.ok(changed(d));
});

test("an identical cache is unchanged", () => {
  const d = diff({ a: 1 }, { a: 1 });
  assert.ok(!changed(d));
  assert.equal(d.bytes, 1);
});
