import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Assistant } from "./Assistant";
import { fakeGateway } from "./testGateway";

afterEach(cleanup);

const MEHTA = String.raw`C:\Clients\Mehta`;

describe("Assistant", () => {
  it("shows starting, then ready", async () => {
    render(
      <Assistant start={() => Promise.resolve({ running: true, port: 18800 })} api={fakeGateway().api} />,
    );
    expect(screen.getByText(/Starting your assistant/)).toBeTruthy();
    expect(await screen.findByText("Your assistant is ready.")).toBeTruthy();
  });

  it("shows the plain message from Rust and retries", async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce({
        message: "The assistant isn't installed on this server yet. Please tell your admin.",
      })
      .mockResolvedValueOnce({ running: true, port: 18800 });
    render(<Assistant start={start} api={fakeGateway().api} />);
    expect(await screen.findByText(/isn't installed on this server yet/)).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("Your assistant is ready.")).toBeTruthy();
    expect(start).toHaveBeenCalledTimes(2);
  });
});

describe("Assistant keeper", () => {
  it("rests after the firm's idle hours and starts again when a message is sent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const start = vi.fn().mockResolvedValue({ running: true, port: 18800 });
      const stop = vi.fn().mockResolvedValue(undefined);
      const status = vi.fn().mockResolvedValue({ running: true, port: 18800 });
      const agent = vi.fn().mockResolvedValue({ gatewayIdleStopHours: 1 });
      const g = fakeGateway();
      render(<Assistant start={start} api={g.api} agent={agent} control={{ stop, status }} />);
      expect(await screen.findByText("Your assistant is ready.")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_600_000 + 30_000);
      });
      expect(await screen.findByText(/resting to save memory/)).toBeTruthy();
      expect(stop).toHaveBeenCalledTimes(1);
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
      fireEvent.click(screen.getByText("Send"));
      expect(await screen.findByText("Your assistant is ready.")).toBeTruthy();
      expect(start).toHaveBeenCalledTimes(2);
      expect(g.sent).toEqual(["hi"]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("after a reply, offers Request access for a folder the assistant was refused (ADR-058)", async () => {
    const g = fakeGateway();
    g.state.eventsDuringSend = [{ state: "final", deltaText: "", replace: false, errorMessage: "" }];
    const agent = vi.fn(async (method: string) => {
      if (method === "access.denials")
        return {
          denials: [{ id: 4, at: new Date().toISOString(), target: MEHTA, requested: false }],
        };
      return {};
    });
    render(
      <Assistant start={() => Promise.resolve({ running: true, port: 18800 })} api={g.api} agent={agent} />,
    );
    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "Open Mehta's ledger" } });
    fireEvent.click(screen.getByText("Send"));
    expect(await screen.findByText("Request access")).toBeTruthy();
    expect(screen.getByText(MEHTA)).toBeTruthy();
  });
  it('puts an Explorer "Ask Off Manual" path in the chat box, now and on later signals (ADR-059)', async () => {
    let queue: { kind: "ask"; path: string }[] = [{ kind: "ask", path: MEHTA }];
    let signal: () => void = () => undefined;
    const inbox = {
      take: vi.fn(async () => {
        const q = queue;
        queue = [];
        return q;
      }),
      onSignal: vi.fn(async (cb: () => void) => {
        signal = cb;
        return () => undefined;
      }),
    };
    render(
      <Assistant
        start={() => Promise.resolve({ running: true, port: 18800 })}
        api={fakeGateway().api}
        agent={vi.fn(async () => ({}))}
        inbox={inbox}
      />,
    );
    const box = (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
    await vi.waitFor(() => expect(box.value).toBe(`About ${MEHTA}: `));
    fireEvent.click(screen.getByText("Review"));
    queue = [{ kind: "ask", path: String.raw`\\fs01\Clients\Shah` }];
    await act(async () => signal());
    const box2 = (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
    await vi.waitFor(() => expect(box2.value).toBe(String.raw`About \\fs01\Clients\Shah: `));
  });
});
