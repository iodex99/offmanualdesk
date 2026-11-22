import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PIPE_METHODS,
  describeErrors,
  schemas,
  validateManifest,
  validateManifestSignature,
  validatePipeMessage,
  type ReleaseManifest,
} from "../src/index.js";

const fixture = (): ReleaseManifest =>
  JSON.parse(
    readFileSync(new URL("../fixtures/manifest.valid.json", import.meta.url), "utf8"),
  ) as ReleaseManifest;

describe("release manifest schema", () => {
  it("accepts the shared golden fixture (also parsed by the Go tests)", () => {
    const ok = validateManifest(fixture());
    expect(describeErrors(validateManifest.errors)).toEqual([]);
    expect(ok).toBe(true);
  });

  it.each([
    ["unknown field", (m: Record<string, unknown>) => (m.evil = true)],
    ["bad semver", (m: Record<string, unknown>) => (m.version = "v1")],
    ["security without deadline", (m: Record<string, unknown>) => delete m.deadlineAt],
    [
      "normal with deadline",
      (m: Record<string, unknown>) => {
        m.severity = "normal";
      },
    ],
    [
      "uppercase sha",
      (m: Record<string, unknown>) => ((m.payload as { sha256: string }).sha256 = "A".repeat(64)),
    ],
    ["absolute path", (m: Record<string, unknown>) => ((m.files as { path: string }[])[0]!.path = "/etc/x")],
    ["backslash path", (m: Record<string, unknown>) => ((m.files as { path: string }[])[0]!.path = "a\\b")],
    ["drive path", (m: Record<string, unknown>) => ((m.files as { path: string }[])[0]!.path = "C:x")],
    ["no files", (m: Record<string, unknown>) => (m.files = [])],
    ["bad key id", (m: Record<string, unknown>) => (m.keyId = "Bad Key")],
  ])("rejects %s", (_name, mutate) => {
    const m = fixture() as unknown as Record<string, unknown>;
    mutate(m);
    expect(validateManifest(m)).toBe(false);
  });
});

describe("manifest signature schema", () => {
  const good = { schema: 1, alg: "ed25519", keyId: "om-rel-2026a", sig: "A".repeat(86) + "==" };
  it("accepts a well-formed signature", () => {
    expect(validateManifestSignature(good)).toBe(true);
  });
  it("rejects other algorithms and extra fields", () => {
    expect(validateManifestSignature({ ...good, alg: "rsa" })).toBe(false);
    expect(validateManifestSignature({ ...good, extra: 1 })).toBe(false);
    expect(validateManifestSignature({ ...good, sig: "short" })).toBe(false);
  });
});

describe("pipe envelope schema", () => {
  it("accepts requests for every known method", () => {
    for (const method of PIPE_METHODS) {
      expect(validatePipeMessage({ jsonrpc: "2.0", id: 1, method, params: {} })).toBe(true);
    }
  });
  it("keeps the TS method list in step with the schema", () => {
    const schemaMethods = (schemas.ipcEnvelope as { $defs: { method: { enum: string[] } } }).$defs.method
      .enum;
    expect([...PIPE_METHODS].sort()).toEqual([...schemaMethods].sort());
  });
  it("rejects unknown methods, wrong version and extra top-level fields", () => {
    expect(validatePipeMessage({ jsonrpc: "2.0", id: 1, method: "admin.becomeSystem" })).toBe(false);
    expect(validatePipeMessage({ jsonrpc: "1.0", id: 1, method: "lock.get" })).toBe(false);
    // Identity must never travel at the envelope level (rule 4).
    expect(validatePipeMessage({ jsonrpc: "2.0", id: 1, method: "lock.get", sid: "S-1-5-21-1" })).toBe(false);
  });
  it("accepts success and error responses", () => {
    expect(validatePipeMessage({ jsonrpc: "2.0", id: "a", result: { locked: false } })).toBe(true);
    expect(
      validatePipeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
    ).toBe(true);
  });
});
