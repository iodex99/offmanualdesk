import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { UpdateNotice, type UpdateApi, type UpdateStatus } from "./UpdateNotice";

afterEach(cleanup);

const api = (s: UpdateStatus, applyErr?: unknown) => {
  const applied: string[] = [];
  const a: UpdateApi = {
    check: async () => s,
    apply: async (v) => {
      applied.push(v);
      if (applyErr) throw applyErr;
      return { running: true, port: 18800 };
    },
  };
  return { a, applied };
};
const NOW = () => new Date("2026-11-25T06:00:00Z");

describe("UpdateNotice", () => {
  it("shows nothing when no update is available", async () => {
    const { a } = api({ running: "1.0.0", available: null, severity: "", deadlineAt: null });
    const { container } = render(<UpdateNotice api={a} now={NOW} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });

  it("offers restart to update and reports success", async () => {
    const { a, applied } = api({
      running: "1.0.0",
      available: "1.1.0",
      severity: "normal",
      deadlineAt: null,
    });
    render(<UpdateNotice api={a} now={NOW} />);
    expect(await screen.findByText(/Off Manual 1.1.0 is ready/)).toBeTruthy();
    fireEvent.click(screen.getByText("Restart to update"));
    expect(await screen.findByText("Updated to 1.1.0.")).toBeTruthy();
    expect(applied).toEqual(["1.1.0"]);
  });

  it("security update before the deadline shows the date; after it installs itself", async () => {
    const before = api({
      running: "1.0.0",
      available: "1.0.1",
      severity: "security",
      deadlineAt: "2026-11-30T06:00:00Z",
    });
    render(<UpdateNotice api={before.a} now={NOW} />);
    expect(await screen.findByText(/installs itself after 30-11-2026/)).toBeTruthy();
    expect(before.applied).toEqual([]);
    cleanup();
    const after = api({
      running: "1.0.0",
      available: "1.0.1",
      severity: "security",
      deadlineAt: "2026-11-24T06:00:00Z",
    });
    render(<UpdateNotice api={after.a} now={NOW} />);
    expect(await screen.findByText("Updated to 1.0.1.")).toBeTruthy();
    expect(after.applied).toEqual(["1.0.1"]);
  });

  it("shows the plain message when the update rolled back", async () => {
    const msg =
      "The update didn't work, so Off Manual went back to the previous version. Please use Report a problem.";
    const { a } = api(
      { running: "1.0.0", available: "1.1.0", severity: "normal", deadlineAt: null },
      { message: msg },
    );
    render(<UpdateNotice api={a} now={NOW} />);
    fireEvent.click(await screen.findByText("Restart to update"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", msg);
  });

  it("stays quiet when the check fails", async () => {
    const a: UpdateApi = { check: vi.fn().mockRejectedValue(new Error("x")), apply: vi.fn() };
    const { container } = render(<UpdateNotice api={a} now={NOW} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
  });
});

describe("UpdateNotice defaults", () => {
  it("checks once with the default clock (no effect loop)", async () => {
    let checks = 0;
    const a: UpdateApi = {
      check: async () => {
        checks++;
        return { running: "1.0.0", available: "1.1.0", severity: "normal", deadlineAt: null };
      },
      apply: async () => undefined,
    };
    render(<UpdateNotice api={a} />);
    expect(await screen.findByText(/1.1.0 is ready/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(checks).toBe(1);
  });
});
