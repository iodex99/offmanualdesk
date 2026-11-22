#!/usr/bin/env node
// Release helper CLI. Used locally by Dwahnil (prepare) and by .github/workflows/release.yml.
//
//   node tools/release/cli.mjs prepare 1.2.0        roll CHANGELOG + bump every versioned file
//   node tools/release/cli.mjs check-tag v1.2.0     fail unless all versioned files say 1.2.0 and CHANGELOG has it
//   node tools/release/cli.mjs notes 1.2.0          print the CHANGELOG section (release notes)
//   node tools/release/cli.mjs verify-skills        check skills/registry.lock.json against disk
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERSIONED_FILES,
  bumpCargoToml,
  bumpJsonVersion,
  compareSemver,
  extractNotes,
  readVersions,
  rollChangelog,
  verifySkillsLock,
  versionFromTag,
} from "./lib.mjs";

const root = process.env.OM_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const write = (p, s) => writeFileSync(join(root, p), s);

function todayIST() {
  const d = new Date(Date.now() + 330 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

const [cmd, arg] = process.argv.slice(2);
try {
  switch (cmd) {
    case "prepare": {
      const version = versionFromTag(arg ?? "");
      const current = readVersions(root)[VERSIONED_FILES.cargo];
      if (compareSemver(version, current) <= 0)
        throw new Error(`${version} must be greater than current ${current}`);
      write("CHANGELOG.md", rollChangelog(read("CHANGELOG.md"), version, todayIST()));
      write(VERSIONED_FILES.cargo, bumpCargoToml(read(VERSIONED_FILES.cargo), version));
      for (const p of VERSIONED_FILES.json) write(p, bumpJsonVersion(read(p), version));
      console.log(`Prepared ${version}. Next:`);
      console.log(`  pnpm install && git add -A && git commit -m "chore(release): v${version}"`);
      console.log(`  git tag -a v${version} -m "v${version}" && git push origin main v${version}`);
      break;
    }
    case "check-tag": {
      const version = versionFromTag(arg ?? "");
      const versions = readVersions(root);
      const wrong = Object.entries(versions).filter(([, v]) => v !== version);
      if (wrong.length) {
        throw new Error(`tag ${version} does not match: ${wrong.map(([p, v]) => `${p}=${v}`).join(", ")}`);
      }
      extractNotes(read("CHANGELOG.md"), version);
      console.log(`OK: every versioned file and CHANGELOG say ${version}`);
      break;
    }
    case "notes":
      process.stdout.write(extractNotes(read("CHANGELOG.md"), versionFromTag(arg ?? "")) + "\n");
      break;
    case "verify-skills": {
      const r = verifySkillsLock(root);
      console.log(
        `OK: ${r.skills} skills (${r.approved} approved for release), ${r.files} files match skills/registry.lock.json`,
      );
      break;
    }
    default:
      throw new Error("usage: cli.mjs prepare <v> | check-tag <tag> | notes <v> | verify-skills");
  }
} catch (err) {
  console.error(`release: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
