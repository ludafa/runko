/**
 * 03-skills — SKILL.md loading and progressive disclosure
 * (docs/tech/core-sdk.md §4.6): a skill's name+description is injected into
 * the system prompt up front; the full markdown body only reaches the model
 * when it calls the built-in `load-skill` tool. Both the flat (`skills/*.md`)
 * and packaged (`skills/<name>/SKILL.md` + attachments) forms from the Claude
 * skills / eve ecosystem are supported unmodified.
 *
 * Demonstrates: Skill.fromMarkdown, Skill.fromFS, buildAvailableSkillsBlock,
 * defineAgent({ skills }), the `load-skill` built-in tool.
 *
 * Run: `node examples/03-skills.ts` (see examples/README.md for setup).
 *
 * Expected output shape:
 *   1. A deterministic section (no model, no env vars needed): builds one
 *      flat skill and one packaged skill (the packaged one loaded from an
 *      in-memory NimboFS via Skill.fromFS, proving packaged skills don't
 *      require real disk), then prints the `<available_skills>` block nimbo
 *      injects into the system prompt — just name + description, not the
 *      full markdown (progressive disclosure).
 *   2. If NIMBO_MODEL is set: the agent is asked a question that should make
 *      it call `load-skill`, and the transcript's tool_call items are
 *      printed. If NIMBO_MODEL is unset, this section is skipped with a
 *      clean exit.
 */
import { buildAvailableSkillsBlock, createSession, defineAgent, NimboFS, Skill } from "@nimbo/sdk";
import { resolveModel } from "./shared/model.ts";

const FLAT_SKILL_MARKDOWN = `---
description: Style rules for writing commit messages in this repo.
---
Use Conventional Commits (feat/fix/chore/docs/refactor). One imperative-mood
summary line under 72 chars, blank line, then the "why" in the body.
`;

const PACKAGED_SKILL_MD = `---
description: Checklist for reviewing a pull request before approval.
---
Walk the checklist in checklist.md before approving. Read it with
\`read-file "/.skills/pr-review/checklist.md"\` once this skill is loaded.
`;

const PACKAGED_SKILL_CHECKLIST = `# PR review checklist
- [ ] Tests cover the new behavior
- [ ] No unrelated changes bundled in
- [ ] Public API changes are documented
`;

async function buildSkills(): Promise<Skill[]> {
  const flat = Skill.fromMarkdown("commit-style", FLAT_SKILL_MARKDOWN);

  // A packaged skill's attachments can live on a VirtualFS just as well as on
  // real disk — Skill.fromFS proves it without needing any fixture files.
  const skillsFs = NimboFS.fromMemory({
    "pr-review/SKILL.md": PACKAGED_SKILL_MD,
    "pr-review/checklist.md": PACKAGED_SKILL_CHECKLIST,
  });
  const packaged = await Skill.fromFS(skillsFs, "/pr-review");

  return [flat, packaged];
}

async function deterministicSection(): Promise<void> {
  console.log("--- 1. building skills + the <available_skills> prompt injection ---");

  const skills = await buildSkills();
  for (const skill of skills) {
    console.log(`- ${skill.name}: ${skill.description} (files: ${skill.files ? Object.keys(skill.files).join(", ") : "none"})`);
  }

  console.log("\n<available_skills> block injected into the system prompt:\n");
  console.log(buildAvailableSkillsBlock(skills) ?? "(no skills configured)");
}

async function modelDrivenSection(): Promise<void> {
  const model = resolveModel();

  console.log("\n--- 2. agent calls load-skill on demand ---");

  const skills = await buildSkills();
  const agent = defineAgent({ model, skills });
  const session = createSession(agent, { fs: NimboFS.fromMemory({}) });

  const result = await session.send("我要写一条 commit message，先看看仓库的规范是什么。");
  console.log("finalResponse:", result.finalResponse);
  console.log(
    "tool_call items:",
    result.items.filter((item) => item.type === "tool_call"),
  );
}

await deterministicSection();
await modelDrivenSection();
