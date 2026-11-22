import { describe, expect, it } from "vitest";
import { PIPE_METHODS } from "@offmanual/shared-schema";
import { CHANNEL_ID, PLUGIN_ID, RELAY_METHODS } from "../src/index.js";

describe("channel-relay identity", () => {
  it("has stable ids", () => {
    expect(PLUGIN_ID).toBe("offmanual-channel-relay");
    expect(CHANNEL_ID).toBe("offmanual-telegram");
  });
  it("only uses pipe methods that exist in the shared schema", () => {
    for (const m of RELAY_METHODS) expect(PIPE_METHODS).toContain(m);
  });
});
