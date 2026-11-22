#!/usr/bin/env node
// skill-vet: static checks for a skill before it enters skills/ (docs/SKILLS.md §2).
//
//   node tools/skill-vet/vet.mjs check <skill-dir> [--json]   findings + review checklist
//   node tools/skill-vet/vet.mjs lock  <skill-dir> --id <id> --version <v> --packs a,b
//                                                               prints a registry.lock.json entry (status pending)
//
// It never runs anything from the skill. Findings are hints for the human reviewer,
// who must still read every file; "block" findings fail the check outright.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const TEXT_EXT = /\.(md|txt|json|ya?ml|toml|py|js|mjs|cjs|ts|ps1|psm1|sh|bat|cmd|csv|xml|html?)$/i;
const BINARY_EXT = /\.(exe|dll|so|dylib|bin|msi|scr|com|jar|class|pyc|node|wasm)$/i;

/** Each rule: id, level (block | warn), test(text, file) → bool, why. */
export const RULES = [
  { id: "binary", level: "block", file: (f) => BINARY_EXT.test(f), why: "ships a compiled binary" },
  { id: "install-script", level: "block", text: /"(pre|post)?install"\s*:/, why: "npm install script" },
  {
    id: "setup-py",
    level: "block",
    file: (f) => /(^|\/)setup\.py$/.test(f),
    why: "Python setup script runs on install",
  },
  { id: "pip-git", level: "block", text: /git\+https?:\/\//, why: "dependency fetched from a git URL" },
  {
    id: "network",
    level: "warn",
    text: /https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+/i,
    why: "contacts a network host (list every destination)",
  },
  {
    id: "http-client",
    level: "warn",
    text: /\b(fetch\(|axios|requests\.(get|post)|urllib|http\.client|Invoke-WebRequest|Invoke-RestMethod|curl |wget )/,
    why: "HTTP client in code",
  },
  {
    id: "shell",
    level: "warn",
    text: /\b(child_process|subprocess|os\.system|os\.popen|Start-Process|ShellExecute|cmd \/c|powershell(\.exe)? -c)/i,
    why: "runs shell commands",
  },
  {
    id: "eval",
    level: "warn",
    text: /\b(eval\(|new Function\(|exec\(compile|atob\(|fromCharCode)/,
    why: "dynamic code / decoding",
  },
  {
    id: "base64-blob",
    level: "warn",
    text: /[A-Za-z0-9+/]{200,}={0,2}/,
    why: "long base64 blob (obfuscation?)",
  },
  {
    id: "abs-path",
    level: "warn",
    text: /(?<![\w\\])(?:[A-Za-z]:[\\/]{1,2}\w|\/(?:etc|usr|var|root|home)\/)/,
    why: "absolute path: check it never writes outside the client folder",
  },
  {
    id: "installer-metadata",
    level: "warn",
    text: /"install"\s*:\s*\[/,
    why: "declares installers in metadata.openclaw.install",
  },
  {
    id: "credentials",
    level: "warn",
    text: /\b(api[_-]?key|secret|password|token)\b\s*[:=]/i,
    why: "handles credentials: confirm where they come from",
  },
];

export function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`symlink in skill: ${p}`);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile()) out.push(p);
  }
  return out.sort();
}

/** Parses the YAML frontmatter fields we need (name, description) without a YAML lib. */
export function frontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return null;
  const get = (k) => {
    const r = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(m[1]);
    return r ? r[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return { name: get("name"), description: get("description") };
}

export function check(skillDir) {
  const files = walk(skillDir);
  const rel = (f) => relative(skillDir, f).split(sep).join("/");
  const findings = [];
  const skillMd = files.find((f) => rel(f) === "SKILL.md");
  if (!skillMd)
    findings.push({ rule: "skill-md", level: "block", file: "SKILL.md", why: "SKILL.md missing" });
  else {
    const fm = frontmatter(readFileSync(skillMd, "utf8"));
    if (!fm?.name || !fm?.description)
      findings.push({
        rule: "frontmatter",
        level: "block",
        file: "SKILL.md",
        why: "frontmatter needs name and description",
      });
  }
  for (const f of files) {
    const r = rel(f);
    for (const rule of RULES.filter((x) => x.file))
      if (rule.file(r)) findings.push({ rule: rule.id, level: rule.level, file: r, why: rule.why });
    if (!TEXT_EXT.test(r)) continue;
    const text = readFileSync(f, "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      for (const rule of RULES.filter((x) => x.text)) {
        if (rule.text.test(line))
          findings.push({ rule: rule.id, level: rule.level, file: r, line: i + 1, why: rule.why });
      }
    });
  }
  const hashes = Object.fromEntries(
    files.map((f) => [rel(f), createHash("sha256").update(readFileSync(f)).digest("hex")]),
  );
  return { ok: !findings.some((f) => f.level === "block"), findings, files: hashes };
}

export const CHECKLIST = [
  "What does it execute (tools, shell, scripts)?",
  "Every network destination, and why",
  "Every file path it writes (must stay inside the client folder)",
  "Binaries it needs and where they come from",
  "Does it send data to a third party? Reject 'managed OAuth' proxies; use direct APIs",
  "Windows compatibility (paths, PowerShell, no POSIX-only tools)",
  "Outputs follow PRODUCT.md §4 naming (<Task>_<Client>_<Period>.xlsx) and never submit to a portal",
];

function main(argv) {
  const [cmd, dir, ...rest] = argv;
  const opt = (k) => {
    const i = rest.indexOf(k);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (!dir || !["check", "lock"].includes(cmd)) {
    console.error(
      "usage: vet.mjs check <dir> [--json] | lock <dir> --id <id> --version <v> --packs a,b [--path vendored/x__y]",
    );
    return 2;
  }
  const r = check(dir);
  if (cmd === "check") {
    if (rest.includes("--json")) console.log(JSON.stringify(r, null, 2));
    else {
      for (const f of r.findings)
        console.log(
          `${f.level.toUpperCase().padEnd(5)} ${f.rule.padEnd(18)} ${f.file}${f.line ? ":" + f.line : ""}  ${f.why}`,
        );
      console.log(`\n${Object.keys(r.files).length} files. Review checklist (answer each in PROVENANCE.md):`);
      for (const c of CHECKLIST) console.log(`  [ ] ${c}`);
      console.log(
        r.ok
          ? "\nNo blocking findings. A human must still read every file."
          : "\nBLOCKED: fix the block findings first.",
      );
    }
    return r.ok ? 0 : 1;
  }
  const id = opt("--id");
  const version = opt("--version");
  if (!id || !version) {
    console.error("lock needs --id and --version");
    return 2;
  }
  if (!r.ok) {
    console.error("refusing to lock a skill with blocking findings");
    return 1;
  }
  const entry = {
    id,
    version,
    path: opt("--path") ?? `offmanual/${id.split("/").pop()}`,
    packs: (opt("--packs") ?? "core").split(",").filter(Boolean),
    review: { status: "pending", reviewer: "", date: "" },
    files: r.files,
  };
  console.log(JSON.stringify(entry, null, 2));
  return 0;
}

if ((process.argv[1] ?? "").replaceAll("\\", "/").endsWith("tools/skill-vet/vet.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
