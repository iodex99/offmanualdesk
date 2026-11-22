// Recognises "Windows said no" in tool failures so the guard can stop the turn
// (docs/ARCHITECTURE.md F5, SECURITY rule: never work around Access Denied).
//
// [A L3] Which codes actually surface on Server 2022 for UNC paths, mapped drives
// and redirected folders is pending lab item L3. Sources for the mapping below:
// - libuv src/win/error.c uv_translate_sys_error(): ERROR_ACCESS_DENIED (5) → UV_EPERM;
//   ERROR_NOACCESS, ERROR_CANT_ACCESS_FILE, ERROR_ELEVATION_REQUIRED, WSAEACCES → UV_EACCES.
//   (So Node reports a plain NTFS denial as EPERM on Windows, EACCES on POSIX.)
// - libuv include/uv/win.h: UV_EPERM = -4048, UV_EACCES = -4092 on Windows.
// - .NET/PowerShell: UnauthorizedAccessException, HRESULT 0x80070005 (E_ACCESSDENIED).
// - Win32 ERROR_NETWORK_ACCESS_DENIED = 65 for share-level denials.
// Classifying EPERM as a denial is deliberately conservative: a false "stop" is
// safe, a missed denial is not.

export interface AccessDenied {
  kind: "access_denied";
  /** Normalised source code, for audit: e.g. "EPERM", "EACCES", "WIN32_5", "HRESULT_0x80070005". */
  code: string;
}

const NODE_CODES = new Set(["EACCES", "EPERM"]);
const WINDOWS_ERRNOS = new Set([-4048, -4092]); // UV_EPERM, UV_EACCES on Windows
const POSIX_ERRNOS = new Set([-1, -13]); // EPERM, EACCES
const WIN32_CODES = new Map<number, string>([
  [5, "WIN32_5"], // ERROR_ACCESS_DENIED
  [65, "WIN32_65"], // ERROR_NETWORK_ACCESS_DENIED
  [1920, "WIN32_1920"], // ERROR_CANT_ACCESS_FILE
]);
const E_ACCESSDENIED = 0x80070005 | 0; // as a signed 32-bit HRESULT: -2147024891

/** Classifies a structured error (Node SystemError, wrapped tool error, .NET-style object). */
export function classifyError(err: unknown, depth = 0): AccessDenied | null {
  if (err === null || typeof err !== "object" || depth > 3) return null;
  const e = err as Record<string, unknown>;

  if (typeof e.code === "string" && NODE_CODES.has(e.code)) return { kind: "access_denied", code: e.code };
  if (typeof e.errno === "number" && (WINDOWS_ERRNOS.has(e.errno) || POSIX_ERRNOS.has(e.errno))) {
    return { kind: "access_denied", code: e.errno === -4092 || e.errno === -13 ? "EACCES" : "EPERM" };
  }
  for (const key of ["winError", "win32Error", "nativeErrorCode"]) {
    const v = e[key];
    if (typeof v === "number" && WIN32_CODES.has(v))
      return { kind: "access_denied", code: WIN32_CODES.get(v)! };
  }
  if (typeof e.hresult === "number" && (e.hresult | 0) === E_ACCESSDENIED) {
    return { kind: "access_denied", code: "HRESULT_0x80070005" };
  }
  if (e.name === "UnauthorizedAccessException") return { kind: "access_denied", code: "HRESULT_0x80070005" };
  return classifyError(e.cause, depth + 1);
}

// Text patterns for ERROR results of shell/exec tools (cmd, PowerShell, Node). Only
// apply these to a tool's error output, never to file contents or model text:
// a document that merely contains the words "Access is denied" is not a denial.
const TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\bEACCES\b/, "EACCES"],
  [/\bEPERM\b/, "EPERM"],
  [/^\s*Access is denied\.?\s*$/im, "WIN32_5"], // cmd.exe
  [/Access to the path .{1,300} is denied/i, "HRESULT_0x80070005"], // .NET / PowerShell
  [/UnauthorizedAccessException/, "HRESULT_0x80070005"],
  [/0x80070005/i, "HRESULT_0x80070005"],
];

/** Classifies the error text of a failed shell/exec tool call. */
export function classifyErrorText(text: string): AccessDenied | null {
  const sample = text.slice(0, 8192);
  for (const [re, code] of TEXT_PATTERNS) {
    if (re.test(sample)) return { kind: "access_denied", code };
  }
  return null;
}

/**
 * The plain-language message Desk shows (PRODUCT.md §4 rules 6 and 7). The path is
 * shown to the employee on their own server only; it never goes to the console.
 */
export function deniedMessage(displayPath: string | null): string {
  const what = displayPath ? displayPath : "this file or folder";
  return `You are not authorised to open ${what}. Use Request access to ask your admin.`;
}
