// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

// Every third-party module the action uses, bundled on its own into
// dist/vendor.mjs, which therefore changes only when a dependency does.
// The action's own code imports it as "#vendor" (package.json "imports"),
// which esbuild leaves external.

export * as cache from "@actions/cache";
export * as core from "@actions/core";
export * as exec from "@actions/exec";
export * as tc from "@actions/tool-cache";
