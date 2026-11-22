import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App } from "./App";

afterEach(cleanup);

const fixedNow = () => new Date("2026-11-22T06:00:00Z");

describe("App", () => {
  it("shows the version once loaded, with the date in DD-MM-YYYY", async () => {
    render(
      <App
        now={fixedNow}
        loadInfo={() => Promise.resolve({ name: "Off Manual Desk", version: "1.2.3", runtime: "tauri" })}
      />,
    );
    expect(screen.getByText("Starting…")).toBeTruthy();
    expect(await screen.findByText("Version 1.2.3")).toBeTruthy();
    expect(screen.getByText("22-11-2026")).toBeTruthy();
  });

  it("marks the browser preview", async () => {
    render(
      <App
        now={fixedNow}
        loadInfo={() => Promise.resolve({ name: "x", version: "dev", runtime: "browser" })}
      />,
    );
    expect(await screen.findByText("Version dev (preview)")).toBeTruthy();
  });

  it("shows a plain-language error with a next step, never a stack trace", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <App now={fixedNow} loadInfo={() => Promise.reject(new Error("TypeError at invoke (core.js:12)"))} />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Close it and open it again");
    expect(alert.textContent).not.toContain("TypeError");
    spy.mockRestore();
  });
});
