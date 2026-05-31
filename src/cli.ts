// Stage 0: minimal entry. Logs go to stderr because in later stages
// stdout will be reserved for JSON-RPC framing over stdio.
// See PLAN.md §3 (pitfalls) for why this matters.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");
const pkg: { name: string; version: string } = JSON.parse(
  readFileSync(pkgPath, "utf8"),
);

// CHOICE: write to stderr, not stdout — keeps stdout reserved for JSON-RPC.
process.stderr.write(`${pkg.name} v${pkg.version}\n`);
