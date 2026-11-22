import { describe, expect, it } from "vitest";
import { GET } from "../app/api/health/route";
import { health } from "../lib/health";

describe("health", () => {
  it("returns a minimal payload", () => {
    const h = health(new Date("2026-11-22T00:00:00Z"), "1.2.3");
    expect(h).toEqual({
      status: "ok",
      service: "offmanual-console",
      version: "1.2.3",
      time: "2026-11-22T00:00:00.000Z",
    });
  });

  it("GET /api/health responds 200 JSON, uncached, with no extra keys", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["service", "status", "time", "version"]);
  });
});
