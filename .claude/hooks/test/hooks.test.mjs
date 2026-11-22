// Tests for the Claude Code memory hooks. Run: node --test .claude/hooks/test/
// Each test builds a throwaway git repo, so nothing touches the real project.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const hooksDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const STOP = join(hooksDir, "stop-memory-check.mjs");
const START = join(hooksDir, "session-start.mjs");

const PROGRESS = `# Progress

## Current focus

M0 Scaffold.

## Next step

Write the CI workflow.

## Waiting on Dwahnil

- [ ] Create the GitHub repo
- [x] Done thing

## Session log

### 2026-11-22 10:00: Second
- Changed: b

### 2026-11-21 09:00: First
- Changed: a
`;

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "om-hooks-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "PROGRESS.md"), PROGRESS);
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, git };
}

function runHook(script, dir, input = {}, args = []) {
  const r = spawnSync(process.execPath, [script, ...args], {
    input: JSON.stringify(input),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

function setMtime(path, secondsFromNow) {
  const t = new Date(Date.now() + secondsFromNow * 1000);
  utimesSync(path, t, t);
}

test("session-start prints focus, next step, open items, latest log entries and git state", () => {
  const { dir } = repo();
  const out = runHook(START, dir, { source: "startup" });
  assert.match(out, /Session startup/);
  assert.match(out, /Current focus:\nM0 Scaffold\./);
  assert.match(out, /Next step:\nWrite the CI workflow\./);
  assert.match(out, /- \[ \] Create the GitHub repo/);
  assert.doesNotMatch(out, /Done thing/);
  assert.match(out, /### 2026-11-22 10:00: Second/);
  assert.match(out, /Git branch: main/);
  assert.match(out, /init/);
  rmSync(dir, { recursive: true, force: true });
});

test("session-start after compaction tells Claude to re-read", () => {
  const { dir } = repo();
  assert.match(runHook(START, dir, { source: "compact" }), /Context was just compacted/);
  rmSync(dir, { recursive: true, force: true });
});

test("session-start copes with a missing PROGRESS.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-hooks-"));
  assert.match(runHook(START, dir, {}), /PROGRESS\.md is missing/);
  rmSync(dir, { recursive: true, force: true });
});

test("stop allows a clean tree and memory-only changes", () => {
  const { dir } = repo();
  assert.equal(runHook(STOP, dir), "");
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "X.md"), "x");
  writeFileSync(join(dir, "CHANGELOG.md"), "x");
  mkdirSync(join(dir, "lab", "results"), { recursive: true });
  writeFileSync(join(dir, "lab", "results", "L1.txt"), "x");
  assert.equal(runHook(STOP, dir), "");
  rmSync(dir, { recursive: true, force: true });
});

test("stop blocks once when code is newer than PROGRESS.md, then allows the same change set", () => {
  const { dir } = repo();
  mkdirSync(join(dir, "apps", "x"), { recursive: true });
  const code = join(dir, "apps", "x", "main.go");
  writeFileSync(code, "package main");
  setMtime(join(dir, "PROGRESS.md"), -60);
  const out = JSON.parse(runHook(STOP, dir));
  assert.equal(out.decision, "block");
  assert.match(out.reason, /apps\/x\/main\.go/);
  assert.match(out.reason, /Before ending this turn/);
  assert.equal(runHook(STOP, dir), "", "second stop with same change set must be allowed");
  // A new change re-arms the reminder.
  writeFileSync(join(dir, "apps", "x", "other.go"), "package main");
  assert.equal(JSON.parse(runHook(STOP, dir)).decision, "block");
  assert.ok(existsSync(join(dir, ".claude", "hooks", ".state", "last-stop")));
  rmSync(dir, { recursive: true, force: true });
});

test("stop allows when PROGRESS.md was updated after the code", () => {
  const { dir } = repo();
  mkdirSync(join(dir, "apps"));
  writeFileSync(join(dir, "apps", "a.ts"), "x");
  setMtime(join(dir, "apps", "a.ts"), -60);
  setMtime(join(dir, "PROGRESS.md"), 0);
  assert.equal(runHook(STOP, dir), "");
  rmSync(dir, { recursive: true, force: true });
});

test("stop never loops when stop_hook_active is set", () => {
  const { dir } = repo();
  writeFileSync(join(dir, "code.ts"), "x");
  setMtime(join(dir, "PROGRESS.md"), -60);
  assert.equal(runHook(STOP, dir, { stop_hook_active: true }), "");
  rmSync(dir, { recursive: true, force: true });
});

test("precompact uses its own reminder state and wording", () => {
  const { dir } = repo();
  writeFileSync(join(dir, "code.ts"), "x");
  setMtime(join(dir, "PROGRESS.md"), -60);
  const out = JSON.parse(runHook(STOP, dir, {}, ["--precompact"]));
  assert.match(out.reason, /Before compacting/);
  // Stop still reminds once even though precompact already did.
  assert.equal(JSON.parse(runHook(STOP, dir)).decision, "block");
  rmSync(dir, { recursive: true, force: true });
});

test("stop is a no-op outside a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-nogit-"));
  writeFileSync(join(dir, "code.ts"), "x");
  assert.equal(runHook(STOP, dir), "");
  rmSync(dir, { recursive: true, force: true });
});
