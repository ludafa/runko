/**
 * 命令拆分器（[命令段](../../../../docs/terms.md) / docs/tech/approval-grant-split.md §3）：
 * 把一条 bash 命令行切成若干条简单命令，供[分段授权](../../../../docs/terms.md)
 * 按段记账。纯函数，无 I/O、无依赖。
 *
 * ---- 唯一的正确性要求：失败必须向严格的方向倒（§3.1） ----
 *
 * 两种出错方式后果不对称：
 *
 * - **拆不出来 / 拆得过细** → 调用方退回整串匹配 → 用户多点一次按钮。**等价于
 *   本功能上线前的行为，零回退。**
 * - **漏看了一条命令** → 危险命令被当成已授权放行。**这是唯一要防的失效模式。**
 *
 * 因此本模块**不实现完整 bash 文法**，只实现「能完全看懂的形状才拆，剩下一律
 * 返回 `undefined`」。完备性的负担被「退回整串」这个兜底卸掉了——`REJECTED`
 * 那批构造只增不减，加一条只会让更多命令退回整串，永远不会放宽。
 *
 * ---- 为什么 `$VAR` 可以当普通 token（§3.3） ----
 *
 * bash 不会把参数展开的结果重新解析成操作符：`X=';rm -rf /'; echo $X` 打印
 * 字面量、不执行 rm。所以 `rm -rf $DIR` 永远只是**一条**命令，变量当普通实参
 * 不会漏看命令。真正会把字符串重新当命令解析的只有 `eval` 与命令替换
 * （`$(...)` / 反引号），那几个在下面一律拒绝。
 *
 * ---- 已知限制（§3.5） ----
 *
 * 只回答「这行字里写了哪几条命令」，不回答「这几条命令实际会跑起什么」——
 * `npm run build` / `bash x.sh` / `make` / `sudo` 背后跑什么一概不知。整串授权
 * 有完全相同的限制，本模块不加重也不解决。
 */

/** 一条简单命令：去引号后的 argv（词边界保真）+ 按出现顺序规范化的重定向。 */
export interface CommandSegment {
  argv: string[];
  /** 规范化为 `${fd}${op}${target}`，如 `>log.txt` / `2>&1` / `>>out` / `<in`。 */
  redirects: string[];
}

/**
 * 内部信号：扫描到看不透的构造。只在本模块内抛出、在 `splitCommand` 一处捕获
 * 转成 `undefined`——用异常而非层层回传 `undefined`，是为了让 20 多个拒绝点
 * 都能就地 `bail(...)` 而不污染每个辅助函数的返回类型。
 */
class BailOut extends Error {}

function bail(reason: string): never {
  throw new BailOut(reason);
}

/**
 * 作为**命令词**（argv[0]）出现即拒绝的 shell 关键字（§3.4 #12）：控制结构在
 * 平坦切分下没有意义。只在位置 0 判断——`echo if` 里的 `if` 是普通实参。
 */
const KEYWORDS_AS_COMMAND: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'function',
  'select',
  'time',
  'coproc',
  '[[',
  ']]',
]);

/**
 * 出现在 argv **任意位置**即拒绝：`{`/`}` 是命令组（§3.4 #5）、`!` 是取反/历史
 * 展开（#11）、`eval` 把字符串重新当命令解析（#3）。这几个不像关键字那样只在
 * 命令词位置才有特殊含义，或者（`eval`）出现在任何位置都同样危险。
 */
const FORBIDDEN_WORDS: ReadonlySet<string> = new Set(['{', '}', '!', 'eval']);

/** 引号外遇到即终止当前词的字符（分隔符与重定向操作符的起始字符）。 */
function isWordBoundary(ch: string): boolean {
  return (
    ch === '' ||
    ch === ' ' ||
    ch === '\t' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === '|' ||
    ch === '&' ||
    ch === ';' ||
    ch === '<' ||
    ch === '>' ||
    ch === '(' ||
    ch === ')'
  );
}

interface ScanResult {
  text: string;
  end: number;
}

/**
 * 读一个词（从 `start` 起，调用方保证这里不是空白也不是边界字符），返回去引号后
 * 的文本。单引号内一切字面量；双引号内只处理 `\` 对 `"`/`\`/`$`/`` ` `` 的转义。
 * `$` 只在后跟 `(` 时拒绝（命令替换）——`$VAR`/`${VAR}` 按字面 token 收下，理由
 * 见文件头。引号外的 `\` 一律拒绝（§3.4 #8：`\;` 能让分隔符逃过识别）。
 */
function readWord(input: string, start: number): ScanResult {
  let i = start;
  let text = '';

  while (i < input.length) {
    const ch = input.charAt(i);

    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) bail('未闭合的单引号');
      text += input.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      const scanned = readDoubleQuoted(input, i + 1);
      text += scanned.text;
      i = scanned.end;
      continue;
    }

    if (ch === '\\') bail('引号外的反斜杠转义/续行');
    if (ch === '`') bail('命令替换（反引号）');
    if (ch === '$' && input.charAt(i + 1) === '(') bail('命令替换 $(...)');

    if (isWordBoundary(ch)) break;

    text += ch;
    i += 1;
  }

  return { text, end: i };
}

/** 读双引号内容（从开引号之后起），返回到闭引号之后的位置。 */
function readDoubleQuoted(input: string, start: number): ScanResult {
  let i = start;
  let text = '';

  while (i < input.length) {
    const ch = input.charAt(i);

    if (ch === '"') return { text, end: i + 1 };

    if (ch === '\\') {
      const next = input.charAt(i + 1);
      // 真实 bash：双引号内反斜杠只对这四个字符生效，其余保留反斜杠本身。
      if (next === '"' || next === '\\' || next === '$' || next === '`') {
        text += next;
        i += 2;
        continue;
      }
      text += ch;
      i += 1;
      continue;
    }

    if (ch === '`') bail('命令替换（反引号）');
    if (ch === '$' && input.charAt(i + 1) === '(') bail('命令替换 $(...)');

    text += ch;
    i += 1;
  }

  bail('未闭合的双引号');
}

/** `&1` / `&-` 这类 fd 复制目标（`2>&1` 的后半截）。不是则返回 `undefined`。 */
function readFdDupTarget(input: string, start: number): ScanResult | undefined {
  if (input.charAt(start) !== '&') return undefined;
  let i = start + 1;
  if (input.charAt(i) === '-') return { text: '&-', end: i + 1 };
  let digits = '';
  while (i < input.length && /[0-9]/.test(input.charAt(i))) {
    digits += input.charAt(i);
    i += 1;
  }
  if (digits === '') return undefined;
  return { text: `&${digits}`, end: i };
}

interface RedirectResult {
  redirect: string;
  end: number;
}

/**
 * 解析一处重定向。`fd` 是已消费的前缀文件描述符（`2>&1` 的 `2`，无则空串），
 * `start` 指向操作符首字符。产出规范化的 `${fd}${op}${target}`。
 */
function readRedirect(
  input: string,
  start: number,
  fd: string,
): RedirectResult {
  let i = start;
  let op: string;

  if (input.charAt(i) === '&') {
    // `&>` / `&>>`：bash 的「stdout+stderr 一起重定向」
    if (input.charAt(i + 1) !== '>') bail('后台执行 &');
    op = input.charAt(i + 2) === '>' ? '&>>' : '&>';
    i += op.length;
  } else if (input.charAt(i) === '<') {
    if (input.charAt(i + 1) === '<') bail('heredoc / herestring');
    op = '<';
    i += 1;
  } else {
    op = input.charAt(i + 1) === '>' ? '>>' : '>';
    i += op.length;
  }

  const dup = readFdDupTarget(input, i);
  if (dup !== undefined)
    return { redirect: `${fd}${op}${dup.text}`, end: dup.end };

  while (input.charAt(i) === ' ' || input.charAt(i) === '\t') i += 1;

  const ch = input.charAt(i);
  if (isWordBoundary(ch)) bail('重定向缺少目标');
  if (ch === '#') bail('注释');

  const target = readWord(input, i);
  if (target.text === '') bail('重定向缺少目标');
  return { redirect: `${fd}${op}${target.text}`, end: target.end };
}

/** 一段完工时的校验：空段、关键字、禁用词（§3.4 #3/#5/#11/#12/#14）。 */
function finishSegment(
  argv: string[],
  redirects: string[],
  segments: CommandSegment[],
): void {
  if (argv.length === 0) bail('空命令段');

  const head = argv[0] ?? '';
  if (KEYWORDS_AS_COMMAND.has(head)) bail(`shell 关键字作为命令词：${head}`);
  for (const word of argv) {
    if (FORBIDDEN_WORDS.has(word)) bail(`禁用词：${word}`);
  }

  segments.push({ argv, redirects });
}

/**
 * 把一条命令行切成[命令段](../../../../docs/terms.md)。
 *
 * 接受的形状（§3.2）：`简单命令 (&& | || | ; | |) 简单命令 ...`，简单命令内部
 * 允许引号、`$VAR`/`${VAR}`、重定向、glob 字面量、前置环境变量赋值。
 *
 * @returns 拆得动时按出现顺序返回段数组；**任何**看不透的构造返回 `undefined`
 *   （调用方须退回整串匹配，绝不可当作「没有段 = 放行」）。
 */
export function splitCommand(command: string): CommandSegment[] | undefined {
  try {
    return scan(command);
  } catch (error) {
    if (error instanceof BailOut) return undefined;
    throw error;
  }
}

function scan(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let argv: string[] = [];
  let redirects: string[] = [];
  let sawTrailingSeparator = false;

  const cut = (): void => {
    finishSegment(argv, redirects, segments);
    argv = [];
    redirects = [];
  };

  let i = 0;
  while (i < command.length) {
    const ch = command.charAt(i);

    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }

    // ---- 拒绝清单里「一眼就能判」的那批（§3.4） ----
    if (ch === '\n' || ch === '\r') bail('引号外的换行（多行脚本）');
    if (ch === '\\') bail('引号外的反斜杠转义/续行');
    if (ch === '#') bail('注释'); // 已跳过空白，此处必是词首 → 真注释
    if (ch === '(' || ch === ')') bail('子 shell / 进程替换');
    if (ch === '`') bail('命令替换（反引号）');

    // ---- 分隔符 ----
    if (ch === ';') {
      cut();
      sawTrailingSeparator = true;
      i += 1;
      continue;
    }
    if (ch === '|') {
      cut();
      sawTrailingSeparator = false;
      i += command.charAt(i + 1) === '|' ? 2 : 1;
      continue;
    }
    if (ch === '&' && command.charAt(i + 1) === '&') {
      cut();
      sawTrailingSeparator = false;
      i += 2;
      continue;
    }

    // ---- 重定向 ----
    // `&>`/`&>>` 的 `&`；单独的 `&` 是后台执行，由 readRedirect 拒绝。
    if (ch === '&') {
      const parsed = readRedirect(command, i, '');
      redirects.push(parsed.redirect);
      i = parsed.end;
      continue;
    }
    // `2>file` / `2>&1`：fd 数字必须是紧贴操作符的完整前缀（`foo2>x` 里的 `2`
    // 属于 `foo2` 这个词，由下面的 readWord 消费，不走这条）。
    const fdMatch = /^([0-9]+)[<>]/.exec(command.slice(i));
    if (fdMatch !== null) {
      const fd = fdMatch[1] ?? '';
      const parsed = readRedirect(command, i + fd.length, fd);
      redirects.push(parsed.redirect);
      i = parsed.end;
      continue;
    }
    if (ch === '<' || ch === '>') {
      const parsed = readRedirect(command, i, '');
      redirects.push(parsed.redirect);
      i = parsed.end;
      continue;
    }

    // ---- 普通词 ----
    const word = readWord(command, i);
    if (word.end === i) bail(`无法识别的字符：${ch}`); // 防御：不推进即死循环
    argv.push(word.text);
    sawTrailingSeparator = false;
    i = word.end;
  }

  // 收尾：`a; ` 这种结尾分号是合法的、不补空段；`a && ` 则是残缺命令，拒绝。
  if (argv.length === 0 && redirects.length === 0) {
    if (segments.length === 0) bail('空命令');
    if (!sawTrailingSeparator) bail('以分隔符结尾的残缺命令');
    return segments;
  }
  cut();
  return segments;
}
