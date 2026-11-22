import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Chat, MSG_FAILED } from "./Chat";
import { fakeGateway } from "./testGateway";

afterEach(cleanup);

const ev = (
  runId: string,
  state: "delta" | "final" | "aborted" | "error",
  deltaText = "",
  replace = false,
) => ({
  runId,
  state,
  deltaText,
  replace,
  errorMessage: "",
});

async function type(text: string) {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  fireEvent.click(screen.getByText("Send"));
}

describe("Chat", () => {
  it("sends, streams the reply, then lets you send again", async () => {
    const g = fakeGateway();
    render(<Chat api={g.api} />);
    await type("Which clients are pending?");
    expect(await screen.findByText("Which clients are pending?")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Stop")).toBeTruthy());
    act(() => {
      g.emit(ev("run-1", "delta", "42 clients "));
      g.emit(ev("run-1", "delta", "are pending."));
      g.emit(ev("other-run", "delta", "not mine"));
      g.emit(ev("run-1", "final"));
    });
    expect(screen.getByText("42 clients are pending.")).toBeTruthy();
    expect(screen.queryByText(/not mine/)).toBeNull();
    expect(screen.getByText("Send")).toBeTruthy();
    expect(g.sent).toEqual(["Which clients are pending?"]);
  });

  it("keeps events that arrive before the run id and honours replace", async () => {
    const g = fakeGateway();
    g.state.eventsDuringSend = [
      { state: "delta", deltaText: "draft", replace: false, errorMessage: "" },
      { state: "delta", deltaText: "Final answer", replace: true, errorMessage: "" },
      { state: "final", deltaText: "", replace: false, errorMessage: "" },
    ];
    render(<Chat api={g.api} />);
    await type("hi");
    expect(await screen.findByText("Final answer")).toBeTruthy();
    expect(screen.queryByText(/draft/)).toBeNull();
  });

  it("stop aborts the run; errors are plain", async () => {
    const g = fakeGateway();
    render(<Chat api={g.api} />);
    await type("long task");
    fireEvent.click(await screen.findByText("Stop"));
    expect(g.aborted).toEqual(["run-1"]);
    act(() => g.emit(ev("run-1", "aborted")));
    expect(screen.getByText("Stopped.")).toBeTruthy();
    await type("again");
    await screen.findByText("Stop");
    act(() => g.emit({ ...ev("run-2", "error"), errorMessage: "provider 500: stack" }));
    expect(screen.getByText(MSG_FAILED)).toBeTruthy();
    expect(screen.queryByText(/stack/)).toBeNull();
  });

  it("shows the plain message when sending fails", async () => {
    const g = fakeGateway();
    g.state.sendError = { message: "Your assistant isn't running. Start it and try again." };
    render(<Chat api={g.api} />);
    await type("hi");
    expect(await screen.findByText(/isn't running/)).toBeTruthy();
    expect(screen.getByText("Send")).toBeTruthy();
  });
});
