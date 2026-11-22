import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TelegramLink } from "./TelegramLink";

vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64,AAAA" } }));
afterEach(cleanup);

describe("TelegramLink", () => {
  it("shows a QR code and the link", async () => {
    const agent = vi
      .fn()
      .mockResolvedValue({ url: "https://t.me/FirmBot?start=ABCD2345", expiresInMinutes: "10" });
    render(<TelegramLink agent={agent} />);
    fireEvent.click(screen.getByText("Link Telegram"));
    expect(await screen.findByAltText("QR code for the Telegram link")).toBeTruthy();
    expect(screen.getByText("https://t.me/FirmBot?start=ABCD2345")).toBeTruthy();
    expect(agent).toHaveBeenCalledWith("telegram.linkStart");
  });

  it("shows the server's plain message", async () => {
    const agent = vi
      .fn()
      .mockRejectedValue({ code: 409, message: "Telegram isn't set up for your firm yet. Ask your admin." });
    render(<TelegramLink agent={agent} />);
    fireEvent.click(screen.getByText("Link Telegram"));
    expect(await screen.findByText(/isn't set up for your firm yet/)).toBeTruthy();
  });

  it("refuses a link that isn't a Telegram link", async () => {
    const agent = vi.fn().mockResolvedValue({ url: "https://evil.example/x" });
    render(<TelegramLink agent={agent} />);
    fireEvent.click(screen.getByText("Link Telegram"));
    expect(await screen.findByText("Unexpected reply from the server.")).toBeTruthy();
  });
});
