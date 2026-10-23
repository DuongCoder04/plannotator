import { describe, expect, it } from "bun:test";
import { fromWebviewHost } from "./host-messages";

describe("which messages the webview acts on", () => {
  const parent = { name: "host" } as unknown as Window;
  const self = { parent } as Pick<Window, "parent">;
  it("the webview host's, and nothing from a child frame or an opaque origin", () => {
    expect(fromWebviewHost({ source: parent }, self)).toBe(true);
    const childFrame = { name: "answer frame" } as unknown as Window;
    expect(fromWebviewHost({ source: childFrame }, self)).toBe(false);
    expect(fromWebviewHost({ source: childFrame }, self)).toBe(false);
    expect(fromWebviewHost({ source: null }, self)).toBe(false);
  });
});
