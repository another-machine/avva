#!/usr/bin/env node
/**
 * Refresh the vendored @amplib packages from a local public-library checkout.
 *
 *   node scripts/vendor-amplib.mjs [path-to-public-library]
 *
 * Why vendor at all: these packages live inside the public-library monorepo and
 * are not published to npm yet, and npm has no syntax for depending on a
 * subdirectory of a git repository. A vendored copy is the only mechanism that
 * survives a clean `npm install` on a build server.
 *
 * Temporary by design. Imports across the app use the published specifiers
 * (@amplib/sound-synthesis and friends) rather than vendor paths, so once
 * public-library publishes, this script, vendor/, the vite aliases and the
 * tsconfig paths all delete together and no application code changes.
 *
 * The copies are committed, so builds never reach outside the repo. This script
 * exists only to update them, and it records the exact source commit in each
 * file's header so a vendored copy can always be traced back to the state it
 * came from.
 */

import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(
  process.argv[2] ?? join(ROOT, "..", "another-machine", "public-library"),
);

const PACKAGES = [
  ["amplib-sound-synthesis", "@amplib/sound-synthesis"],
  ["amplib-hue-wheel", "@amplib/hue-wheel"],
  ["amplib-music-theory", "@amplib/music-theory"],
];

function run(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: "utf8" }).trim();
}

let commit;
try {
  commit = run("git rev-parse --short HEAD", SOURCE);
} catch {
  console.error(`Not a git checkout: ${SOURCE}`);
  process.exit(1);
}

const dirty = run("git status --porcelain", SOURCE).length > 0;
if (dirty) {
  // A dirty source means the vendored bytes correspond to no commit anyone
  // else can check out, which defeats the point of stamping one.
  console.error(
    `public-library has uncommitted changes at ${SOURCE}.\n` +
      `Commit them first, or the stamped provenance will be a lie.`,
  );
  process.exit(1);
}

for (const [dir, name] of PACKAGES) {
  const from = join(SOURCE, "packages", dir, "dist");
  const to = join(ROOT, "vendor", dir);
  mkdirSync(to, { recursive: true });

  const header =
    `/* Vendored from ${name} @ another-machine/public-library ${commit}\n` +
    ` * Do not edit. Regenerate with: node scripts/vendor-amplib.mjs\n */\n`;

  for (const file of ["index.js", "index.d.ts"]) {
    const body = readFileSync(join(from, file), "utf8");
    writeFileSync(join(to, file), header + body);
  }
  // The map is copied unstamped — a header would shift every line it maps to.
  copyFileSync(join(from, "index.js.map"), join(to, "index.js.map"));

  console.log(`${name.padEnd(28)} ← ${commit}`);
}

console.log(`\nVendored 3 packages from ${SOURCE} at ${commit}.`);
