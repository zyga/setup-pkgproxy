// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCacheList, sidecarImmutable, sidecarImmutablePaths, sidecarPath } from "./immutable.ts";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "immutable-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("parseCacheList keeps immutable objects, with their sidecars", () => {
  const out = [
    `{"path":"apt/objects/h/pool/a.deb","size":5,"immutable":true}`,
    `{"path":"apt/objects/h/dists/bookworm/InRelease","size":7,"immutable":false}`,
    `{"path":"snap/objects/blobs/snap_1.snap","size":9,"immutable":true}`,
    "not json",
    `{"path":"apt/objects/h/pool/no-flag.deb","size":1}`,
    "",
  ].join("\n");
  assert.deepEqual(parseCacheList(out), new Set([
    "apt/objects/h/pool/a.deb",
    "apt/objects/h/pool/a.deb.meta.json",
    "snap/objects/blobs/snap_1.snap",
    "snap/objects/blobs/snap_1.snap.meta.json",
  ]));
});

test("sidecarPath names only object files under <side>/objects/", () => {
  assert.equal(sidecarPath("apt/objects/h/pool/a.deb"), "apt/objects/h/pool/a.deb.meta.json");
  assert.equal(sidecarPath("apt/objects/h/pool/a.deb.meta.json"), null);
  assert.equal(sidecarPath("apt/objects"), null);
  assert.equal(sidecarPath("stats.json"), null);
  assert.equal(sidecarPath("apt/tmp/obj-123"), null);
});

test("sidecarImmutable reads the flag, null without a readable sidecar", () =>
  withDir(async (dir) => {
    await writeFile(join(dir, "yes.json"), `{"Size":5,"Immutable":true}`);
    await writeFile(join(dir, "no.json"), `{"Size":7,"Immutable":false}`);
    await writeFile(join(dir, "junk.json"), "not json");
    assert.equal(await sidecarImmutable(join(dir, "yes.json")), true);
    assert.equal(await sidecarImmutable(join(dir, "no.json")), false);
    assert.equal(await sidecarImmutable(join(dir, "junk.json")), null);
    assert.equal(await sidecarImmutable(join(dir, "missing.json")), null);
  }));

test("sidecarImmutablePaths keeps immutable and unknown, drops mutable", () =>
  withDir(async (dir) => {
    await mkdir(join(dir, "apt", "objects", "h", "pool"), { recursive: true });
    await mkdir(join(dir, "apt", "objects", "h", "dists"), { recursive: true });
    // An immutable object.
    await writeFile(join(dir, "apt", "objects", "h", "pool", "a.deb"), "12345");
    await writeFile(join(dir, "apt", "objects", "h", "pool", "a.deb.meta.json"), `{"Size":5,"Immutable":true}`);
    // A mutable index.
    await writeFile(join(dir, "apt", "objects", "h", "dists", "InRelease"), "1234567");
    await writeFile(join(dir, "apt", "objects", "h", "dists", "InRelease.meta.json"), `{"Size":7,"Immutable":false}`);
    // An object whose sidecar is missing: kept, as an unfiltered save would.
    await writeFile(join(dir, "apt", "objects", "h", "pool", "b.deb"), "12");
    // Not objects: ignored.
    await writeFile(join(dir, "stats.json"), "{}");

    assert.deepEqual(await sidecarImmutablePaths(dir), new Set([
      "apt/objects/h/pool/a.deb",
      "apt/objects/h/pool/a.deb.meta.json",
      "apt/objects/h/pool/b.deb",
      "apt/objects/h/pool/b.deb.meta.json",
    ]));
  }));

test("sidecarImmutablePaths of a missing dir is empty", async () => {
  assert.deepEqual(await sidecarImmutablePaths(join(tmpdir(), "does-not-exist-setup-pkgproxy")), new Set());
});
