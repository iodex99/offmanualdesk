import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsTab } from "./SettingsTab";
import { effectiveLockMinutes, lockChoices, type DeskSettings, type SettingsApi } from "./settings";

afterEach(cleanup);

describe("lock time helpers", () => {
  it("the firm's maximum always wins", () => {
    expect(effectiveLockMinutes(15, null)).toBe(15);
    expect(effectiveLockMinutes(15, 5)).toBe(5);
    expect(effectiveLockMinutes(15, 30)).toBe(15);
    expect(effectiveLockMinutes(15, 0)).toBe(15);
    expect(effectiveLockMinutes(15, Number.NaN)).toBe(15);
  });
  it("offers steps below the maximum and the maximum", () => {
    expect(lockChoices(15)).toEqual([5, 10, 15]);
    expect(lockChoices(45)).toEqual([5, 10, 15, 30, 45]);
    expect(lockChoices(3)).toEqual([3]);
  });
});

describe("Settings tab", () => {
  it("saves the side and a shorter lock time; the firm limit clears it", async () => {
    let saved: DeskSettings | null = null;
    const api: SettingsApi = {
      get: async () => ({ side: "right", lockMinutes: null }),
      set: vi.fn(async (s: DeskSettings) => {
        saved = s;
      }),
    };
    const agent = vi.fn(async () => ({ lockTimeoutMax: 30 }));
    render(<SettingsTab agent={agent} api={api} />);
    fireEvent.click(await screen.findByLabelText(/Left side/));
    await waitFor(() => expect(saved).toEqual({ side: "left", lockMinutes: null }));
    const select = (await screen.findByLabelText("Lock after")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("30"));
    fireEvent.change(select, { target: { value: "10" } });
    await waitFor(() => expect(saved).toEqual({ side: "left", lockMinutes: 10 }));
    fireEvent.change(select, { target: { value: "30" } });
    await waitFor(() => expect(saved).toEqual({ side: "left", lockMinutes: null }));
    expect(screen.getByText("Saved.")).toBeTruthy();
  });

  it("shows the plain error when saving fails", async () => {
    const api: SettingsApi = {
      get: async () => ({ side: "right", lockMinutes: null }),
      set: async () => {
        throw "Your settings couldn't be saved.";
      },
    };
    render(<SettingsTab agent={vi.fn(async () => ({}))} api={api} />);
    fireEvent.click(await screen.findByLabelText(/Left side/));
    expect(await screen.findByText("Your settings couldn't be saved.")).toBeTruthy();
  });
});
