// Pure helpers for the release pipeline (docs/UPDATES.md §1). Tested in test/lib.test.mjs.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

/** Parses "1.2.3" or "1.2.3-rc.1" (no leading v). Throws on anything else. */
export function parseSemver(v) {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`not a semver version: ${JSON.stringify(v)}`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

/** Compares two semver strings: -1, 0 or 1. Pre-releases sort before the release. */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (const k of ["major", "minor", "patch"]) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const xs = x.pre.split(".");
  const ys = y.pre.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    const xn = /^\d+$/.test(xs[i]);
    const yn = /^\d+$/.test(ys[i]);
    if (xn && yn && +xs[i] !== +ys[i]) return +xs[i] < +ys[i] ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    if (xs[i] !== ys[i]) return xs[i] < ys[i] ? -1 : 1;
  }
  return 0;
}

/** Strips a leading "v" from a git tag and validates it. */
export function versionFromTag(tag) {
  const v = tag.replace(/^refs\/tags\//, "").replace(/^v/, "");
  parseSemver(v);
  return v;
}

const UNRELEASED_RE = /^## Unreleased[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m;
const EMPTY_SECTIONS = ["Added", "Changed", "Fixed", "Security"];

/**
 * Moves the Unreleased section's entries under "## [version] - YYYY-MM-DD" and leaves a
 * fresh empty Unreleased section. Refuses if Unreleased has no entries or the version exists.
 */
export function rollChangelog(md, version, isoDate) {
  parseSemver(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error("date must be YYYY-MM-DD");
  if (new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(md)) {
    throw new Error(`CHANGELOG already has a section for ${version}`);
  }
  const m = UNRELEASED_RE.exec(md);
  if (!m) throw new Error("CHANGELOG has no '## Unreleased' section");
  const body = m[1];
  const entries = body.split("\n").filter((l) => /^\s*- /.test(l));
  if (entries.length === 0) throw new Error("Unreleased section has no entries");
  // Drop empty "### X" headings from the released block.
  const cleaned = body
    .split(/^(?=### )/m)
    .filter((block) => !/^### /.test(block) || /^\s*- /m.test(block))
    .join("")
    .trim();
  const fresh = `## Unreleased\n\n${EMPTY_SECTIONS.map((s) => `### ${s}`).join("\n\n")}\n\n`;
  const released = `## [${version}] - ${isoDate}\n\n${cleaned}\n\n`;
  return md.slice(0, m.index) + fresh + released + md.slice(m.index + m[0].length);
}

/** Returns the body of "## [version]" (without the heading), or throws. */
export function extractNotes(md, version) {
  const re = new RegExp(
    `^## \\[${version.replace(/\./g, "\\.")}\\][^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
    "m",
  );
  const m = re.exec(md);
  if (!m) throw new Error(`CHANGELOG has no section for ${version}`);
  return m[1].trim();
}

/** Sets [package] version in a Cargo.toml without touching dependency versions. */
export function bumpCargoToml(toml, version) {
  parseSemver(version);
  const re = /(\[package\][\s\S]*?^version\s*=\s*")([^"]*)(")/m;
  if (!re.test(toml)) throw new Error("Cargo.toml has no [package] version");
  return toml.replace(re, `$1${version}$3`);
}

/** Sets the top-level "version" of a JSON document, keeping 2-space formatting. */
export function bumpJsonVersion(text, version) {
  parseSemver(version);
  const obj = JSON.parse(text);
  if (typeof obj.version !== "string") throw new Error("JSON has no top-level version");
  obj.version = version;
  return JSON.stringify(obj, null, 2) + "\n";
}

/** Files whose version must equal the release tag. Paths relative to repo root. */
export const VERSIONED_FILES = {
  cargo: "apps/desk/src-tauri/Cargo.toml",
  json: [
    "apps/desk/src-tauri/tauri.conf.json",
    "apps/desk/package.json",
    "apps/console/package.json",
    "packages/openclaw-plugins/guard/package.json",
    "packages/openclaw-plugins/channel-relay/package.json",
  ],
};

/** Reads every versioned file and returns { path: version }. */
export function readVersions(root) {
  const out = {};
  const cargo = readFileSync(join(root, VERSIONED_FILES.cargo), "utf8");
  const m = /\[package\][\s\S]*?^version\s*=\s*"([^"]*)"/m.exec(cargo);
  out[VERSIONED_FILES.cargo] = m ? m[1] : null;
  for (const p of VERSIONED_FILES.json) out[p] = JSON.parse(readFileSync(join(root, p), "utf8")).version;
  return out;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (lstatSync(p).isSymbolicLink()) throw new Error(`symlink not allowed in skills: ${p}`);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * Verifies skills/registry.lock.json against the files on disk (docs/SKILLS.md §2):
 * every listed file exists with the locked SHA-256; no unlisted files under a skill's
 * path or anywhere in vendored/ or offmanual/ (README.md/.gitkeep placeholders aside);
 * only approved or pending skills may be listed, and only approved ones are ever shipped.
 * Returns { skills, approved, files } counts or throws with every problem.
 */
export function verifySkillsLock(root) {
  const skillsDir = join(root, "skills");
  const lock = JSON.parse(readFileSync(join(skillsDir, "registry.lock.json"), "utf8"));
  const problems = [];
  if (lock.schema !== 1 || !Array.isArray(lock.skills)) throw new Error("registry.lock.json: bad schema");
  const listed = new Set();
  const ids = new Set();
  for (const s of lock.skills) {
    if (ids.has(s.id)) problems.push(`duplicate skill id ${s.id}`);
    ids.add(s.id);
    // "pending" skills are hash-checked but never shipped; "approved" needs a reviewer and date.
    const status = s.review?.status;
    if (status !== "approved" && status !== "pending") {
      problems.push(`${s.id}: review status is ${status ?? "missing"}`);
    }
    if (status === "approved" && (!s.review?.reviewer || !s.review?.date)) {
      problems.push(`${s.id}: reviewer/date missing`);
    }
    if (!/^(vendored|offmanual)\/[a-z0-9._-]+(__[a-z0-9._-]+)?$/i.test(s.path ?? "")) {
      problems.push(`${s.id}: path must be vendored/<owner>__<slug> or offmanual/<skill>`);
      continue;
    }
    for (const [rel, hash] of Object.entries(s.files ?? {})) {
      const full = join(skillsDir, s.path, rel);
      listed.add(full);
      try {
        if (sha256File(full) !== hash) problems.push(`${s.id}: hash mismatch ${rel}`);
      } catch {
        problems.push(`${s.id}: missing file ${rel}`);
      }
    }
  }
  const placeholder = (p) =>
    /(^|[\\/])(README\.md|\.gitkeep)$/.test(relative(skillsDir, p)) &&
    relative(skillsDir, p).split(sep).length === 2;
  for (const area of ["vendored", "offmanual"]) {
    for (const f of walk(join(skillsDir, area))) {
      if (!listed.has(f) && !placeholder(f))
        problems.push(`unlisted file ${relative(skillsDir, f).split(sep).join("/")}`);
    }
  }
  // Pack definitions ship with the release (ADR-043): every pack a skill names must exist.
  let packKeys = new Set();
  try {
    const packs = JSON.parse(readFileSync(join(skillsDir, "packs.json"), "utf8"));
    if (packs.schema !== 1 || !packs.packs || typeof packs.packs !== "object")
      problems.push("packs.json: bad schema");
    else {
      packKeys = new Set(Object.keys(packs.packs));
      if (!packKeys.has("core")) problems.push("packs.json: core pack missing");
      for (const [k, d] of Object.entries(packs.packs)) {
        if (!/^[a-z][a-z0-9-]{1,30}$/.test(k)) problems.push(`packs.json: bad pack key ${k}`);
        if (
          typeof d?.name !== "string" ||
          !Array.isArray(d?.tools) ||
          !d.tools.every((t) => /^[a-z][a-z0-9_]{1,63}$/.test(t))
        )
          problems.push(`packs.json: bad pack ${k}`);
      }
    }
  } catch {
    problems.push("packs.json missing or not JSON");
  }
  for (const s of lock.skills) {
    for (const p of s.packs ?? []) if (!packKeys.has(p)) problems.push(`${s.id}: unknown pack ${p}`);
  }
  if (problems.length) throw new Error(`skills lock check failed:\n- ${problems.join("\n- ")}`);
  const approved = lock.skills.filter((s) => s.review?.status === "approved").length;
  return { skills: lock.skills.length, approved, files: listed.size };
}
