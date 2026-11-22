#!/usr/bin/env node
// SessionStart hook: prints a short state summary that Claude Code adds to context.
// Plain text on stdout with exit 0 is added to Claude's context.
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  input = {};
}

const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const source = input.source || "startup";

function section(md, heading) {
  // Returns the body under "## <heading>" up to the next "## ".
  const re = new RegExp(`^## ${heading}[ \\t]*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m");
  const m = md.match(re);
  return m ? m[1].trim() : "";
}

function firstEntries(md, heading, count) {
  const body = section(md, heading);
  const parts = body.split(/^### /m).slice(1, count + 1);
  return parts.map((p) => "### " + p.trim()).join("\n");
}

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const out = [];
out.push(
  `[Off Manual Desk] Session ${source}. Memory files are the source of truth; read them, don't rely on recollection.`,
);

const progressPath = join(root, "PROGRESS.md");
if (existsSync(progressPath)) {
  const md = readFileSync(progressPath, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const focus = section(md, "Current focus");
  const next = section(md, "Next step");
  const waiting = section(md, "Waiting on Dwahnil")
    .split("\n")
    .filter((l) => l.startsWith("- [ ]"))
    .slice(0, 5)
    .join("\n");
  if (focus) out.push(`Current focus:\n${focus}`);
  if (next) out.push(`Next step:\n${next}`);
  if (waiting) out.push(`Waiting on Dwahnil (open):\n${waiting}`);
  const recent = firstEntries(md, "Session log", 2);
  if (recent) out.push(`Latest session log entries:\n${recent}`);
} else {
  out.push("PROGRESS.md is missing. Recreate it from the kit before doing anything else.");
}

const branch = git("rev-parse --abbrev-ref HEAD");
const status = git("status --porcelain");
const log = git("log --oneline -5");
if (branch) out.push(`Git branch: ${branch}`);
if (status) {
  const lines = status.split("\n");
  out.push(
    `Uncommitted changes (${lines.length}):\n${lines.slice(0, 15).join("\n")}${lines.length > 15 ? "\n…" : ""}`,
  );
}
if (log) out.push(`Recent commits:\n${log}`);

if (source === "compact") {
  out.push(
    "Context was just compacted. Re-read PROGRESS.md and the docs for the current task before continuing.",
  );
}
out.push(
  "Before ending any turn that changed code or config: run the /checkpoint steps (PROGRESS.md, CHANGELOG.md, DECISIONS.md, affected docs).",
);

process.stdout.write(out.join("\n\n") + "\n");
process.exit(0);
