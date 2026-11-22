import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReportProblem } from "./ReportProblem";

afterEach(cleanup);

describe("ReportProblem", () => {
  it("shows what is sent, then sends and shows the reference", async () => {
    const agent = vi.fn(async (method: string) => {
      if (method === "support.bundle")
        return { server: { agentVersion: "1.2.0", logTail: ["listening"] }, desk: { deskVersion: "1.2.0" } };
      return { ticket: "OM-7KQ2PX" };
    });
    render(<ReportProblem agent={agent} deskInfo={async () => ({ deskVersion: "1.2.0" })} />);
    expect(screen.getByText("Send report")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByText("Show what is sent"));
    expect(await screen.findByText(/"agentVersion": "1.2.0"/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/What happened/), {
      target: { value: "  Desk froze when I opened a PDF  " },
    });
    fireEvent.click(screen.getByText("Send report"));
    expect(await screen.findByText("OM-7KQ2PX")).toBeTruthy();
    expect(agent).toHaveBeenLastCalledWith("support.submit", {
      description: "Desk froze when I opened a PDF",
      desk: { deskVersion: "1.2.0" },
    });
  });

  it("shows the plain message when sending fails and keeps the text", async () => {
    const agent = vi.fn(async () => {
      throw {
        code: -32005,
        message: "Off Manual couldn't send your report. Check the internet connection and try again.",
      };
    });
    render(<ReportProblem agent={agent} deskInfo={async () => ({})} />);
    fireEvent.change(screen.getByLabelText(/What happened/), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Send report"));
    expect(await screen.findByText(/Check the internet connection/)).toBeTruthy();
    expect(screen.getByLabelText(/What happened/)).toHaveProperty("value", "x");
  });

  it("warns not to include client details and caps the length", () => {
    render(<ReportProblem agent={vi.fn()} deskInfo={async () => ({})} />);
    expect(screen.getByText(/Don't include client names/)).toBeTruthy();
    expect(screen.getByLabelText(/What happened/)).toHaveProperty("maxLength", 500);
  });
});
