/**
 * P5 skills：三加载器（`Skill.fromDirectory`/`fromFS`/`fromMarkdown`）+
 * registry 三件事（`buildAvailableSkillsBlock`/`createGetSkill`/
 * `mountSkillFiles`）。Session-level 接线（system prompt 注入、`load_skill`
 * 条件内置、挂载后 fs 可读、`getSkill` 端到端）在 `test/load-skill.test.ts`。
 *
 * `@nimbo/virtual-fs`（devDependency，非运行时依赖，同 `test/integration.test.ts`
 * 先例）用来构造 `Skill.fromFS` 的输入 FS——不需要为此手搓一个 `NimboFS` 假实现。
 */
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromMemory } from "@nimbo/virtual-fs";
import { defineSkill, Skill } from "../src/skill.js";
import { buildAvailableSkillsBlock, createGetSkill, mountSkillFiles, skillMountPath } from "../src/skills/registry.js";
import type { NimboFS } from "../src/types.js";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "skills");

describe("Skill.fromDirectory (packaged, real disk)", () => {
  it("loads the pdf-fill fixture unchanged: name/description/markdown/files all correct", async () => {
    const skill = await Skill.fromDirectory(join(FIXTURES_DIR, "pdf-fill"));

    expect(skill.name).toBe("pdf-fill");
    expect(skill.description).toBe(
      "Fill PDF form fields programmatically using pdftk or an equivalent library, given a template PDF and a set of field values.",
    );
    expect(skill.markdown).toContain("# PDF Fill");
    expect(skill.markdown).not.toContain("---\nname: pdf-fill"); // frontmatter block stripped
    expect(skill.markdown).not.toContain("description:"); // frontmatter fully gone, not just the delimiter lines

    expect(Object.keys(skill.files ?? {})).toEqual(["reference.md"]);
    const referenceContent = skill.files?.["reference.md"];
    expect(referenceContent).toBeInstanceOf(Uint8Array);
    const decoded = referenceContent instanceof Uint8Array ? new TextDecoder().decode(referenceContent) : "";
    expect(decoded).toContain("full_name");
  });

  it("rejects with a guidance error when SKILL.md is missing the required description frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nimbo-skill-"));
    try {
      await writeFile(join(dir, "SKILL.md"), "---\nname: broken\n---\n\n# Broken\n");
      await expect(Skill.fromDirectory(dir)).rejects.toThrow(/description/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects with a guidance error when the directory has no SKILL.md at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nimbo-skill-"));
    try {
      await expect(Skill.fromDirectory(dir)).rejects.toThrow(/SKILL\.md/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recurses into subdirectories for attached files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nimbo-skill-"));
    try {
      await writeFile(join(dir, "SKILL.md"), "---\ndescription: nested files test\n---\n\nbody\n");
      await mkdir(join(dir, "scripts"));
      await writeFile(join(dir, "scripts", "run.py"), "print('hi')\n");

      const skill = await Skill.fromDirectory(dir);
      expect(Object.keys(skill.files ?? {})).toEqual(["scripts/run.py"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Skill.fromFS (packaged, on NimboFS)", () => {
  it("loads the same pdf-fill content, byte for byte, over a MemoryFS", async () => {
    const skillMd = await readFile(join(FIXTURES_DIR, "pdf-fill", "SKILL.md"), "utf8");
    const referenceMd = await readFile(join(FIXTURES_DIR, "pdf-fill", "reference.md"), "utf8");
    const fs = fromMemory({
      "/skills/pdf-fill/SKILL.md": skillMd,
      "/skills/pdf-fill/reference.md": referenceMd,
    });

    const skill = await Skill.fromFS(fs, "/skills/pdf-fill");

    expect(skill.name).toBe("pdf-fill");
    expect(skill.description).toContain("Fill PDF form fields");
    expect(skill.markdown).toContain("# PDF Fill");
    const referenceContent = skill.files?.["reference.md"];
    const decoded = referenceContent instanceof Uint8Array ? new TextDecoder().decode(referenceContent) : "";
    expect(decoded).toBe(referenceMd);
  });

  it("rejects with a guidance error when the description frontmatter is missing", async () => {
    const fs = fromMemory({ "/skills/broken/SKILL.md": "---\nname: broken\n---\n\nbody\n" });
    await expect(Skill.fromFS(fs, "/skills/broken")).rejects.toThrow(/description/i);
  });

  it("rejects with a guidance error when SKILL.md does not exist on the FS", async () => {
    const fs = fromMemory({});
    await expect(Skill.fromFS(fs, "/skills/missing")).rejects.toThrow(/SKILL\.md/);
  });

  it("recurses into subdirectories for attached files, same as fromDirectory", async () => {
    const fs = fromMemory({
      "/skills/nested/SKILL.md": "---\ndescription: nested files over NimboFS\n---\n\nbody\n",
      "/skills/nested/scripts/run.py": "print('hi')",
    });
    const skill = await Skill.fromFS(fs, "/skills/nested");
    expect(Object.keys(skill.files ?? {})).toEqual(["scripts/run.py"]);
  });
});

describe("Skill.fromMarkdown (flat, eve form)", () => {
  it("loads the commit-helper fixture unchanged: description derived from the first line, markdown untouched", async () => {
    const raw = await readFile(join(FIXTURES_DIR, "commit-helper.md"), "utf8");
    const skill = Skill.fromMarkdown("commit-helper", raw);

    expect(skill.name).toBe("commit-helper");
    expect(skill.description).toBe(
      "Writes a Conventional Commits message summarizing a git diff in one imperative-mood sentence.",
    );
    expect(skill.markdown).toBe(raw);
    expect(skill.files).toBeUndefined();
  });

  it("skips a leading fenced code block when deriving the description", () => {
    const md = ["```txt", "example command output", "```", "", "Runs diagnostic commands and summarizes results for triage.", "", "## Usage"].join(
      "\n",
    );
    const skill = Skill.fromMarkdown("diagnostics", md);
    expect(skill.description).toBe("Runs diagnostic commands and summarizes results for triage.");
  });

  it("uses the frontmatter description when present, and strips the frontmatter block from markdown", () => {
    const md = "---\ndescription: explicit description wins\n---\n\n# Heading\n\nbody text\n";
    const skill = Skill.fromMarkdown("with-frontmatter", md);
    expect(skill.description).toBe("explicit description wins");
    expect(skill.markdown).toBe("\n# Heading\n\nbody text\n");
  });

  it("falls back to first-line derivation when frontmatter is present but has no description field", () => {
    const md = "---\nname: no-description\n---\n\nFirst real line becomes the description.\n";
    const skill = Skill.fromMarkdown("no-description", md);
    expect(skill.description).toBe("First real line becomes the description.");
  });

  it("strips optional surrounding quotes (single or double) off a frontmatter value", () => {
    const doubleQuoted = Skill.fromMarkdown("q1", '---\ndescription: "quoted with double quotes"\n---\n\nbody\n');
    expect(doubleQuoted.description).toBe("quoted with double quotes");

    const singleQuoted = Skill.fromMarkdown("q2", "---\ndescription: 'quoted with single quotes'\n---\n\nbody\n");
    expect(singleQuoted.description).toBe("quoted with single quotes");

    const unquoted = Skill.fromMarkdown("q3", "---\ndescription: no quotes here\n---\n\nbody\n");
    expect(unquoted.description).toBe("no quotes here");
  });

  it("returns an empty description when the whole markdown is empty or fenced code only", () => {
    expect(Skill.fromMarkdown("empty", "").description).toBe("");
    expect(Skill.fromMarkdown("only-code", "```\njust code\n```").description).toBe("");
  });
});

describe("buildAvailableSkillsBlock", () => {
  it("returns undefined for an empty skills list", () => {
    expect(buildAvailableSkillsBlock([])).toBeUndefined();
  });

  it("renders one 'name: description' line per skill inside <available_skills>", () => {
    const skills = [
      defineSkill({ name: "pdf-fill", description: "fills PDF forms", markdown: "m1" }),
      defineSkill({ name: "commit-helper", description: "writes commit messages", markdown: "m2" }),
    ];
    expect(buildAvailableSkillsBlock(skills)).toBe(
      "<available_skills>\npdf-fill: fills PDF forms\ncommit-helper: writes commit messages\n</available_skills>",
    );
  });
});

describe("skillMountPath", () => {
  it("builds the /.skills/<name>/ convention path, with and without a relative file path", () => {
    expect(skillMountPath("pdf-fill")).toBe("/.skills/pdf-fill");
    expect(skillMountPath("pdf-fill", "reference.md")).toBe("/.skills/pdf-fill/reference.md");
  });
});

describe("createGetSkill", () => {
  it("resolves text() for a string-backed attached file", async () => {
    const skills = [defineSkill({ name: "s", description: "d", markdown: "m", files: { "notes.txt": "hello" } })];
    const getSkill = createGetSkill(skills);
    await expect(getSkill("s").file("notes.txt").text()).resolves.toBe("hello");
  });

  it("resolves text() for a Uint8Array-backed attached file (decoded as UTF-8)", async () => {
    const skills = [defineSkill({ name: "s", description: "d", markdown: "m", files: { "notes.txt": new TextEncoder().encode("bytes hi") } })];
    const getSkill = createGetSkill(skills);
    await expect(getSkill("s").file("notes.txt").text()).resolves.toBe("bytes hi");
  });

  it("rejects with a guidance error (listing available skills) for an unknown skill name", async () => {
    const skills = [defineSkill({ name: "s", description: "d", markdown: "m" })];
    const getSkill = createGetSkill(skills);
    await expect(getSkill("unknown").file("x.txt").text()).rejects.toThrow(/Available skills: s/);
  });

  it("rejects with a guidance error (listing available files) for an unknown file path within a known skill", async () => {
    const skills = [defineSkill({ name: "s", description: "d", markdown: "m", files: { "a.txt": "1" } })];
    const getSkill = createGetSkill(skills);
    await expect(getSkill("s").file("missing.txt").text()).rejects.toThrow(/attached files: a\.txt/);
  });

  it("does not throw synchronously from getSkill(name) or .file(relPath) — only .text() rejects", () => {
    const getSkill = createGetSkill([]);
    expect(() => getSkill("unknown").file("x")).not.toThrow();
  });

  it("lists '(none configured)' when there are zero skills at all", async () => {
    const getSkill = createGetSkill([]);
    await expect(getSkill("unknown").file("x").text()).rejects.toThrow(/\(none configured\)/);
  });
});

describe("mountSkillFiles", () => {
  it("writes every attached file under /.skills/<name>/ on the given FS", async () => {
    const fs = fromMemory({});
    const skills = [
      defineSkill({ name: "pdf-fill", description: "d", markdown: "m", files: { "reference.md": "field docs", "scripts/run.py": "print(1)" } }),
      defineSkill({ name: "no-files", description: "d2", markdown: "m2" }),
    ];

    await mountSkillFiles(fs, skills);

    expect(new TextDecoder().decode(await fs.readFile("/.skills/pdf-fill/reference.md"))).toBe("field docs");
    expect(new TextDecoder().decode(await fs.readFile("/.skills/pdf-fill/scripts/run.py"))).toBe("print(1)");
  });

  it("is a no-op (never touches the FS) when no skill declares files", async () => {
    const calls: string[] = [];
    const fs: NimboFS = {
      readFile: async () => new Uint8Array(),
      writeFile: async (path) => {
        calls.push(path);
      },
      rm: async () => {},
      mkdir: async () => {},
      readdir: async () => [],
      stat: async () => ({ type: "file" }),
      glob: async () => [],
    };
    await mountSkillFiles(fs, [defineSkill({ name: "s", description: "d", markdown: "m" })]);
    expect(calls).toEqual([]);
  });

  it("wraps a write failure with skill name + target path context, preserving the underlying guidance", async () => {
    const failingFs: NimboFS = {
      readFile: async () => new Uint8Array(),
      writeFile: async () => {
        throw new Error("disk is full");
      },
      rm: async () => {},
      mkdir: async () => {},
      readdir: async () => [],
      stat: async () => ({ type: "file" }),
      glob: async () => [],
    };
    const skills = [defineSkill({ name: "pdf-fill", description: "d", markdown: "m", files: { "a.txt": "x" } })];

    await expect(mountSkillFiles(failingFs, skills)).rejects.toThrow(/pdf-fill/);
    await expect(mountSkillFiles(failingFs, skills)).rejects.toThrow(/disk is full/);
  });
});
