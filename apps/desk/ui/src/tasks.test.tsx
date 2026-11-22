import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Assistant } from "./Assistant";
import { fileSafe, missingInputs, monthLabel, recentFYs, TASKS } from "./tasks";
import { fakeGateway } from "./testGateway";

afterEach(cleanup);

const task = (id: string) => TASKS.find((t) => t.id === id)!;

describe("task definitions", () => {
  it("name the skill and the SKILLS.md output file", () => {
    expect(
      task("gstr2b").prompt({ client: "Mehta Traders", month: "2026-11", fy: "", period: "", file: "" }),
    ).toBe(
      "Use the gstr2b-vs-books skill for Mehta Traders for Nov-2026. Save it as GSTR2B_vs_Books_Mehta_Traders_2026-11.xlsx in the client's folder and tell me where it is.",
    );
    expect(
      task("ais-26as").prompt({ client: "A & B", month: "", fy: "FY2025-26", period: "", file: "" }),
    ).toContain("TDS_Credit_Reco_A_&_B_FY2025-26.xlsx");
    expect(
      task("missing-docs").prompt({ client: "", month: "", fy: "", period: "Q3-FY2026-27", file: "" }),
    ).toContain("Don't contact any client.");
    expect(
      task("notice").prompt({ client: "Mehta", month: "", fy: "", period: "", file: "C:\\n.pdf" }),
    ).toContain("Don't send or file anything.");
  });

  it("helpers", () => {
    expect(monthLabel("2026-01")).toBe("Jan-2026");
    expect(monthLabel("bad")).toBe("bad");
    expect(fileSafe("  Mehta  Traders/Pvt.  ")).toBe("Mehta_Traders_Pvt");
    expect(recentFYs(new Date("2026-11-23T00:00:00Z"))).toEqual(["FY2026-27", "FY2025-26", "FY2024-25"]);
    expect(missingInputs(task("mis"), { client: "x" })).toEqual(["month"]);
    expect(missingInputs(task("due-week"), {})).toEqual([]);
  });
});

describe("Tasks tab", () => {
  it("asks for inputs, then sends one request in the chat", async () => {
    const g = fakeGateway();
    render(
      <Assistant
        start={async () => ({ running: true, port: 18800 })}
        api={g.api}
        agent={vi.fn().mockResolvedValue({})}
        control={{ stop: async () => undefined, status: async () => ({ running: true, port: 18800 }) }}
      />,
    );
    fireEvent.click(await screen.findByText("Tasks"));
    fireEvent.click(screen.getByText("Month-end MIS"));
    fireEvent.click(screen.getByText("Start"));
    expect(await screen.findByText("Please fill in: client, month.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Client/), { target: { value: "Mehta Traders" } });
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2026-10" } });
    fireEvent.click(screen.getByText("Start"));
    expect(await screen.findByText(/Use the tally-mis skill for Mehta Traders for Oct-2026/)).toBeTruthy();
    expect(g.sent).toEqual([
      "Use the tally-mis skill for Mehta Traders for Oct-2026. Save it as MIS_Mehta_Traders_2026-10.xlsx in the client's folder and tell me where it is.",
    ]);
  });
});
