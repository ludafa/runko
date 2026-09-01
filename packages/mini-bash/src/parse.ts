/**
 * mini-bash 命令行解析（docs/tech/core-sdk.md §4.5a / docs/plans/core-sdk.md P6）：
 * 单双引号（含引号内空格与嵌引号）、空白分词、单层管道 `|`、命令分隔符
 * `;`、逻辑操作符 `&&`/`||`、`2>&1`。语法结构对齐 POSIX 优先级：`|` 最紧
 * （管道内各阶段先组成一个整体）；`&&`/`||` 同级、左结合，连接管道；`;`
 * 优先级最松，把整条命令行切成若干条独立链，链之间总是依次全部执行（不
 * 因前一条的退出码而跳过）。返回值 `ParsedScript` 就是这三层结构的直译：
 * `script`（按 `;` 切分）→ `chain`（按 `&&`/`||` 左结合连接的管道序列，
 * 每个 `ParsedLink.next` 记录连到下一个管道的操作符，链上最后一个为
 * `undefined`）→ `pipeline`（按 `|` 连接的 `ParsedStage[]`）→ `stage`
 * （一条命令的 argv，外加 `2>&1` 是否出现在该命令末尾的标记）。
 *
 * 明确不支持的语法在扫描到对应字符时立即抛 `MiniBashParseError`，不静默
 * 吞掉或退化成字面量——重定向 (`>`/`>>`/`<`，报错文案附写文件/读文件的
 * 替代指引)、变量展开 (`$var`/`${var}`)、子 shell/命令替换
 * (`` `...` ``/`$(...)`)、后台执行 (`&`)。这些字符只在**引号外**触发报
 * 错——单引号内一律字面量（真实 shell 语义：单引号抑制一切展开），双引号
 * 内仍会触发 `$`/`` ` `` 的报错（真实 shell 里双引号不抑制变量/命令替换，
 * 只抑制分词与其余元字符——`;`/`&&`/`||`/`|`/`&`/`>`/`<` 在双引号内也是
 * 字面量，这里靠 `scanDoubleQuoted` 整段消费实现，主扫描循环不会单独看到
 * 这些字符）。glob 字符（`*`/`?`/`[`/`]` 等）不在此列——它们按字面字符传
 * 给命令，不展开也不报错（tech-spec P6 工单：不支持通配符展开，但不是语
 * 法错误）。
 */

export class MiniBashParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiniBashParseError";
  }
}

function unsupported(what: string, token: string, guidance?: string): never {
  const suffix = guidance !== undefined ? `，${guidance}` : "";
  throw new MiniBashParseError(`mini-bash 不支持${what} (${token})${suffix}`);
}

/** 单条命令的 argv，加上其末尾是否出现 `2>&1`（stderr 并入 stdout）。 */
export interface ParsedStage {
  argv: string[];
  mergeStderr: boolean;
}

/** 一个管道：`|` 连接的至少一个阶段。 */
export type ParsedPipeline = ParsedStage[];

export type ChainOperator = "&&" | "||";

/** `next` 是连接到下一个管道的操作符；链中最后一个管道的 `next` 为 `undefined`。 */
export interface ParsedLink {
  pipeline: ParsedPipeline;
  next: ChainOperator | undefined;
}

/** `;` 分隔出的一条链：`&&`/`||` 左结合连接的至少一个管道。 */
export type ParsedChain = ParsedLink[];

/** 整条命令行：`;` 分隔的至少一条链，链之间总是全部依次执行。 */
export type ParsedScript = ParsedChain[];

/**
 * 解析一段双引号内容，从开引号之后的位置开始扫描，返回解出的文本与结束
 * 位置（指向闭引号之后一个字符）。只识别 `\"`/`\\` 两种转义（对齐真实
 * shell：双引号内反斜杠只对 `"`、`\`、`$`、`` ` `` 生效，本实现里 `$`/
 * `` ` `` 无条件报错，因此这里只需处理另外两个）。
 */
function scanDoubleQuoted(input: string, start: number): { text: string; end: number } {
  let i = start;
  let text = "";
  while (i < input.length) {
    const ch = input.charAt(i);
    if (ch === '"') {
      return { text, end: i + 1 };
    }
    if (ch === "\\" && (input.charAt(i + 1) === '"' || input.charAt(i + 1) === "\\")) {
      text += input.charAt(i + 1);
      i += 2;
      continue;
    }
    if (ch === "$") {unsupported("变量展开", "$var");}
    if (ch === "`") {unsupported("子 shell（命令替换）", "`...`");}
    text += ch;
    i += 1;
  }
  throw new MiniBashParseError("mini-bash: 未闭合的双引号");
}

const MERGE_STDERR_TOKEN = "2>&1";

/** `2>&1` 后面必须是分隔符（或字符串结尾）才当作控制 token，否则按字面字符处理（如 `2>file` 走普通重定向报错）。 */
function isDelimiterAfterMergeToken(ch: string): boolean {
  return ch === "" || ch === " " || ch === "\t" || ch === "|" || ch === ";" || ch === "&";
}

/** 把一条命令行解析为 `;`/`&&`/`||`/`|` 四层结构（见文件头注释）。 */
export function parse(command: string): ParsedScript {
  const chains: ParsedChain[] = [];
  let links: ParsedLink[] = [];
  let stages: ParsedStage[] = [];
  let currentArgs: string[] = [];
  let currentToken: string | null = null;
  let currentMergeStderr = false;

  const pushToken = (): void => {
    if (currentToken !== null) {
      currentArgs.push(currentToken);
      currentToken = null;
    }
  };

  const pushStage = (): void => {
    pushToken();
    if (currentArgs.length === 0) {
      throw new MiniBashParseError("mini-bash: 管道中出现空命令");
    }
    stages.push({ argv: currentArgs, mergeStderr: currentMergeStderr });
    currentArgs = [];
    currentMergeStderr = false;
  };

  /** 结束当前管道，把它接到链上，记录连到下一个管道的操作符（`undefined` = 链在此结束）。 */
  const pushLink = (next: ChainOperator | undefined): void => {
    pushStage();
    links.push({ pipeline: stages, next });
    stages = [];
  };

  /** 结束当前链（`;` 或输入结尾），接到脚本上。 */
  const pushChain = (): void => {
    chains.push(links);
    links = [];
  };

  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command.charAt(i);

    if (ch === " " || ch === "\t") {
      pushToken();
      i += 1;
      continue;
    }

    if (ch === "2" && currentToken === null && command.slice(i, i + MERGE_STDERR_TOKEN.length) === MERGE_STDERR_TOKEN) {
      const after = command.charAt(i + MERGE_STDERR_TOKEN.length);
      if (isDelimiterAfterMergeToken(after)) {
        currentMergeStderr = true;
        i += MERGE_STDERR_TOKEN.length;
        continue;
      }
    }

    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) {throw new MiniBashParseError("mini-bash: 未闭合的单引号");}
      currentToken = (currentToken ?? "") + command.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      const { text, end } = scanDoubleQuoted(command, i + 1);
      currentToken = (currentToken ?? "") + text;
      i = end;
      continue;
    }

    if (ch === "|") {
      if (command.charAt(i + 1) === "|") {
        pushLink("||");
        i += 2;
        continue;
      }
      pushStage();
      i += 1;
      continue;
    }

    if (ch === ";") {
      pushLink(undefined);
      pushChain();
      i += 1;
      continue;
    }

    if (ch === "&") {
      if (command.charAt(i + 1) === "&") {
        pushLink("&&");
        i += 2;
        continue;
      }
      unsupported("后台执行", "&");
    }

    if (ch === ">") {
      unsupported("重定向", command.charAt(i + 1) === ">" ? ">>" : ">", "写文件请改用 write-file 工具");
    }

    if (ch === "<") {
      unsupported("重定向", "<", "读文件请直接 cat <file>");
    }

    if (ch === "$") {
      unsupported(command.charAt(i + 1) === "(" ? "子 shell（命令替换）" : "变量展开", command.charAt(i + 1) === "(" ? "$(...)" : "$var");
    }

    if (ch === "`") {
      unsupported("子 shell（命令替换）", "`...`");
    }

    currentToken = (currentToken ?? "") + ch;
    i += 1;
  }

  pushLink(undefined);
  pushChain();
  return chains;
}
