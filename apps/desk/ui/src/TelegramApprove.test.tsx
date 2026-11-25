import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GIVE_UP_MS, POLL_MS, TelegramApprove } from "./TelegramApprove";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ID = "ab".repeat(16);

function agentWith(statuses: string[]) {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const agent = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, ...(params ? { params } : {}) });
    if (method === "unlock.telegramStart") return { requestId: ID };
    if (method === "unlock.telegramStatus") return { status: statuses.shift() ?? "pending" };
    throw new Error("unexpected");
  });
  return { agent, calls };
}

const poll = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  });
};

describe("Approve on Telegram (ADR-068)", () => {
  it("waits for the phone, then reports approval", async () => {
    const { agent, calls } = agentWith(["pending", "approved"]);
    const onApproved = vi.fn();
    render(<TelegramApprove agent={agent} onApproved={onApproved} />);
    await act(async () => {
      fireEvent.click(screen.getByText("Approve on Telegram"));
    });
    expect(screen.getByText("Check Telegram on your phone and tap Approve.")).toBeTruthy();
    await poll();
    expect(onApproved).not.toHaveBeenCalled();
    await poll();
    expect(onApproved).toHaveBeenCalledTimes(1);
    expect(calls[1]).toEqual({ method: "unlock.telegramStatus", params: { requestId: ID } });
  });

  it("says when it was denied or expired, and the button comes back", async () => {
    const { agent } = agentWith(["denied"]);
    render(<TelegramApprove agent={agent} onApproved={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByText("Approve on Telegram"));
    });
    await poll();
    expect(screen.getByText("Denied on Telegram. Desk stays locked.")).toBeTruthy();
    expect(screen.getByText("Approve on Telegram")).toBeTruthy();
  });

  it("gives up after the request runs out", async () => {
    const { agent } = agentWith([]);
    let t = 0;
    render(<TelegramApprove agent={agent} onApproved={vi.fn()} now={() => t} />);
    await act(async () => {
      fireEvent.click(screen.getByText("Approve on Telegram"));
    });
    t = GIVE_UP_MS + 1;
    await poll();
    expect(screen.getByText("No answer from Telegram. Try again or use your PIN.")).toBeTruthy();
  });

  it("shows the Server Agent's plain reason when it can't be used", async () => {
    const agent = vi.fn(async () => {
      throw { code: -32004, message: "Approve on Telegram isn't available right now. Unlock with your PIN." };
    });
    render(<TelegramApprove agent={agent} onApproved={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByText("Approve on Telegram"));
    });
    expect(
      screen.getByText("Approve on Telegram isn't available right now. Unlock with your PIN."),
    ).toBeTruthy();
  });
});
