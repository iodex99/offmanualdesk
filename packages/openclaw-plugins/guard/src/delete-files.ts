// Review-queue action: delete files (ADR-041). Runs as the employee, so Windows
// rights decide; a denial is reported, never worked around (rule 2).
import { lstat, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { classifyErrorText } from "./access-denied.js";
import type { ActionKind } from "./review.js";

export interface DeleteFilesParams {
  paths: string[];
  reason: string;
}

export const MAX_DELETE_FILES = 50;
// Absolute drive path (C:\...) or UNC (\\server\share\...). No wildcards, no relative parts.
const ABS = /^(?:[A-Za-z]:\\|\\\\[^\\/?*:"<>|]+\\[^\\/?*:"<>|]+\\)/;
const BAD = /[*?"<>|]|(^|\\)\.\.?(\\|$)/;

function isPathOk(p: string): boolean {
  if (p.length > 1024 || /[\0\r\n]/.test(p) || p.includes("/")) return false;
  if (!ABS.test(p)) return false;
  const rest = p.startsWith("\\\\") ? p.slice(2) : p.slice(3);
  return !BAD.test(rest.replace(/^[A-Za-z]:/, ""));
}

export const deleteFiles: ActionKind<DeleteFilesParams> = {
  kind: "delete_files",
  parse(params) {
    const a = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
    const extra = Object.keys(a).filter((k) => k !== "paths" && k !== "reason");
    if (extra.length > 0) return { ok: false, message: `Unexpected field ${extra[0]}.` };
    if (!Array.isArray(a.paths) || a.paths.length === 0 || a.paths.length > MAX_DELETE_FILES) {
      return { ok: false, message: `Give between 1 and ${MAX_DELETE_FILES} file paths.` };
    }
    const paths: string[] = [];
    for (const p of a.paths) {
      if (typeof p !== "string" || !isPathOk(p)) {
        return {
          ok: false,
          message:
            "Each path must be a full Windows path like C:\\Folder\\file.pdf or \\\\server\\share\\file.pdf, without wildcards.",
        };
      }
      if (!paths.some((x) => x.toLowerCase() === p.toLowerCase())) paths.push(p);
    }
    const reason = typeof a.reason === "string" ? a.reason.trim().slice(0, 300) : "";
    if (!reason) return { ok: false, message: "Say in a few words why these files should be deleted." };
    return { ok: true, value: { paths, reason } };
  },
  summarize(p) {
    const names = p.paths.slice(0, 3).map((x) => basename(x.replace(/\\/g, "/")));
    const more = p.paths.length > 3 ? ` and ${p.paths.length - 3} more` : "";
    const what = p.paths.length === 1 ? "1 file" : `${p.paths.length} files`;
    return `Delete ${what} (${names.join(", ")}${more}). Reason: ${p.reason}`;
  },
  async execute(p) {
    let deleted = 0;
    let denied = 0;
    let missing = 0;
    let folders = 0;
    let other = 0;
    for (const path of p.paths) {
      try {
        const st = await lstat(path);
        if (st.isDirectory()) {
          folders++; // v1 deletes files only; a folder needs a person in Explorer
          continue;
        }
        await unlink(path);
        deleted++;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") missing++;
        else if (code === "EPERM" || code === "EACCES" || classifyErrorText(String(e))) denied++;
        else other++;
      }
    }
    const parts = [`Deleted ${deleted} of ${p.paths.length}.`];
    if (denied) parts.push(`${denied} you don't have permission to delete (ask your admin if you need to).`);
    if (missing) parts.push(`${missing} were already gone.`);
    if (folders) parts.push(`${folders} are folders, which Off Manual doesn't delete.`);
    if (other) parts.push(`${other} couldn't be deleted (the file may be open).`);
    return { ok: deleted + missing === p.paths.length, message: parts.join(" ") };
  },
};
