import { describe, expect, it } from "vitest";
import { RUNKO_CORE_VERSION } from "../src/index.js";

describe("@runko/core smoke", () => {
  it("exposes a placeholder version constant", () => {
    expect(RUNKO_CORE_VERSION).toBe("0.0.0");
  });
});
