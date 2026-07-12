// Fixture tool (P7-3 task 4): compiled .js on purpose — loadAgent()'s dynamic
// import() works on plain JS in every supported Node version; the .ts path
// additionally needs Node's native TypeScript stripping (>= 22.18) or a
// host build step, exercised separately by an ephemeral-fixture test gated
// on the running Node version (see load-agent.test.ts), not by this
// committed fixture.
export default {
  description: "Greet a person by name.",
  inputSchema: {
    _fixtureNote:
      "Not a real zod schema (no real parsing logic). loadAgent()'s isZodSchemaLike() probe (P7-3R) only " +
      "checks for a callable \"safeParse\" method — it never invokes it or validates its result beyond " +
      "that (see load-agent.ts's isToolLikeRecord/parseToolRecord), so this stub is enough to prove the " +
      "field round-trips untouched while still satisfying the structural probe.",
    safeParse: () => ({ success: true, data: {} }),
  },
  execute: async (input) => `Hello, ${input.name}!`,
};
