#!/usr/bin/env node
// Stop / PreCompact hook: blocks ending the turn (or compacting) when code or config
// changed after PROGRESS.md was last updated. Output: {"decision":"block","reason":...}
// on stdout with exit 0 blocks; exit 0 with no output allows.
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";

const isPreCompact = process.argv.includes("--precompact");

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  input = {};
}

// Never loop: if Claude is already continuing because of a Stop hook, let it stop.
if (input.stop_hook_active === true) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

// Files and folders that ARE the memory; changing only these never needs a checkpoint.
const MEMORY = [/^PROGRESS\.md$/, /^CHANGELOG\.md$/, /^DECISIONS\.md$/, /^CLAUDE\.md$/, /^CLAUDE\.local\.md$/, /^BUILD_PROMPT\.md$/, /^docs\//, /^\.claude\//, /^lab\/results\//];

let porcelain = "";
try {
  porcelain = execSync("git status --porcelain --untracked-files=all", {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
  }).toString();
} catch {
  process.exit(0); // not a git repo (yet): nothing to enforce
}

const changed = porcelain
  .split("\n")
  .filter(Boolean)
  .map((l) => l.slice(3).trim())
  .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1] : p))
  .map((p) => p.replace(/^"|"$/g, ""));

const codeFiles = changed.filter((p) => !MEMORY.some((re) => re.test(p)));
if (codeFiles.length === 0) process.exit(0);

function mtime(p) {
  try {
    return statSync(join(root, p)).mtimeMs;
  } catch {
    return 0; // deleted file
  }
}

const newestCode = Math.max(...codeFiles.map(mtime), 0);
const progressPath = join(root, "PROGRESS.md");
const progressTime = existsSync(progressPath) ? statSync(progressPath).mtimeMs : 0;

if (progressTime >= newestCode) process.exit(0);

// Remind once per distinct change set, so a deliberate stop isn't blocked forever.
const stateDir = join(root, ".claude", "hooks", ".state");
const stamp = createHash("sha256")
  .update(codeFiles.sort().join("|") + ":" + newestCode)
  .digest("hex")
  .slice(0, 16);
const stampFile = join(stateDir, isPreCompact ? "last-precompact" : "last-stop");
try {
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8").trim() === stamp) process.exit(0);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stampFile, stamp);
} catch {
  // state is best-effort
}

const list = codeFiles.slice(0, 12).join(", ") + (codeFiles.length > 12 ? ", …" : "");
const reason =
  `Code/config changed after PROGRESS.md was last updated (${list}). ` +
  (isPreCompact ? "Before compacting, " : "Before ending this turn, ") +
  "run the /checkpoint steps: update PROGRESS.md (checklist, Current focus, Next step, dated Session log entry with files and test results), " +
  "add a CHANGELOG.md line under Unreleased, add/supersede an ADR in DECISIONS.md if you chose between options, " +
  "and update every docs/*.md file this change affects (and docs/OPENCLAW_NOTES.md for anything verified about OpenClaw).";

process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
process.exit(0);
