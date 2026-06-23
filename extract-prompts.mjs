import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("src/agent/templates.ts", "utf8");
const allLines = src.split("\n");

// ── Helper: extract content from a single template literal line ──
// Handles escaped backticks (\`) inside the literal.
// Strategy: find first ` and last ` on the line (they delimit the template literal).
function extractTemplateLiteralContent(line) {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("`")) return null;
  // Find the first backtick
  const first = trimmed.indexOf("`");
  // Find the last backtick before ` +` or `,\n` or just end
  const last = trimmed.lastIndexOf("`");
  if (first === last) return null; // no content
  return trimmed.slice(first + 1, last);
}

// ── Helper: evaluate raw template literal content (with \n, \` escapes) ──
function evaluateTemplateContent(raw) {
  // Use JSON parse approach: convert escape sequences
  // Wrap in quotes, escape properly, then parse
  // Actually simpler: use new Function with a template literal
  try {
    return new Function("return `" + raw + "`")();
  } catch {
    // If that fails, do manual replacement
    return raw.replace(/\\n/g, "\n").replace(/\\`/g, "`").replace(/\\\\/g, "\\");
  }
}

// ── Helper: extract a concatenated prompt (multiple backtick segments) ──
function extractConcatPrompt(startLine, endLine) {
  let result = "";
  for (let i = startLine - 1; i < endLine; i++) {
    const line = allLines[i];
    const raw = extractTemplateLiteralContent(line);
    if (raw !== null) {
      result += evaluateTemplateContent(raw);
    }
  }
  return result;
}

// ── Helper: build the original JS expression to verify ──
function buildOriginalExpr(startLine, endLine) {
  let parts = [];
  for (let i = startLine - 1; i < endLine; i++) {
    const line = allLines[i];
    const raw = extractTemplateLiteralContent(line);
    if (raw !== null) {
      parts.push("`" + raw + "`");
    }
  }
  return parts.join(" + ");
}

// ── WORKER_PROMPT (lines 91-164): single template literal ──
const workerStart = src.indexOf("const WORKER_PROMPT = `");
const afterWorker = src.slice(workerStart + 'const WORKER_PROMPT = `'.length);
const workerEnd = afterWorker.lastIndexOf("`");
const workerText = afterWorker.slice(0, workerEnd);

// ── Concatenated prompts ──
const planPrompt = extractConcatPrompt(197, 229);
const askPrompt = extractConcatPrompt(239, 259);
const crPrompt = extractConcatPrompt(271, 322);
const bddPrompt = extractConcatPrompt(337, 523);

// ── Verify byte-identical ──
const origPlan = new Function("return " + buildOriginalExpr(197, 229))();
const origAsk = new Function("return " + buildOriginalExpr(239, 259))();
const origCR = new Function("return " + buildOriginalExpr(271, 322))();
const origBDD = new Function("return " + buildOriginalExpr(337, 523))();

console.log("Plan matches:", planPrompt === origPlan);
console.log("Ask matches:", askPrompt === origAsk);
console.log("CR matches:", crPrompt === origCR);
console.log("BDD matches:", bddPrompt === origBDD);

if (!(planPrompt === origPlan && askPrompt === origAsk && crPrompt === origCR && bddPrompt === origBDD)) {
  console.error("MISMATCH - aborting");
  process.exit(1);
}

// ── Write files ──
const dir = "src/agent/templates/prompts";

// WORKER: already a single template literal, just add export
writeFileSync(
  `${dir}/worker.ts`,
  "export const WORKER_PROMPT = `" + workerText + "`;\n"
);

// For concatenated prompts, write as single template literal with actual newlines
function writePromptFile(filename, constName, content) {
  writeFileSync(`${dir}/${filename}`, "export const " + constName + " = `" + content + "`;\n");
}

writePromptFile("plan.ts", "PLAN_PROMPT", planPrompt);
writePromptFile("ask.ts", "ASK_PROMPT", askPrompt);
writePromptFile("code-reviewer.ts", "CODE_REVIEWER_PROMPT", crPrompt);
writePromptFile("bdd.ts", "BDD_PROMPT", bddPrompt);

console.log("All prompt files written successfully");
