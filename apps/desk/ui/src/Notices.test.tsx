import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Notices } from "./Notices";

afterEach(cleanup);

const n1 = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "billing",
  title: "Invoice issued",
  body: "Due on 16-12-2026.",
};
const n2 = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "update",
  title: "Maintenance tonight",
  body: "At 22:00 IST.",
};

describe("Notices", () => {
  it("lists notices and dismisses one", async () => {
    const agent = vi.fn(async (method: string) =>
      method === "notices.list" ? { notices: [n1, n2] } : { ok: true },
    );
    render(<Notices agent={agent} />);
    expect(await screen.findByText("Invoice issued")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dismiss: Invoice issued"));
    await waitFor(() => expect(screen.queryByText("Invoice issued")).toBeNull());
    expect(screen.getByText("Maintenance tonight")).toBeTruthy();
    expect(agent).toHaveBeenCalledWith("notices.ack", { id: n1.id });
  });

  it("shows nothing when there are none or the agent can't be asked", async () => {
    const agent = vi.fn(async () => {
      throw new Error("down");
    });
    const { container } = render(<Notices agent={agent} />);
    await waitFor(() => expect(agent).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
