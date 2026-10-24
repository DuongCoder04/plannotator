import { describe, expect, it } from "bun:test";
import { fromWebviewHost, type MessageWindow } from "./host-messages";

describe("which messages the webview acts on", () => {
  // top (VS Code) → host frame → this page → the answer frame → a frame inside it
  const top: MessageWindow = { get parent() { return top; } };
  const hostFrame: MessageWindow = { parent: top };
  const self: MessageWindow = { parent: hostFrame };
  const answerFrame: MessageWindow = { parent: self };
  const nested: MessageWindow = { parent: answerFrame };
  const origin = "vscode-webview://1a2b3c";

  it("the webview host's, from the parent window", () => {
    expect(fromWebviewHost({ source: hostFrame, origin }, self)).toBe(true);
  });

  it("a host message whose source is not the parent but carries the webview's origin (VS Code for the Web)", () => {
    const otherHostWindow: MessageWindow = { parent: top };
    expect(fromWebviewHost({ source: otherHostWindow, origin }, self)).toBe(true);
    expect(fromWebviewHost({ source: top, origin }, self)).toBe(true);
    expect(fromWebviewHost({ source: null, origin }, self)).toBe(true);
  });

  it("never the answer frame or anything nested in it, whatever origin it claims", () => {
    for (const source of [answerFrame, nested]) {
      expect(fromWebviewHost({ source, origin: "null" }, self)).toBe(false);
      expect(fromWebviewHost({ source, origin }, self)).toBe(false);
    }
  });

  it("an opaque origin only from the parent or the page itself (a harness page on about:blank or file://)", () => {
    expect(fromWebviewHost({ source: self, origin: "null" }, self)).toBe(true);
    expect(fromWebviewHost({ source: hostFrame, origin: "null" }, self)).toBe(true);
    expect(fromWebviewHost({ source: { parent: top }, origin: "null" }, self)).toBe(false);
    expect(fromWebviewHost({ source: null, origin: "null" }, self)).toBe(false);
  });
});
