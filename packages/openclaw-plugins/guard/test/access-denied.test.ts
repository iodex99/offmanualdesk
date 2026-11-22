import { describe, expect, it } from "vitest";
import { PLUGIN_ID, classifyError, classifyErrorText, deniedMessage } from "../src/index.js";

function nodeError(code: string, errno: number): NodeJS.ErrnoException {
  const e = new Error(
    `${code}: operation not permitted, open '\\\\fs\\Clients\\X\\a.xlsx'`,
  ) as NodeJS.ErrnoException;
  e.code = code;
  e.errno = errno;
  e.syscall = "open";
  return e;
}

describe("classifyError", () => {
  it.each([
    ["Node EPERM on Windows (ERROR_ACCESS_DENIED)", nodeError("EPERM", -4048), "EPERM"],
    ["Node EACCES on Windows", nodeError("EACCES", -4092), "EACCES"],
    ["Node EACCES on POSIX", nodeError("EACCES", -13), "EACCES"],
    ["errno only (Windows EPERM)", { errno: -4048 }, "EPERM"],
    ["errno only (POSIX EACCES)", { errno: -13 }, "EACCES"],
    ["Win32 5", { winError: 5 }, "WIN32_5"],
    ["Win32 65 network denial", { win32Error: 65 }, "WIN32_65"],
    ["HRESULT signed", { hresult: -2147024891 }, "HRESULT_0x80070005"],
    ["HRESULT unsigned", { hresult: 0x80070005 }, "HRESULT_0x80070005"],
    [".NET exception name", { name: "UnauthorizedAccessException" }, "HRESULT_0x80070005"],
    ["wrapped in cause", new Error("tool failed", { cause: nodeError("EPERM", -4048) }), "EPERM"],
  ])("%s", (_name, err, code) => {
    expect(classifyError(err)).toEqual({ kind: "access_denied", code });
  });

  it.each([
    ["ENOENT", nodeError("ENOENT", -4058)],
    ["EBUSY (sharing violation)", nodeError("EBUSY", -4082)],
    ["null", null],
    ["string", "EACCES"],
    ["number", 5],
    ["unrelated win32", { winError: 2 }],
  ])("does not flag %s", (_name, err) => {
    expect(classifyError(err)).toBeNull();
  });

  it("stops following cause chains after a few levels (no cycles)", () => {
    const a: Record<string, unknown> = {};
    a.cause = a;
    expect(classifyError(a)).toBeNull();
  });
});

describe("classifyErrorText", () => {
  it.each([
    ["cmd", "Access is denied.\r\n", "WIN32_5"],
    [
      "PowerShell",
      "Get-Content : Access to the path '\\\\fs\\Clients\\X\\a.txt' is denied.",
      "HRESULT_0x80070005",
    ],
    ["Node", "Error: EPERM: operation not permitted, open 'C:\\x'", "EPERM"],
    ["HRESULT", "Exception from HRESULT: 0x80070005", "HRESULT_0x80070005"],
  ])("detects %s denial", (_n, text, code) => {
    expect(classifyErrorText(text)).toEqual({ kind: "access_denied", code });
  });

  it("does not flag ordinary prose that mentions access", () => {
    expect(classifyErrorText("The client says access is denied to their GST portal sometimes.")).toBeNull();
    expect(classifyErrorText("File not found")).toBeNull();
  });
});

describe("deniedMessage", () => {
  it("names the folder and gives the next step", () => {
    expect(deniedMessage("Clients\\Mehta Traders")).toBe(
      "You are not authorised to open Clients\\Mehta Traders. Use Request access to ask your admin.",
    );
    expect(deniedMessage(null)).toContain("this file or folder");
  });
});

describe("plugin identity", () => {
  it("has a stable id", () => {
    expect(PLUGIN_ID).toBe("offmanual-guard");
  });
});
