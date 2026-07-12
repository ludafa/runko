import { describe, expect, it } from "vitest";
import { DEFAULT_MIME_TYPE, inferMimeType } from "../src/mime.js";

describe("inferMimeType", () => {
  it("infers well-known extensions", () => {
    expect(inferMimeType("/a.md")).toBe("text/markdown");
    expect(inferMimeType("/nested/dir/app.json")).toBe("application/json");
    expect(inferMimeType("/image.png")).toBe("image/png");
  });

  it("is case-insensitive on the extension", () => {
    expect(inferMimeType("/A.MD")).toBe("text/markdown");
  });

  it("falls back to the default mime type for unknown extensions", () => {
    expect(inferMimeType("/a.totally-unknown-ext")).toBe(DEFAULT_MIME_TYPE);
  });

  it("falls back to the default mime type for extensionless files", () => {
    expect(inferMimeType("/Makefile")).toBe(DEFAULT_MIME_TYPE);
  });

  it("treats a dotfile with no further extension as extensionless", () => {
    expect(inferMimeType("/.gitignore")).toBe(DEFAULT_MIME_TYPE);
  });
});
