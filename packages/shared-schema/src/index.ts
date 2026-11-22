// Shared schemas and validators. Types here mirror the JSON Schemas in ../schemas;
// the Go mirror for the manifest is apps/server-agent/pkg/manifest.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction, type ErrorObject } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv-formats ships CommonJS; depending on the loader its default import is either the
// plugin function or the module object holding it as `.default`.
type AddFormats = (ajv: Ajv2020) => Ajv2020;
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as unknown as AddFormats;

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  schema: 1;
  version: string;
  commit: string;
  createdAt: string;
  severity: "normal" | "security";
  deadlineAt?: string;
  minAgentVersion: string;
  openclawVersion: string;
  nodeVersion: string;
  keyId: string;
  payload: { name: string; sha256: string; size: number };
  files: ManifestFile[];
}

export interface ManifestSignature {
  schema: 1;
  alg: "ed25519";
  keyId: string;
  sig: string;
}

/** Pipe methods (docs/ARCHITECTURE.md §3.1). Keep in step with schemas/ipc/envelope.schema.json. */
export const PIPE_METHODS = [
  "session.hello",
  "auth.bindStart",
  "auth.bindComplete",
  "auth.recover",
  "auth.stepUpCheck",
  "auth.totpEnrolStart",
  "auth.totpEnrolConfirm",
  "auth.pinSet",
  "auth.verifyDaily",
  "auth.verifyPin",
  "auth.stepUp",
  "lock.get",
  "lock.set",
  "gateway.lease",
  "gateway.release",
  "policy.get",
  "audit.append",
  "review.notify",
  "telegram.linkStart",
  "telegram.subscribe",
  "telegram.send",
  "access.request",
  "notices.list",
  "notices.ack",
  "update.status",
  "update.switch",
  "support.bundle",
  "support.submit",
] as const;

export type PipeMethod = (typeof PIPE_METHODS)[number];

export const PIPE_NAME = String.raw`\\.\pipe\offmanual-agent`;

export interface PipeRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: PipeMethod;
  params?: Record<string, unknown>;
  correlationId?: string;
}

function loadSchema(rel: string): object {
  const url = new URL(`../schemas/${rel}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as object;
}

export const schemas = {
  manifest: loadSchema("manifest.schema.json"),
  manifestSignature: loadSchema("manifest-signature.schema.json"),
  ipcEnvelope: loadSchema("ipc/envelope.schema.json"),
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);

export const validateManifest: ValidateFunction<ReleaseManifest> = ajv.compile<ReleaseManifest>(
  schemas.manifest,
);
export const validateManifestSignature: ValidateFunction<ManifestSignature> = ajv.compile<ManifestSignature>(
  schemas.manifestSignature,
);
export const validatePipeMessage: ValidateFunction = ajv.compile(schemas.ipcEnvelope);

/** Formats ajv errors as one short line each (for logs: no values, only paths and keywords). */
export function describeErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || "/"} ${e.keyword}`);
}
