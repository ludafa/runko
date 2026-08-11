/**
 * 命令拆分器（src/agent/split-command.ts，docs/app/approval-grant-split/tech.md §3）。
 *
 * 两组用例对应拆分器的两个方向：
 *
 * - **接受组**：§3.2 允许的每种语法，断言段数、argv（词边界必须保真）、redirects 精确相等。
 * - **拒绝组**：§3.4 拒绝清单**逐条**一个用例，断言返回 `undefined`。这组是安全用例——
 *   它守的是「漏看一条命令」这个唯一要防的失效模式，不是可选的覆盖率装饰。
 */
import { describe, expect, it } from 'vitest';

import type { CommandSegment } from '../../src/agent/split-command.js';
import { splitCommand } from '../../src/agent/split-command.js';

/** 只关心 argv 时的简写：redirects 断言为空。 */
function seg(...argv: string[]): CommandSegment {
  return { argv, redirects: [] };
}

describe('splitCommand — 接受的形状（§3.2）', () => {
  it('拆开工单原例的三段复合命令', () => {
    expect(
      splitCommand(
        'cd /home/user/repo && rm -rf node_modules package-lock.json && npm install react react-dom next --no-audit --no-fund 2>&1',
      ),
    ).toEqual([
      seg('cd', '/home/user/repo'),
      seg('rm', '-rf', 'node_modules', 'package-lock.json'),
      {
        argv: [
          'npm',
          'install',
          'react',
          'react-dom',
          'next',
          '--no-audit',
          '--no-fund',
        ],
        redirects: ['2>&1'],
      },
    ]);
  });

  it('单条命令就是一段', () => {
    expect(splitCommand('ls -la')).toEqual([seg('ls', '-la')]);
  });

  it.each([
    ['&&', 'a && b'],
    ['||', 'a || b'],
    [';', 'a ; b'],
    ['|', 'a | b'],
  ])('按 %s 切分', (_name, command) => {
    expect(splitCommand(command)).toEqual([seg('a'), seg('b')]);
  });

  it('分隔符两侧无空格也切得开', () => {
    expect(splitCommand('a&&b|c;d')).toEqual([
      seg('a'),
      seg('b'),
      seg('c'),
      seg('d'),
    ]);
  });

  it('容许结尾的分号', () => {
    expect(splitCommand('ls;')).toEqual([seg('ls')]);
  });

  it('单引号内一切字面量——分隔符、$、#、反引号都不生效', () => {
    expect(splitCommand("echo 'a && b; c # $(x) `y`'")).toEqual([
      seg('echo', 'a && b; c # $(x) `y`'),
    ]);
  });

  it('双引号内的分隔符不切分，且保住词边界', () => {
    expect(splitCommand('rm -rf "my dir"')).toEqual([
      seg('rm', '-rf', 'my dir'),
    ]);
  });

  it('引号保住词边界——两条命令必须拆出不同的 argv（安全关键）', () => {
    expect(splitCommand('rm -rf "my dir"')).not.toEqual(
      splitCommand('rm -rf my dir'),
    );
  });

  it('双引号内的反斜杠只对 " \\ $ ` 生效', () => {
    expect(splitCommand('echo "a\\"b\\\\c\\$d"')).toEqual([
      seg('echo', 'a"b\\c$d'),
    ]);
  });

  it('引号可以拼接在词中间', () => {
    expect(splitCommand('git commit -m"fix: a b"')).toEqual([
      seg('git', 'commit', '-mfix: a b'),
    ]);
  });

  it('$VAR / ${VAR} 当普通实参 token（§3.3）', () => {
    expect(splitCommand('rm -rf $DIR/${SUB}')).toEqual([
      seg('rm', '-rf', '$DIR/${SUB}'),
    ]);
  });

  it('双引号内的 $VAR 同样收下', () => {
    expect(splitCommand('echo "$HOME/x"')).toEqual([seg('echo', '$HOME/x')]);
  });

  it('glob 字符按字面 token 处理，不展开也不拒绝', () => {
    expect(splitCommand('ls src/*.ts test/?.ts a[0-9]')).toEqual([
      seg('ls', 'src/*.ts', 'test/?.ts', 'a[0-9]'),
    ]);
  });

  it('前置环境变量赋值是 argv 的一部分', () => {
    expect(splitCommand('NODE_ENV=production npm run build')).toEqual([
      seg('NODE_ENV=production', 'npm', 'run', 'build'),
    ]);
  });

  it.each([
    ['> 覆盖写', 'echo hi > log.txt', ['>log.txt']],
    ['>> 追加', 'echo hi >> log.txt', ['>>log.txt']],
    ['< 读入', 'sort < in.txt', ['<in.txt']],
    ['2> stderr', 'npm run build 2> err.log', ['2>err.log']],
    ['2>> stderr 追加', 'npm run build 2>> err.log', ['2>>err.log']],
    ['2>&1 fd 复制', 'npm run build 2>&1', ['2>&1']],
    ['>&2 fd 复制', 'echo oops >&2', ['>&2']],
    ['&> 两路合并', 'npm run build &> all.log', ['&>all.log']],
    ['&>> 两路追加', 'npm run build &>> all.log', ['&>>all.log']],
    ['紧贴无空格', 'echo hi>log.txt', ['>log.txt']],
    ['多个重定向', 'cmd > out.txt 2>&1', ['>out.txt', '2>&1']],
  ])('重定向：%s', (_name, command, redirects) => {
    const result = splitCommand(command);
    expect(result).toHaveLength(1);
    expect(result?.[0]?.redirects).toEqual(redirects);
  });

  it('重定向不进 argv', () => {
    expect(splitCommand('npm run build 2>&1')).toEqual([
      { argv: ['npm', 'run', 'build'], redirects: ['2>&1'] },
    ]);
  });

  it('数字实参与 fd 前缀区分得开', () => {
    // `2` 后面隔着空格 → 普通实参；`foo2>x` 的 `2` 属于 `foo2` 这个词。
    expect(splitCommand('head -n 2 file')).toEqual([
      seg('head', '-n', '2', 'file'),
    ]);
    expect(splitCommand('echo foo2>bar')).toEqual([
      { argv: ['echo', 'foo2'], redirects: ['>bar'] },
    ]);
  });

  it('每段各自带自己的重定向', () => {
    expect(splitCommand('a > x.log && b 2>&1')).toEqual([
      { argv: ['a'], redirects: ['>x.log'] },
      { argv: ['b'], redirects: ['2>&1'] },
    ]);
  });

  it('shell 关键字出现在实参位置不受影响', () => {
    expect(splitCommand('echo if for while')).toEqual([
      seg('echo', 'if', 'for', 'while'),
    ]);
  });

  it('# 在词中间是字面量，不是注释', () => {
    expect(splitCommand('echo a#b')).toEqual([seg('echo', 'a#b')]);
  });
});

describe('splitCommand — 拒绝清单（§3.4，逐条）', () => {
  it.each([
    ['#1 命令替换 $()', 'echo $(rm -rf /)'],
    ['#1 命令替换 $() 嵌在词里', 'cd /repo/$(whoami)'],
    ['#1 命令替换 $() 在双引号内', 'echo "$(rm -rf /)"'],
    ['#1 命令替换 反引号', 'echo `rm -rf /`'],
    ['#1 命令替换 反引号 在双引号内', 'echo "`rm -rf /`"'],
    ['#2 进程替换 <()', 'diff <(ls a) <(ls b)'],
    ['#2 进程替换 >()', 'tee >(cat) < in'],
    ['#3 eval', 'eval "$CMD"'],
    ['#3 eval 非首位', 'xargs eval foo'],
    ['#4 子 shell', '(rm -rf /)'],
    ['#4 子 shell 在后半段', 'ls && (rm -rf /)'],
    ['#5 命令组 {', '{ rm -rf / ; }'],
    ['#5 命令组 }', 'ls ; }'],
    ['#6 heredoc', 'cat <<EOF'],
    ['#6 herestring', 'cat <<< hello'],
    ['#7 换行', 'ls\nrm -rf /'],
    ['#7 回车', 'ls\rrm -rf /'],
    ['#8 反斜杠转义分隔符', 'echo a\\; rm -rf /'],
    ['#8 反斜杠续行', 'ls \\\nrm'],
    ['#9 注释', 'rm -rf x # && echo safe'],
    ['#9 注释在行首', '# just a comment'],
    ['#10 后台执行', 'sleep 100 &'],
    ['#10 后台执行接命令', 'sleep 100 & rm -rf /'],
    ['#11 取反', '! ls'],
    ['#11 取反作为实参', 'find . ! -name x'],
    ['#12 关键字 if', 'if [ -f x ]; then rm -rf /; fi'],
    ['#12 关键字 for', 'for f in *; do rm $f; done'],
    ['#12 关键字 while', 'while true; do ls; done'],
    ['#12 关键字 [[', '[[ -f x ]] && rm -rf /'],
    ['#12 关键字 time', 'time npm run build'],
    ['#13 未闭合单引号', "echo 'abc"],
    ['#13 未闭合双引号', 'echo "abc'],
    ['#14 空段（连续分隔符）', 'a && && b'],
    ['#14 空段（以分隔符开头）', '&& ls'],
    ['#14 以 && 结尾的残缺命令', 'ls && '],
    ['#14 空命令', '   '],
    ['重定向缺目标', 'echo hi >'],
  ])('拒绝 %s', (_name, command) => {
    expect(splitCommand(command)).toBeUndefined();
  });

  it('拒绝时返回 undefined 而不是抛错（调用方靠它退回整串匹配）', () => {
    expect(() => splitCommand('echo $(x)')).not.toThrow();
  });
});
