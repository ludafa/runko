/**
 * 04-mini-bash — the "same-origin workspace" story from docs/tech/core-sdk.md
 * §4.5a mode A: `createSession({ fs, exec: miniBash(fs) })` gives the file
 * tools and the `bash` tool the *same* NimboFS instance, so there is nothing
 * to keep in sync — a file written through `write-file` is immediately
 * visible to `cat`, because there's only ever one copy of the data.
 *
 * mini-bash itself is a pure-TypeScript interpreter (no child process, no
 * real OS access) supporting `cat`/`grep`/`find`/`tail`/`head`/`echo` plus
 * the control operators `|`, `;`, `&&`, `||`, `2>&1`. It refuses file
 * redirection (`>`, `>>`, `<`) on purpose — writes must go through
 * `write-file` so they produce a `file_change` item and stay in readState;
 * a redirect would be a silent bypass. `cat <file>` covers the `<` use case.
 *
 * Demonstrates: miniBash(fs), createSession({ fs, exec }), the conditional
 * `bash` built-in tool, mini-bash's control-flow operators.
 *
 * Run: `node examples/04-mini-bash.ts` (see examples/README.md for setup).
 *
 * Expected output shape:
 *   1. A deterministic section (no model, no env vars needed): writes a file
 *      through the NimboFS interface, then calls miniBash(fs).exec(...)
 *      directly (bypassing the agent loop entirely) to `cat` it and to run
 *      a `&&`/`|` pipeline — proving the interpreter reads the same data the
 *      file tools would have written.
 *   2. If NIMBO_MODEL is set: a full session with both the file tools and
 *      `bash` wired to the same fs; the agent is asked to write a file and
 *      then shell out to inspect it. If NIMBO_MODEL is unset, this section
 *      is skipped with a clean exit.
 */
import { createSession, defineAgent, miniBash, NimboFS } from "@nimbo/sdk";
import { resolveModel } from "./shared/model.ts";

async function deterministicSection(): Promise<void> {
  console.log("--- 1. same fs, no sync needed: write via NimboFS, read via mini-bash ---");

  const fs = NimboFS.fromMemory({});
  await fs.writeFile("/notes/todo.txt", "buy milk\nwrite docs\nship it\n");

  const exec = miniBash(fs);
  console.log("describe():\n" + exec.describe?.());

  const cat = await exec.exec({ command: "cat /notes/todo.txt", signal: new AbortController().signal });
  console.log("\n`cat /notes/todo.txt` ->", cat);

  const pipeline = await exec.exec({
    command: "grep -c write /notes/todo.txt && echo found || echo not-found",
    signal: new AbortController().signal,
  });
  console.log("`grep -c write ... && echo found || echo not-found` ->", pipeline);
}

async function modelDrivenSection(): Promise<void> {
  const model = resolveModel();

  console.log("\n--- 2. agent writes a file, then shells out to inspect it (same session) ---");

  const fs = NimboFS.fromMemory({});
  const agent = defineAgent({ model });
  const session = createSession(agent, { fs, exec: miniBash(fs) });

  const result = await session.send('创建 /notes/todo.txt，内容是三行待办事项，然后用 bash 数一下有几行。');
  console.log("finalResponse:", result.finalResponse);
  console.log(
    "tool_call items:",
    result.items.filter((item) => item.type === "tool_call"),
  );
}

await deterministicSection();
await modelDrivenSection();
