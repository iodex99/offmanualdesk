import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Review } from "./Review";
import { fakeGateway } from "./testGateway";
import type { ReviewItem } from "./gatewayApi";

afterEach(cleanup);

const del = (id: string, paths: string[]): ReviewItem => ({
  id,
  kind: "delete_files",
  params: { paths, reason: "duplicates" },
  summary: `Delete ${paths.length} files. Reason: duplicates`,
  status: "pending",
  createdAt: "2026-11-23T06:00:00.000Z",
});

describe("Review", () => {
  it("says when nothing is waiting", async () => {
    render(<Review api={fakeGateway().api} />);
    expect(await screen.findByText("Nothing is waiting for your approval.")).toBeTruthy();
  });

  it("approves one item and shows the result", async () => {
    const g = fakeGateway({ items: [del("1", ["C:\\A\\x.pdf"])] });
    render(<Review api={g.api} />);
    expect(await screen.findByText(/1 item is waiting/)).toBeTruthy();
    expect(screen.getByText("Asked on 23-11-2026")).toBeTruthy();
    fireEvent.click(screen.getByText("Approve"));
    expect(await screen.findByText("#1: #1 approved")).toBeTruthy();
    expect(g.decisions).toEqual([{ ids: ["1"], decision: "approve" }]);
    expect(await screen.findByText("Nothing is waiting for your approval.")).toBeTruthy();
  });

  it("approve all and reject", async () => {
    const g = fakeGateway({ items: [del("1", ["C:\\a"]), del("2", ["C:\\b"]), del("3", ["C:\\c"])] });
    render(<Review api={g.api} />);
    fireEvent.click((await screen.findAllByText("Reject"))[2] as HTMLElement);
    expect(await screen.findByText(/2 items are waiting/)).toBeTruthy();
    fireEvent.click(screen.getByText("Approve all"));
    expect(await screen.findByText("Nothing is waiting for your approval.")).toBeTruthy();
    expect(g.decisions).toEqual([
      { ids: ["3"], decision: "reject" },
      { ids: ["1", "2"], decision: "approve" },
    ]);
  });

  it("edit sends only the ticked files", async () => {
    const g = fakeGateway({ items: [del("4", ["C:\\A\\keep.pdf", "C:\\A\\drop.pdf"])] });
    render(<Review api={g.api} />);
    fireEvent.click(await screen.findByText("Edit"));
    fireEvent.click(screen.getByLabelText("C:\\A\\keep.pdf"));
    fireEvent.click(screen.getByText("Approve ticked files"));
    await screen.findByText("Nothing is waiting for your approval.");
    expect(g.decisions).toEqual([
      { ids: ["4"], decision: "approve", params: { paths: ["C:\\A\\drop.pdf"], reason: "duplicates" } },
    ]);
  });

  it("shows a plain error and retries", async () => {
    const g = fakeGateway();
    g.state.listError = { message: "Your assistant isn't running. Start it and try again." };
    render(<Review api={g.api} />);
    expect(await screen.findByText(/isn't running/)).toBeTruthy();
    g.state.listError = null;
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("Nothing is waiting for your approval.")).toBeTruthy();
  });
});
