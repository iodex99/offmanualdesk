import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check, frontmatter } from "../vet.mjs";

const VET = join(dirname(fileURLToPath(import.meta.url)), "..", "vet.mjs");

function skill(files) {
  const dir = mkdtempSync(join(tmpdir(), "om-vet-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

const GOOD =
  "---\nname: bank-reco\ndescription: Reconcile a bank statement with the ledger.\n---\n\nSteps...\n";

test("a plain instructions-only skill passes with no findings", () => {
  const d = skill({ "SKILL.md": GOOD });
  const r = check(d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
  assert.match(r.files["SKILL.md"], /^[0-9a-f]{64}$/);
  rmSync(d, { recursive: true, force: true });
});

test("missing SKILL.md or frontmatter blocks", () => {
  const a = skill({ "README.md": "x" });
  assert.equal(check(a).ok, false);
  const b = skill({ "SKILL.md": "no frontmatter" });
  assert.ok(check(b).findings.some((f) => f.rule === "frontmatter"));
  for (const d of [a, b]) rmSync(d, { recursive: true, force: true });
});

test("binaries, install scripts and git dependencies block", () => {
  const d = skill({
    "SKILL.md": GOOD,
    "bin/helper.exe": "MZ",
    "package.json": '{"scripts":{"postinstall":"node x.js"}}',
    "requirements.txt": "pkg @ git+https://github.com/x/y",
  });
  const r = check(d);
  assert.equal(r.ok, false);
  const rules = new Set(r.findings.filter((f) => f.level === "block").map((f) => f.rule));
  for (const want of ["binary", "install-script", "pip-git"]) assert.ok(rules.has(want), want);
  rmSync(d, { recursive: true, force: true });
});

test("network, shell, eval, blobs, absolute paths and credentials warn with file:line", () => {
  const d = skill({
    "SKILL.md": GOOD,
    "scripts/run.py": [
      "import subprocess, requests",
      "requests.get('https://api.example.com/x')",
      "subprocess.run(['cmd'])",
      "eval(code)",
      "open('C:\\\\Windows\\\\x.txt','w')",
      "API_KEY = os.environ['K']",
      "B".repeat(250),
    ].join("\n"),
  });
  const r = check(d);
  assert.equal(r.ok, true, "warnings don't block");
  const byRule = (id) => r.findings.filter((f) => f.rule === id);
  assert.ok(byRule("network").some((f) => f.file === "scripts/run.py" && f.line === 2));
  for (const id of ["http-client", "shell", "eval", "abs-path", "credentials", "base64-blob"])
    assert.ok(byRule(id).length > 0, id);
  rmSync(d, { recursive: true, force: true });
});

test("localhost URLs are not network findings", () => {
  const d = skill({
    "SKILL.md": GOOD + "\nTally answers on http://127.0.0.1:9000 and http://localhost:9000\n",
  });
  assert.deepEqual(
    check(d).findings.filter((f) => f.rule === "network"),
    [],
  );
  rmSync(d, { recursive: true, force: true });
});

test("frontmatter parser", () => {
  assert.deepEqual(frontmatter('---\nname: "x"\ndescription: y z\n---\n'), { name: "x", description: "y z" });
  assert.equal(frontmatter("nope"), null);
});

test("CLI: check exit codes and lock entries are pending, never approved", () => {
  const good = skill({ "SKILL.md": GOOD });
  const bad = skill({ "SKILL.md": GOOD, "x.dll": "MZ" });
  const run = (...a) => spawnSync(process.execPath, [VET, ...a], { encoding: "utf8" });
  assert.equal(run("check", good).status, 0);
  assert.equal(run("check", bad).status, 1);
  const lock = run("lock", good, "--id", "offmanual/bank-reco", "--version", "0.1.0", "--packs", "core");
  assert.equal(lock.status, 0, lock.stderr);
  const entry = JSON.parse(lock.stdout);
  assert.equal(entry.review.status, "pending");
  assert.equal(entry.path, "offmanual/bank-reco");
  assert.equal(run("lock", bad, "--id", "x/y", "--version", "1.0.0").status, 1);
  assert.equal(run("bogus", good).status, 2);
  for (const d of [good, bad]) rmSync(d, { recursive: true, force: true });
});
