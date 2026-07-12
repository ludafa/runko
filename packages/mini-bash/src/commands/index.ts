import { cat } from "./cat.js";
import { cd } from "./cd.js";
import { echo } from "./echo.js";
import { find } from "./find.js";
import { grep } from "./grep.js";
import { head } from "./head.js";
import { pwd } from "./pwd.js";
import { tail } from "./tail.js";
import type { CommandFn } from "./types.js";

/** 八命令注册表：exec.ts 按命令名查找，找不到即 "command not found"（exit 127）。 */
export const COMMANDS: Record<string, CommandFn> = { cat, grep, find, tail, head, echo, cd, pwd };

export type { CommandContext, CommandFn, CommandResult } from "./types.js";
