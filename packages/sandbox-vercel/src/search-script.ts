/**
 * `SEARCH_SCRIPT`：原生搜索快路径（docs/tech/sandbox.md §4）里真正在沙盒内跑的那段脚本，
 * `fs.ts` 经 `sandbox.runCommand({ cmd: "node", args: ["-e", SEARCH_SCRIPT, "--", JSON.stringify(payload)] })`
 * 一次网络往返把整棵树的扫描（glob 全量匹配 / grep 全量扫描）丢给沙盒自己的 node 完成，
 * 免去逐文件 readdir/stat/readFile 各一次 RTT。
 *
 * ---- 为什么是一段裸字符串常量，而不是独立的 .js 文件 + 打包 ----
 *
 * 这段脚本运行在**远端沙盒的 node**里，不是本包自己的运行时——它不能 `require`
 * 任何本包/`@nimbo/*` 的模块（沙盒里没有这些包），必须是一段零依赖、自包含的
 * 纯 JS。写成字符串常量经单个 argv 元素传给 `node -e`，避免"先把脚本文件写进
 * 沙盒再执行"这类额外的一次文件写入 RTT。脚本体故意只用 `var`/`function`/字符串
 * 拼接这类最保守的语法（不用模板字符串——本文件自身是一个 TS 模板字符串，两层
 * 模板字符串嵌套会让 `${`/`` ` ``需要转义，可读性骤降，不划算），运行时目标是
 * "任何拿到手的 Linux + node 都能跑"，不追求 sandbox 内 node 版本的新特性。
 *
 * ---- 语义零漂移：正则全部由调用侧预编译好 source 传入 ----
 *
 * `patternSource`/`scopeSource`/`ignoreSources` 都是调用侧（`fs.ts`）用
 * `@nimbo/virtual-fs` 的 `globToRegExp(pattern).source` 预编译好的正则表达式
 * source；脚本里只做 `new RegExp(source)`，因此这里跑的和 `@nimbo/virtual-fs`
 * 的 JS 回退路径是**同一条正则**，不会出现"两条路径各自实现一份 glob 语法、
 * 行为慢慢漂移"的问题。grep 的内容匹配同理——`patternSource` 是调用侧已经校验
 * 过的合法 JavaScript RegExp source（`ContentSearchQuery.pattern` 契约本身如此），
 * 脚本只需按 `ignoreCase` 决定是否加 `"i"` 标志。
 *
 * ---- ignore 的 ancestor-or-self 剪枝：和 `@nimbo/virtual-fs` 的 `isIgnoredPath`
 * 同一套算法，这里必须重复实现一份 ----
 *
 * `isIgnoredPath`（`packages/virtual-fs/src/path.ts`）没有从包入口导出（只在
 * 包内部给 grep/glob 工具用），而这段脚本运行在沙盒里，本就不能 import 任何
 * `@nimbo/*` 模块——即使导出了也用不上。因此 `isIgnored()` 是这套"命中路径自身
 * 或任一祖先目录即整棵子树剪枝"算法的第二份实现，两处保持同步靠的是它足够简单
 * （20 行内的前缀扫描）且双方都有测试锁住行为，不是靠共享代码。
 *
 * ---- 内容搜索的截断逻辑（`capContentSearch`）与 `collectFileMatches` 是
 * `packages/virtual-fs/src/tools/grep.ts` 对应函数的逐行移植 ----
 *
 * 双路径（native 脚本 / JS 回退）要求输出逐字符一致（`ContentSearchResult` 同形），
 * 因此这两个函数必须和 grep.ts 的 TS 版本保持算法上的精确对应——maxFiles 先截
 * 文件列表（totalFiles 仍是全量计数），content 模式再按输出行数累加、哪个先到
 * 先停，被截断的最后一组只保留部分行而不是整组丢弃。
 *
 * ---- 二进制嗅探：文件头 8KB 含 NUL 即跳过，和 JS 回退路径的判据不同 ----
 *
 * JS 回退路径（`grep.ts` 的 `readTextOrSkip`）靠扩展名推断的 `mimeType` 判断
 * 文本/二进制；这段脚本里没有那张 mimeType 表可用（同样是"不能 import
 * @nimbo/*"的限制），改用更朴素但足够通用的字节嗅探——读文件头 8KB，出现
 * `0x00` 就判定为二进制并跳过。两种判据不保证对每个边界文件的判断完全一致
 * （比如某些没有可识别扩展名、但内容全是可打印字符的文件），但对真实代码库里
 * 绝大多数文件（源码 vs. 图片/压缩包/二进制可执行文件）结论相同。
 */

export const SEARCH_SCRIPT = [
  '"use strict";',
  'var fs = require("node:fs");',
  "",
  "function isIgnored(virtualPath, ignoreRegexes) {",
  "  if (ignoreRegexes.length === 0) return false;",
  '  var segments = virtualPath.split("/").filter(function (s) { return s.length > 0; });',
  '  var prefix = "";',
  "  for (var i = 0; i < segments.length; i++) {",
  '    prefix += "/" + segments[i];',
  "    for (var j = 0; j < ignoreRegexes.length; j++) {",
  "      if (ignoreRegexes[j].test(prefix)) return true;",
  "    }",
  "  }",
  "  return false;",
  "}",
  "",
  "function toVirtual(realPath, rootPrefix) {",
  "  var v = realPath.slice(rootPrefix.length);",
  '  return v.length === 0 ? "/" : v;',
  "}",
  "",
  "function walk(startReal, ignoreRegexes, rootPrefix, onFile) {",
  "  var stack = [startReal];",
  "  while (stack.length > 0) {",
  "    var dir = stack.pop();",
  "    var entries;",
  "    try {",
  "      entries = fs.readdirSync(dir, { withFileTypes: true });",
  "    } catch (error) {",
  "      continue;",
  "    }",
  "    for (var i = 0; i < entries.length; i++) {",
  "      var entry = entries[i];",
  '      var realChild = dir === "/" ? "/" + entry.name : dir + "/" + entry.name;',
  "      var virtualChild = toVirtual(realChild, rootPrefix);",
  "      if (isIgnored(virtualChild, ignoreRegexes)) continue;",
  "      if (entry.isDirectory()) {",
  "        stack.push(realChild);",
  "      } else if (entry.isFile()) {",
  "        onFile(realChild, virtualChild);",
  "      }",
  "    }",
  "  }",
  "}",
  "",
  "function collectFileMatches(text, regex, context) {",
  '  var lines = text.length === 0 ? [] : text.split("\\n");',
  "  var matchedIdx = [];",
  "  for (var i = 0; i < lines.length; i++) {",
  "    if (regex.test(lines[i])) matchedIdx.push(i);",
  "  }",
  "  if (matchedIdx.length === 0) return undefined;",
  "  var includedSet = new Set();",
  "  for (var m = 0; m < matchedIdx.length; m++) {",
  "    var idx = matchedIdx[m];",
  "    var from = Math.max(0, idx - context);",
  "    var to = Math.min(lines.length - 1, idx + context);",
  "    for (var j = from; j <= to; j++) includedSet.add(j);",
  "  }",
  "  var matchedSet = new Set(matchedIdx);",
  "  return Array.from(includedSet)",
  "    .sort(function (a, b) { return a - b; })",
  "    .map(function (i) { return { line: i + 1, text: lines[i], match: matchedSet.has(i) }; });",
  "}",
  "",
  "function capContentSearch(groups, maxFiles, maxLines, mode) {",
  "  var totalFiles = groups.length;",
  "  var cappedGroups = groups.length > maxFiles ? groups.slice(0, maxFiles) : groups;",
  '  if (mode === "files") {',
  "    return { groups: cappedGroups, totalFiles: totalFiles, lineCapped: false };",
  "  }",
  "  var boundedGroups = [];",
  "  var consumed = 0;",
  "  var lineCapped = false;",
  "  for (var i = 0; i < cappedGroups.length; i++) {",
  "    var group = cappedGroups[i];",
  "    if (consumed >= maxLines) { lineCapped = true; break; }",
  "    var remaining = maxLines - consumed;",
  "    if (group.lines.length <= remaining) {",
  "      boundedGroups.push(group);",
  "      consumed += group.lines.length;",
  "    } else {",
  "      boundedGroups.push({ path: group.path, lines: group.lines.slice(0, remaining) });",
  "      consumed += remaining;",
  "      lineCapped = true;",
  "      break;",
  "    }",
  "  }",
  "  return { groups: boundedGroups, totalFiles: totalFiles, lineCapped: lineCapped };",
  "}",
  "",
  "function runFilesOp(payload) {",
  "  var patternRegex = new RegExp(payload.patternSource);",
  "  var ignoreRegexes = payload.ignoreSources.map(function (s) { return new RegExp(s); });",
  "  var matched = [];",
  "  walk(payload.startReal, ignoreRegexes, payload.rootPrefix, function (_realPath, virtualPath) {",
  "    if (patternRegex.test(virtualPath)) matched.push(virtualPath);",
  "  });",
  "  matched.sort();",
  "  var total = matched.length;",
  "  return { paths: matched.slice(0, payload.limit), total: total };",
  "}",
  "",
  "function runContentOp(payload) {",
  "  var scopeRegex = new RegExp(payload.scopeSource);",
  "  var ignoreRegexes = payload.ignoreSources.map(function (s) { return new RegExp(s); });",
  '  var contentRegex = new RegExp(payload.patternSource, payload.ignoreCase ? "i" : "");',
  "  var candidates = [];",
  "  walk(payload.startReal, ignoreRegexes, payload.rootPrefix, function (realPath, virtualPath) {",
  "    if (scopeRegex.test(virtualPath)) candidates.push({ realPath: realPath, virtualPath: virtualPath });",
  "  });",
  "  candidates.sort(function (a, b) {",
  "    if (a.virtualPath < b.virtualPath) return -1;",
  "    if (a.virtualPath > b.virtualPath) return 1;",
  "    return 0;",
  "  });",
  "  var groups = [];",
  "  for (var i = 0; i < candidates.length; i++) {",
  "    var candidate = candidates[i];",
  "    var buffer;",
  "    try {",
  "      buffer = fs.readFileSync(candidate.realPath);",
  "    } catch (error) {",
  "      continue;",
  "    }",
  "    var sniffLen = Math.min(buffer.length, 8192);",
  "    var binary = false;",
  "    for (var k = 0; k < sniffLen; k++) {",
  "      if (buffer[k] === 0) { binary = true; break; }",
  "    }",
  "    if (binary) continue;",
  '    var text = buffer.toString("utf8");',
  '    if (payload.mode === "files") {',
  "      if (contentRegex.test(text)) groups.push({ path: candidate.virtualPath, lines: [] });",
  "    } else {",
  "      var lines = collectFileMatches(text, contentRegex, payload.context);",
  "      if (lines !== undefined) groups.push({ path: candidate.virtualPath, lines: lines });",
  "    }",
  "  }",
  "  return capContentSearch(groups, payload.maxFiles, payload.maxLines, payload.mode);",
  "}",
  "",
  "try {",
  "  var payload = JSON.parse(process.argv[1]);",
  '  var output = payload.op === "content" ? runContentOp(payload) : runFilesOp(payload);',
  "  process.stdout.write(JSON.stringify(output));",
  "} catch (error) {",
  "  process.stderr.write(String((error && error.stack) || error));",
  "  process.exitCode = 1;",
  "}",
].join("\n");
