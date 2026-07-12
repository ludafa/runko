import { describe, expect, it } from "vitest";
import { NIMBO_CORE_VERSION } from "../src/index.js";

describe("@nimbo/core smoke", () => {
  it("exposes a placeholder version constant", () => {
    expect(NIMBO_CORE_VERSION).toBe("0.0.0");
  });
});
