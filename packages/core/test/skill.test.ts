import { describe, expect, expectTypeOf, it } from "vitest";
import { defineSkill } from "../src/skill.js";
import type { Skill } from "../src/skill.js";

describe("defineSkill", () => {
  it("is an identity function (returns the same reference)", () => {
    const def: Skill = { name: "pdf-fill", description: "fills PDF forms", markdown: "# PDF Fill\n..." };
    expect(defineSkill(def)).toBe(def);
  });

  it("accepts optional files (string or binary content)", () => {
    const def = defineSkill({
      name: "pdf-fill",
      description: "fills PDF forms",
      markdown: "# PDF Fill",
      files: { "template.pdf": new Uint8Array([1, 2, 3]), "notes.txt": "see template" },
    });

    expect(def.files?.["notes.txt"]).toBe("see template");
    expect(def.files?.["template.pdf"]).toBeInstanceOf(Uint8Array);
  });

  it("omits files when not supplied", () => {
    const def = defineSkill({ name: "x", description: "y", markdown: "z" });
    expect(def.files).toBeUndefined();
  });

  it("rejects a definition missing the required name field at the type level", () => {
    expectTypeOf<{ description: string; markdown: string }>().not.toExtend<Skill>();
  });

  it("also requires description and markdown, not just name", () => {
    expectTypeOf<{ name: string }>().not.toExtend<Skill>();
    expectTypeOf<{ name: string; description: string }>().not.toExtend<Skill>();
  });
});
