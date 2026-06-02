// smoke-fspath.mjs — offline unit checks for path helpers in fs-utils.ts
// Run: node examples/smoke-fspath.mjs
import { normalizeInputPath, isInsideWorkspace, resolveToolPath } from "../src/tools/fs-utils.js";

let failures = 0;
function check(label, got, expected) {
  if (got === expected) {
    console.log("PASS", label);
  } else {
    console.error("FAIL", label, "\n  got:     ", JSON.stringify(got), "\n  expected:", JSON.stringify(expected));
    failures++;
  }
}

const isWin = process.platform === "win32";

// ── normalizeInputPath ─────────────────────────────────────────────────────
if (isWin) {
  check("git bash /d/foo/bar",  normalizeInputPath("/d/foo/bar"), "D:\\foo\\bar");
  check("git bash /C/Users",    normalizeInputPath("/C/Users"),   "C:\\Users");
  check("git bash /d (root)",   normalizeInputPath("/d"),          "D:\\");
  check("relative unchanged",   normalizeInputPath("src/index.ts"), "src/index.ts");
  check("native win unchanged", normalizeInputPath("D:\\already"), "D:\\already");
} else {
  check("posix passthrough",    normalizeInputPath("/home/user/file.ts"), "/home/user/file.ts");
  check("relative unchanged",   normalizeInputPath("src/index.ts"), "src/index.ts");
}

// ── isInsideWorkspace ──────────────────────────────────────────────────────
if (isWin) {
  const root = "G:\\OhMyProjs\\InvoxAgent";
  check("child inside workspace",        isInsideWorkspace(root + "\\src\\foo.ts", root), true);
  check("root itself is inside",         isInsideWorkspace(root, root),                    true);
  check("sibling with same prefix",      isInsideWorkspace(root + "Other",  root),          false);
  check("cross-drive C:\\ outside G:\\", isInsideWorkspace("C:\\other",     root),          false);
  check("parent is outside",             isInsideWorkspace("G:\\OhMyProjs", root),           false);
} else {
  const root = "/home/user/project";
  check("child inside",             isInsideWorkspace(root + "/src/foo.ts", root), true);
  check("root itself",              isInsideWorkspace(root, root),                  true);
  check("sibling with same prefix", isInsideWorkspace(root + "-other",      root),  false);
  check("parent outside",           isInsideWorkspace("/home/user",         root),  false);
  check("unrelated path",           isInsideWorkspace("/etc/passwd",        root),  false);
}

// ── resolveToolPath ────────────────────────────────────────────────────────
if (isWin) {
  const cwd = "G:\\OhMyProjs\\InvoxAgent";
  check("git bash path -> abs win",  resolveToolPath(cwd, "/d/foo/bar"),   "D:\\foo\\bar");
  check("relative -> abs",           resolveToolPath(cwd, "src/index.ts"), "G:\\OhMyProjs\\InvoxAgent\\src\\index.ts");
  check("abs win path passthrough",  resolveToolPath(cwd, "C:\\Users\\x"), "C:\\Users\\x");
} else {
  const cwd = "/home/user/project";
  check("relative -> abs",    resolveToolPath(cwd, "src/index.ts"), "/home/user/project/src/index.ts");
  check("abs passthrough",    resolveToolPath(cwd, "/etc/passwd"),   "/etc/passwd");
}

if (failures) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll checks PASS");
}
