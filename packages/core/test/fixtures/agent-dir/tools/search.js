// Second fixture tool (P7-3 task 4) — proves "file name is the tool name" for
// more than one file, and exercises the optional `approval` field passthrough.
export default {
  description: "Search fixture data (dummy — always returns a canned result).",
  inputSchema: { _fixtureNote: "same as greet.js", safeParse: () => ({ success: true, data: {} }) },
  approval: "once",
  execute: () => "no results (fixture)",
};
