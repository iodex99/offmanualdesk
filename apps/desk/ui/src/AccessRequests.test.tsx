import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccessRequests, DenialCards, NOTE_PREFILL } from "./AccessRequests";

afterEach(cleanup);

const T0 = Date.parse("2026-11-23T10:00:00Z");
const folder = String.raw`\\fs01\Clients\Mehta Traders`;

describe("DenialCards", () => {
  it("shows only new, unrequested denials and sends a request with the note", async () => {
    const agent = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method === "access.denials")
        return {
          denials: [
            { id: 3, at: "2026-11-23T10:00:02Z", target: folder, requested: false },
            { id: 2, at: "2026-11-23T10:00:01Z", target: "C:\\Old\\asked", requested: true },
            { id: 1, at: "2026-11-23T09:00:00Z", target: "C:\\Old\\earlier", requested: false },
          ],
        };
      return { id: 7 };
    });
    render(<DenialCards agent={agent} since={T0} />);
    expect(await screen.findByText(folder)).toBeTruthy();
    expect(screen.queryByText("C:\\Old\\asked")).toBeNull();
    expect(screen.queryByText("C:\\Old\\earlier")).toBeNull();
    fireEvent.click(screen.getByText("Request access"));
    const box = screen.getByLabelText(/Note to your admin/) as HTMLTextAreaElement;
    expect(box.value).toBe(NOTE_PREFILL);
    fireEvent.change(box, { target: { value: "I need this for the October GST return." } });
    fireEvent.click(screen.getByText("Send request"));
    expect(await screen.findByText(/Sent to your admin/)).toBeTruthy();
    // Only the denial's id and the note go to the Server Agent; never the path.
    expect(agent).toHaveBeenCalledWith("access.request", {
      id: 3,
      note: "I need this for the October GST return.",
    });
  });

  it("shows the agent's plain message when the request fails", async () => {
    const agent = vi.fn(async (method: string) => {
      if (method === "access.denials")
        return { denials: [{ id: 3, at: "2026-11-23T10:00:02Z", target: folder, requested: false }] };
      throw { code: -32004, message: "You've already asked for access to this." };
    });
    render(<DenialCards agent={agent} since={T0} />);
    fireEvent.click(await screen.findByText("Request access"));
    fireEvent.click(screen.getByText("Send request"));
    expect(await screen.findByText("You've already asked for access to this.")).toBeTruthy();
  });

  it("shows nothing when there are no denials or the agent is down", async () => {
    const agent = vi.fn(async () => {
      throw new Error("down");
    });
    const { container } = render(<DenialCards agent={agent} since={T0} />);
    await waitFor(() => expect(agent).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});

describe("AccessRequests", () => {
  const req = {
    id: 9,
    name: "Ravi",
    target: folder,
    note: "October GST return",
    createdAt: "2026-11-23T10:00:00Z",
    status: "open",
    mine: false,
  };

  it("lets an admin close a request", async () => {
    let status = "open";
    const agent = vi.fn(async (method: string) => {
      if (method === "access.list") return { admin: true, requests: [{ ...req, status }] };
      status = "done";
      return { ok: true };
    });
    render(<AccessRequests agent={agent} />);
    expect(await screen.findByText(/Ravi:/)).toBeTruthy();
    expect(screen.getByText(/23-11-2026/)).toBeTruthy();
    fireEvent.click(screen.getByText("Done"));
    expect(await screen.findByText(/Access given/)).toBeTruthy();
    expect(agent).toHaveBeenCalledWith("access.resolve", { id: 9, outcome: "done" });
    expect(screen.queryByText("Done")).toBeNull();
  });

  it("shows an employee their own requests without admin buttons", async () => {
    const agent = vi.fn(async () => ({ admin: false, requests: [{ ...req, mine: true }] }));
    render(<AccessRequests agent={agent} />);
    expect(await screen.findByText(/Waiting/)).toBeTruthy();
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.queryByText(/Ravi:/)).toBeNull();
  });

  it("says when there are none", async () => {
    const agent = vi.fn(async () => ({ admin: false, requests: [] }));
    render(<AccessRequests agent={agent} />);
    expect(await screen.findByText("No requests.")).toBeTruthy();
  });
});
