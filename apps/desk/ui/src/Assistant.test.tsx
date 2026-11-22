import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Assistant } from "./Assistant";
import { fakeGateway } from "./testGateway";

afterEach(cleanup);

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
