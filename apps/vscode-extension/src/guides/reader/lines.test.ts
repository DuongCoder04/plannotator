import { describe, expect, it } from "bun:test";
import { askLines, findDiffLine } from "./lines";

describe("which lines a selection in the Guide tab asks about", () => {
  it("added or unchanged lines are the new version's, removed lines the old version's", () => {
    expect(askLines({ start: 25, end: 31, side: "additions" })).toEqual({ side: "new", start: 25, end: 31 });
    expect(askLines({ start: 25, end: 31 })).toEqual({ side: "new", start: 25, end: 31 });
    expect(askLines({ start: 12, end: 9, side: "deletions", endSide: "deletions" })).toEqual({ side: "old", start: 9, end: 12 });
  });

  it("a selection across removed and added lines is not asked", () => {
    expect(askLines({ start: 12, end: 23, side: "deletions", endSide: "additions" })).toBeNull();
    expect(askLines({ start: 20, end: 13, side: "additions", endSide: "deletions" })).toBeNull();
  });
});

describe.skipIf(typeof document === "undefined")("the row of a line, for a jump to it", () => {
  it("finds a changed row by its own side's number and an unchanged row by either number, through shadow roots", () => {
    const shell = document.createElement("div");
    const host = document.createElement("div");
    shell.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = [
      '<div data-line="9" data-line-type="change-deletion"></div>',
      '<div data-line="20" data-line-type="change-addition"></div>',
      '<div data-line="21" data-alt-line="10" data-line-type="context"></div>',
      '<div data-line="9" data-alt-line="9" data-line-type="context"></div>',
    ].join("");
    expect(findDiffLine(shell, "old", 9)?.getAttribute("data-line-type")).toBe("change-deletion");
    expect(findDiffLine(shell, "new", 20)?.getAttribute("data-line-type")).toBe("change-addition");
    expect(findDiffLine(shell, "new", 21)?.getAttribute("data-alt-line")).toBe("10");
    expect(findDiffLine(shell, "old", 10)?.getAttribute("data-line")).toBe("21");
    expect(findDiffLine(shell, "new", 99)).toBeNull();
  });
});
