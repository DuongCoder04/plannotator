/**
 * The sentence the code-nav preview shows for a refused file must be true.
 * A file just over the 5 MB cap rounds to "5 MB", which once read
 * "too large to preview (5 MB; the limit is 5 MB)".
 */
import { describe, expect, test } from "bun:test";
import { codeNavPreviewErrorMessage } from "./useCodeNavPreview";

const LIMIT = 5 * 1024 * 1024;

describe("codeNavPreviewErrorMessage too-large", () => {
  test("a file one byte over the limit does not claim to be the limit's size", () => {
    const message = codeNavPreviewErrorMessage({ reason: "too-large", size: LIMIT + 1, maxBytes: LIMIT });
    expect(message).toBe("This file is too large to preview (just over the 5 MB limit).");
  });

  test("a clearly larger file shows both sizes", () => {
    const message = codeNavPreviewErrorMessage({ reason: "too-large", size: 6 * 1024 * 1024, maxBytes: LIMIT });
    expect(message).toBe("This file is too large to preview (6 MB; the limit is 5 MB).");
  });
});
