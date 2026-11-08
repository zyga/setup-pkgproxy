// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Zygmunt Krynicki

// Files esbuild embeds as strings (--loader:.service=text).
declare module "*.service" {
  const text: string;
  export default text;
}
