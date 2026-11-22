import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Unlock } from "./Unlock";
import type { AgentCall } from "./agent";

afterEach(cleanup);

vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64,AAAA" } }));

const base = {
  known: true,
  name: "Asha",
  status: "active",
  totpEnrolled: true,
  pinSet: true,
  locked: true,
  dayUnlocked: true,
};

/** A scripted Server Agent: replies per method, records calls. */
function fakeAgent(replies: Record<string, unknown[] | ((p: Record<string, unknown>) => unknown)>) {
  const calls: [string, Record<string, unknown>][] = [];
  const agent: AgentCall = async (method, params = {}) => {
    calls.push([method, params]);
    const r = replies[method];
    if (typeof r === "function") return r(params);
    if (!r || r.length === 0) throw { code: -32601, message: `no reply scripted for ${method}` };
    const next = r.length > 1 ? r.shift() : r[0];
    if (
      next instanceof Error ||
      (typeof next === "object" && next !== null && "code" in next && "message" in next && !("known" in next))
    )
      throw next;
    return next;
  };
  return { agent, calls };
}

describe("recovery", () => {
  it("a recovery code resets the authenticator and goes back to enrolment", async () => {
    const { agent, calls } = fakeAgent({
      "session.hello": [
        { ...base, dayUnlocked: false },
        { ...base, dayUnlocked: false, totpEnrolled: false },
      ],
      "auth.recover": (p) => {
        if (p.code !== "ABCDE-FGHJK")
          throw { code: -32003, message: "That recovery code isn't right, or it was already used." };
        return { reset: true, codesLeft: 7 };
      },
      "auth.totpEnrolStart": [{ secret: "S", uri: "otpauth://totp/x" }],
    });
    render(<Unlock agent={agent} startGateway={async () => ({ running: true, port: 18800 })} />);
    fireEvent.click(await screen.findByText("Lost your phone?"));
    const input = screen.getByLabelText(/Recovery code/);
    fireEvent.change(input, { target: { value: "zzzzz-zzzzz" } });
    fireEvent.click(screen.getByText("Continue"));
    expect(await screen.findByText(/isn't right, or it was already used/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Recovery code/), { target: { value: "abcde-fghjk" } });
    fireEvent.click(screen.getByText("Continue"));
    expect(await screen.findByAltText(/authenticator app/)).toBeTruthy();
    expect(calls.filter((c) => c[0] === "auth.recover").map((c) => c[1])).toEqual([
      { code: "ZZZZZ-ZZZZZ" },
      { code: "ABCDE-FGHJK" },
    ]);
  });
});

describe("licence", () => {
  it("shows the paused message instead of the assistant and checks again", async () => {
    const start = vi.fn(async () => ({ running: true, port: 18800 }));
    const { agent } = fakeAgent({
      "session.hello": [
        {
          ...base,
          locked: false,
          servicePaused: true,
          pausedMessage: "Off Manual is paused for your firm. Please contact your admin.",
        },
        { ...base, locked: false },
      ],
    });
    render(<Unlock agent={agent} startGateway={start} />);
    expect(await screen.findByText(/paused for your firm/)).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Check again"));
    expect(await screen.findByText(/You're signed in, Asha/)).toBeTruthy();
  });

  it("shows the overdue notice above a working assistant", async () => {
    const { agent } = fakeAgent({
      "session.hello": [
        {
          ...base,
          locked: false,
          notice: "Your firm's Off Manual bill is overdue. Your admin has been told.",
        },
      ],
    });
    render(<Unlock agent={agent} startGateway={async () => ({ running: true, port: 18800 })} />);
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "Your firm's Off Manual bill is overdue. Your admin has been told.",
    );
    expect(screen.getByText(/You're signed in, Asha/)).toBeTruthy();
  });
});

describe("Unlock flow", () => {
  it("binds a new Windows account with the code from the console sign-in", async () => {
    const { agent, calls } = fakeAgent({
      "session.hello": [
        { known: false, locked: true, totpEnrolled: false, pinSet: false, dayUnlocked: false },
        { ...base, totpEnrolled: false, pinSet: false },
      ],
      "auth.bindStart": [{ url: "https://console.offmanual.in/bind" }],
      "auth.bindComplete": (p) => {
        if (p.code !== "ABCD-EFGH")
          throw {
            code: -32001,
            message: "That code isn't valid or has expired. Sign in again to get a new one.",
          };
        return { bound: true, name: "Asha" };
      },
      "auth.totpEnrolStart": [{ secret: "S", uri: "otpauth://x" }],
    });
    render(<Unlock agent={agent} startGateway={async () => ({ running: true, port: 18800 })} />);
    expect(await screen.findByText("https://console.offmanual.in/bind")).toBeTruthy();
    const input = screen.getByLabelText(/Code/);
    fireEvent.change(input, { target: { value: "wxyz-2345" } });
    fireEvent.click(screen.getByText("Continue"));
    expect(await screen.findByText(/isn't valid or has expired/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Code/), { target: { value: "abcd-efgh" } });
    fireEvent.click(screen.getByText("Continue"));
    expect(await screen.findByAltText(/authenticator app/)).toBeTruthy();
    expect(calls.filter((c) => c[0] === "auth.bindComplete").map((c) => c[1])).toEqual([
      { code: "WXYZ-2345" },
      { code: "ABCD-EFGH" },
    ]);
  });

  it("explains what to do when the Windows account isn't set up", async () => {
    const { agent } = fakeAgent({
      "session.hello": [
        { known: false, locked: true, totpEnrolled: false, pinSet: false, dayUnlocked: false },
      ],
    });
    render(<Unlock agent={agent} startGateway={async () => ({ running: true, port: 18800 })} />);
    expect(await screen.findByText(/isn't set up for Off Manual yet/)).toBeTruthy();
  });

  it("enrols the authenticator, then asks for a PIN", async () => {
    const { agent, calls } = fakeAgent({
      "session.hello": [
        { ...base, totpEnrolled: false, pinSet: false },
        { ...base, pinSet: false },
      ],
      "auth.totpEnrolStart": [{ secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x" }],
      "auth.totpEnrolConfirm": [{ enrolled: true, recoveryCodes: ["ABCDE-FGHJK", "MNPQR-STUVW"] }],
    });
    render(<Unlock agent={agent} startGateway={async () => ({ running: true, port: 18800 })} />);
    expect(await screen.findByAltText(/QR code/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/6-digit code/), { target: { value: "12a3456" } });
    fireEvent.click(screen.getByText("Continue"));
    // Recovery codes are shown once before going on.
    expect(await screen.findByText("ABCDE-FGHJK")).toBeTruthy();
    expect(screen.getByText("MNPQR-STUVW")).toBeTruthy();
    fireEvent.click(screen.getByText("I've saved them"));
    expect(await screen.findByText(/Choose a PIN/)).toBeTruthy();
    expect(calls.find((c) => c[0] === "auth.totpEnrolConfirm")?.[1]).toEqual({ code: "123456" });
  });

  it("unlocks with a PIN after idle, and shows the agent's plain message on a wrong PIN", async () => {
    const { agent, calls } = fakeAgent({
      "session.hello": [base, { ...base, locked: false }],
      "auth.verifyPin": (p) => {
        if (p.pin === "0000")
          throw { code: -32003, message: "That PIN isn't right.", data: { remaining: 2 } };
        return { unlocked: true };
      },
    });
    render(<Unlock agent={agent} startGateway={async () => ({ running: true, port: 18800 })} />);
    const pin = await screen.findByLabelText("PIN");
    fireEvent.change(pin, { target: { value: "0000" } });
    fireEvent.click(screen.getByText("Unlock"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That PIN isn't right.");
    fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "4821" } });
    fireEvent.click(screen.getByText("Unlock"));
    expect(await screen.findByText(/You're signed in, Asha/)).toBeTruthy();
    expect(calls.filter((c) => c[0] === "auth.verifyPin")).toHaveLength(2);
  });

  it("switches to the daily code when the agent says the PIN is used up", async () => {
    const { agent } = fakeAgent({
      "session.hello": [base],
      "auth.verifyPin": () => {
        throw {
          code: -32002,
          message: "That PIN wasn't right three times. Enter today's code.",
          data: { needDailyCode: true },
        };
      },
    });
    render(<Unlock agent={agent} startGateway={async () => ({ running: true, port: 18800 })} />);
    fireEvent.change(await screen.findByLabelText("PIN"), { target: { value: "1357" } });
    fireEvent.click(screen.getByText("Unlock"));
    expect(await screen.findByText(/Enter today's code from your authenticator app/)).toBeTruthy();
  });

  it("asks for the daily code at the start of the day, and offers retry when the service is down", async () => {
    const day = fakeAgent({ "session.hello": [{ ...base, dayUnlocked: false }] });
    render(<Unlock agent={day.agent} />);
    expect(await screen.findByText(/today's code/)).toBeTruthy();
    cleanup();
    const down = fakeAgent({});
    down.agent = async () => {
      throw { code: -1, message: "Off Manual's server service isn't running. Please tell your admin." };
    };
    render(<Unlock agent={down.agent} />);
    expect(await screen.findByText(/isn't running/)).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
  });
});

describe("offboarding", () => {
  it("stops the assistant and shows a plain message when access is switched off", async () => {
    const stop = vi.fn(async () => undefined);
    const { agent } = fakeAgent({ "session.hello": [{ ...base, locked: false, status: "disabled" }] });
    render(
      <Unlock agent={agent} startGateway={async () => ({ running: true, port: 18800 })} stopGateway={stop} />,
    );
    expect(await screen.findByText(/access is switched off/)).toBeTruthy();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("checks every minute while unlocked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const stop = vi.fn(async () => undefined);
      const { agent, calls } = fakeAgent({
        "session.hello": [
          { ...base, locked: false },
          { ...base, locked: false, status: "disabled" },
        ],
      });
      render(
        <Unlock
          agent={agent}
          startGateway={async () => ({ running: true, port: 18800 })}
          stopGateway={stop}
        />,
      );
      expect(await screen.findByText(/You're signed in, Asha/)).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(await screen.findByText(/access is switched off/)).toBeTruthy();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(calls.filter((c) => c[0] === "session.hello").length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
